
-- Partner API v1, Phase 3 Stage 1 (spec D13, deliverable 3.2): the durable
-- pre-provider-call dispatch record.
--
-- One row per attempted provider dispatch, keyed naturally by
-- (key_id, idempotency_key). The state machine (decision record
-- docs/decisions/2026-09-01-d13-dispatch-state-machine.md) is:
--
--   intended  -> sent | failed | indeterminate | reconciled_sent   (handler / takeover / webhook)
--   sent      -> reconciled_sent                                  (webhook)
--   indeterminate -> reconciled_sent                              (webhook, positive signal only)
--   failed, reconciled_sent                                       (terminal)
--
-- The five invariants D13 exists to enforce are made STRUCTURAL here:
--   * the UNIQUE (key_id, idempotency_key) constraint means a second
--     dispatch attempt for the same idempotency key cannot even be
--     REPRESENTED as a fresh row -- at-most-once is a shape, not a habit;
--   * the transition trigger refuses every path from `indeterminate` (or any
--     other state) back toward `intended`/re-dispatch, so "safe to resend"
--     cannot be introduced by a future UPDATE someone thinks is harmless;
--   * rows are born `intended` only -- no INSERT can create a settled state.
--
-- LIFETIME (why key_id has NO foreign key): a dispatch intent is evidence
-- that a real message may have reached a customer, and must outlive key
-- rotation or key deletion. partner_api_idempotency.key_id is ON DELETE
-- CASCADE -- exactly wrong for evidence. This mirrors
-- partner_audit_logs (20260830120100): no FK on key_id, tenancy asserted at
-- write time by a FOR KEY SHARE trigger, and the existing
-- partner_api_keys_workspace_is_immutable trigger (added by that same
-- migration on the PARENT table) already refuses moving a key between
-- workspaces, which keeps already-written intent rows correctly attributed.

CREATE TABLE public.partner_dispatch_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, like partner_audit_logs and partner_api_usage: workspace
  -- deletion is an explicit, tenant-wide destructive act. This is the only
  -- cascade on this table; see the RESTRICT on the account FK below.
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- NOT NULL and deliberately WITHOUT a foreign key -- see the header and the
  -- tenancy trigger below, which is the compensating control (spec 9.1).
  key_id            UUID NOT NULL,
  -- Composite FK (account tenancy), as in 20260830120000: the account must
  -- belong to this row's workspace. A single-column FK on social_account_id
  -- would let one workspace's intent name another workspace's account.
  --
  -- RESTRICT, unlike the CASCADE on partner_api_key_accounts, because this
  -- table is evidence, not configuration. CASCADE here would let the routine
  -- "disconnect WhatsApp account" product operation erase the record that a
  -- message may have been delivered to a customer. RESTRICT deliberately
  -- matches partner_api_usage's precedent, and it adds no NEW product wedge:
  -- every dispatch intent implies a partner request, every partner request
  -- writes a usage row, and usage already RESTRICTs the same cascade.
  social_account_id UUID NOT NULL,
  -- The idempotency key this attempt belongs to. Plain data, NO FK: the
  -- idempotency row is pruned after 7 days and cascades on key deletion,
  -- and the intent must survive both (see header). The practical effect of
  -- the UNIQUE constraint below is that the intent outlives the idempotency
  -- window: reusing a key years later replays its recorded outcome instead
  -- of dispatching again.
  idempotency_key   TEXT NOT NULL,
  -- Defaults to 'intended': rows are born intended, and the transition
  -- trigger refuses any INSERT claiming a settled state. Both the default
  -- and the trigger say the same thing on purpose -- one is convenience,
  -- the other is the enforcement.
  state             TEXT NOT NULL DEFAULT 'intended',
  wamid             TEXT,
  -- The outcome a later takeover replays for sent/failed rows (the same
  -- normalized body completeIdempotency stores). NULL while unresolved.
  http_status       INTEGER,
  response_body     JSONB,
  -- Enough of the request to identify it to an operator: recipient phone,
  -- template name and language. Template components are deliberately NOT
  -- stored: they carry customer message content, and an operator does not
  -- need the body to decide whether a message may have been delivered.
  request_summary   JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the row leaves `intended`. How long a row has sat unresolved is
  -- the operator escalation queue's sorting order (D13 R3).
  resolved_at       TIMESTAMPTZ,
  -- THE natural key, and the at-most-once guarantee made structural: one
  -- dispatch intent per (key, idempotency key), ever. A takeover finds this
  -- constraint and stops; it cannot insert its own row. Also serves lookups
  -- by key_id (leftmost column).
  UNIQUE (key_id, idempotency_key),
  CONSTRAINT partner_dispatch_intents_account_in_workspace
    FOREIGN KEY (social_account_id, workspace_id)
    REFERENCES public.social_accounts (id, workspace_id) ON DELETE RESTRICT,
  -- The five states of D13, and no others. Adding a state is a schema change
  -- that must be reviewed against the transition trigger below.
  CONSTRAINT partner_dispatch_intents_state_is_known
    CHECK (state IN ('intended','sent','failed','indeterminate','reconciled_sent')),
  -- A row that claims the provider accepted (or a webhook proved acceptance)
  -- must name the message; a settled verdict must carry its replayable
  -- outcome. reconciled_sent is exempt from the outcome half: the webhook
  -- proves the send but brings no partner response body.
  CONSTRAINT partner_dispatch_intents_sent_names_wamid
    CHECK (state NOT IN ('sent','reconciled_sent') OR wamid IS NOT NULL),
  CONSTRAINT partner_dispatch_intents_settled_names_outcome
    CHECK (state NOT IN ('sent','failed') OR (http_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE INDEX partner_dispatch_intents_account_idx
  ON public.partner_dispatch_intents (social_account_id);
CREATE INDEX partner_dispatch_intents_ws_time_idx
  ON public.partner_dispatch_intents (workspace_id, created_at DESC);
-- The D13 R3 escalation queue: every unresolved row, oldest first.
CREATE INDEX partner_dispatch_intents_unresolved_idx
  ON public.partner_dispatch_intents (created_at)
  WHERE state IN ('intended','indeterminate');

-- ---------------------------------------------------------------------------
-- Tenancy compensating control (spec 9.1), copied from partner_audit_logs.
-- A foreign key on key_id is deliberately impossible here (see header); this
-- trigger refuses a row whose key does not belong to the stated workspace,
-- taking FOR KEY SHARE so a concurrent workspace move cannot slip between
-- the check and the insert. (The "moved a week later" half is already
-- covered for every referencing table by the existing
-- partner_api_keys_workspace_is_immutable trigger on partner_api_keys.)
--
-- SECURITY DEFINER with a pinned search_path, locked down like the audit
-- original. Unlike the audit table, service_role INSERTs directly into this
-- table (the edge-function dispatch path), so EXECUTE is granted to
-- service_role below -- without it the least-privilege table grants would
-- make every production insert fail inside the trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_dispatch_intents_assert_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT TRUE INTO v_found
    FROM public.partner_api_keys k
   WHERE k.id = NEW.key_id
     AND k.workspace_id = NEW.workspace_id
   FOR KEY SHARE;

  IF v_found IS NULL THEN
    -- Constraint name repeated in the message: SQLERRM carries only the
    -- message, so tests proving THIS check fired have nothing else to match.
    RAISE EXCEPTION
      'partner_dispatch_intents_assert_tenancy: key % does not belong to workspace % (cross-workspace dispatch intent refused)',
      NEW.key_id, NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'partner_dispatch_intents_assert_tenancy';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_dispatch_intents_assert_tenancy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_dispatch_intents_assert_tenancy() TO service_role;

CREATE TRIGGER partner_dispatch_intents_assert_tenancy_trg
BEFORE INSERT ON public.partner_dispatch_intents
FOR EACH ROW EXECUTE FUNCTION public.partner_dispatch_intents_assert_tenancy();

-- ---------------------------------------------------------------------------
-- The state machine, enforced. D13 invariant 4: "no transition leads from
-- indeterminate toward re-dispatch. There is no state meaning safe to
-- resend". The transition table below IS that sentence, as a constraint:
-- nothing can UPDATE a row back to `intended`, and neither `failed` nor
-- `reconciled_sent` can go anywhere at all. A future edit that tries to add
-- a "retryable after reconciliation" path fails HERE, in the database,
-- rather than in review.
--
-- NOT SECURITY DEFINER: it reads only NEW/OLD and needs no authority beyond
-- the invoking role. Runs for the webhook's service_role updates and the
-- dispatch path's alike.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_dispatch_intents_assert_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Rows are born `intended`. An INSERT claiming a settled state would skip
  -- the entire machine -- a "sent" row nobody dispatched -- so it is refused.
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'intended' THEN
      RAISE EXCEPTION
        'partner_dispatch_intents_assert_transition: a dispatch intent must be created as intended, not %',
        NEW.state
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'partner_dispatch_intents_assert_transition';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'intended'   AND NEW.state IN ('sent','failed','indeterminate','reconciled_sent')) OR
      (OLD.state = 'sent'       AND NEW.state = 'reconciled_sent') OR
      (OLD.state = 'indeterminate' AND NEW.state = 'reconciled_sent')
    ) THEN
      RAISE EXCEPTION
        'partner_dispatch_intents_assert_transition: illegal transition % -> %; no path leads from % toward re-dispatch (D13 invariant 4)',
        OLD.state, NEW.state, OLD.state
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'partner_dispatch_intents_assert_transition';
    END IF;
  END IF;

  -- The wamid is the provider's receipt. Once recorded it is immutable: a
  -- row that had one and now names another is two different messages
  -- pretending to be one dispatch.
  IF OLD.wamid IS NOT NULL AND NEW.wamid IS DISTINCT FROM OLD.wamid THEN
    RAISE EXCEPTION
      'partner_dispatch_intents_assert_transition: wamid is immutable once set'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'partner_dispatch_intents_assert_transition';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_dispatch_intents_assert_transition() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_dispatch_intents_assert_transition() TO service_role;

CREATE TRIGGER partner_dispatch_intents_assert_transition_trg
BEFORE INSERT OR UPDATE ON public.partner_dispatch_intents
FOR EACH ROW EXECUTE FUNCTION public.partner_dispatch_intents_assert_transition();

CREATE TRIGGER update_partner_dispatch_intents_updated_at
BEFORE UPDATE ON public.partner_dispatch_intents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.partner_dispatch_intents ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants (matching 20260830120300's least-privilege surface; anon gets
-- nothing). Service-role only, no policies: this table is written by the
-- partner dispatch path and the WhatsApp webhook, both service-role.
--
-- UPDATE is COLUMN-LEVEL on purpose. The state machine must be able to move
-- a row forward, but no role may re-attribute an intent to another key,
-- workspace, account or idempotency key after the fact -- the INSERT-time
-- tenancy trigger cannot guard an UPDATE. Column-level grants make the
-- identity columns unwritable by any role that authenticates, without a
-- second trigger. No role receives DELETE or TRUNCATE: evidence.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.partner_dispatch_intents FROM PUBLIC;
REVOKE ALL ON public.partner_dispatch_intents FROM anon;
REVOKE ALL ON public.partner_dispatch_intents FROM authenticated;
REVOKE ALL ON public.partner_dispatch_intents FROM service_role;
GRANT SELECT, INSERT ON public.partner_dispatch_intents TO service_role;
GRANT UPDATE (state, wamid, http_status, response_body, resolved_at, updated_at)
  ON public.partner_dispatch_intents TO service_role;
