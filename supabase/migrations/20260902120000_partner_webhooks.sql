-- Partner API v1, Phase 5: the webhook substrate (deliverables 5.1, 5.2, 5.3, 5.4, 5.9).
--
-- Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
-- Additive only: two new tables, four functions, no change to anything existing.
--
-- D5 requires the outbox to exist BEFORE any webhook endpoint is exposed, because
-- the failure mode is not "an event is late" but "an event is lost and neither
-- side can tell". ARCHITECTURE.md §27 independently forbids treating an Edge
-- Function as a durable queue.

-- ---------------------------------------------------------------------------
-- 1. partner_webhooks -- the subscription (5.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_webhooks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Which credential created it. Composite FK for the D4 reason: two
  -- independent single-column FKs are each satisfiable while the PAIR is
  -- nonsense -- workspace A's subscription attributed to workspace B's key.
  created_by_key_id UUID NOT NULL,

  url               TEXT NOT NULL CHECK (url ~ '^https://'),

  -- The CLOSED allowlist is the mechanism that stops this phase becoming an
  -- implicit promise. D6 ships an event only once its transactional producer is
  -- certified, and this phase certifies exactly one: webhook.test, which is
  -- certifiable precisely because it has no external producer. A partner cannot
  -- subscribe to message.received before Phase 6 certifies it, so nobody can
  -- build against an event that would never fire.
  --
  -- Phase 6 and Phase 8 widen this list one certified event at a time.
  events            TEXT[] NOT NULL
    CHECK (cardinality(events) > 0 AND events <@ ARRAY['webhook.test']),

  -- NULL means "every platform" / "every account this key is bound to". A
  -- filter is a narrowing, never a widening: it can only remove subscriptions
  -- from a match, so an unset filter is the safe default rather than a hole.
  platform          TEXT CHECK (platform IN ('whatsapp')),
  social_account_id UUID,

  -- Postora is the SIGNER here, not the verifier, so unlike
  -- partner_api_keys.key_hash this cannot be a hash -- an HMAC secret has to be
  -- recoverable to sign with. It is shown once at creation, once at rotation,
  -- and never returned by a read.
  secret            TEXT NOT NULL,
  secret_version    INTEGER NOT NULL DEFAULT 1 CHECK (secret_version >= 1),

  -- The bounded overlap during which the previous secret still verifies. All
  -- three move together or none do: a previous secret with no expiry never
  -- ages out, and an expiry with no secret verifies nothing.
  previous_secret            TEXT,
  previous_secret_version    INTEGER,
  previous_secret_expires_at TIMESTAMPTZ,
  CONSTRAINT partner_webhooks_previous_secret_complete CHECK (
    num_nonnulls(previous_secret, previous_secret_version, previous_secret_expires_at) IN (0, 3)
  ),

  -- Health (5.1). Auto-disable happens only when a delivery exhausts the whole
  -- ladder -- see settle_partner_webhook_delivery.
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  disabled_at          TIMESTAMPTZ,
  disabled_reason      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at      TIMESTAMPTZ,
  last_failure_at      TIMESTAMPTZ,
  last_error           TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pair a child row references, so a delivery cannot inherit the wrong
-- workspace from a real webhook id.
CREATE UNIQUE INDEX IF NOT EXISTS partner_webhooks_id_workspace_key
  ON public.partner_webhooks (id, workspace_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhooks_key_in_workspace') THEN
    ALTER TABLE public.partner_webhooks
      ADD CONSTRAINT partner_webhooks_key_in_workspace
      FOREIGN KEY (created_by_key_id, workspace_id)
      REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhooks_account_in_workspace') THEN
    ALTER TABLE public.partner_webhooks
      ADD CONSTRAINT partner_webhooks_account_in_workspace
      FOREIGN KEY (social_account_id, workspace_id)
      REFERENCES public.social_accounts (id, workspace_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS partner_webhooks_workspace_created_idx
  ON public.partner_webhooks (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. partner_webhook_deliveries -- the outbox (5.2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   UUID NOT NULL,
  workspace_id UUID NOT NULL,

  event_type   TEXT NOT NULL,

  -- The dedup anchor, and the one term the whole phase turns on. An OCCURRENCE
  -- is a TRANSITION -- not a resource and not a delivery. The spec called this
  -- source_event_id before the exit criteria redefined what it holds; the
  -- rename is deliberate and its audit trail is section 0 of the design record.
  --
  -- Keyed on the resource instead, message.delivered and message.read for one
  -- message share a provider id and the second silently collides with the
  -- first -- the outbox would drop exactly the events it exists to guarantee.
  -- So the event type is part of the value the producer supplies.
  event_occurrence_id TEXT NOT NULL,

  payload      JSONB NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Captured at ENQUEUE, never read at send time. A rotation between an event's
  -- enqueue and its 6h retry would otherwise change the signature of an event
  -- whose id is immutable, and the receiver could not tell replay from
  -- rotation.
  secret_version INTEGER NOT NULL,

  -- Four states, deliberately. A failed attempt returns to 'pending' with
  -- next_attempt_at set -- a separate 'failed' state would be a synonym for
  -- "pending, with a last_error", and two names for one state is how a claim
  -- predicate ends up missing half the queue.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'exhausted')),

  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- SKIP LOCKED does not reserve a row past the commit: a predicate alone
  -- re-admits a just-claimed row and two cron ticks run it side by side. The
  -- lease is the actual exclusion.
  lease_expires_at TIMESTAMPTZ,

  last_status_code INTEGER,
  last_error       TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The invariant, stated once: exactly one row per (subscription, occurrence).
  -- One event matching three subscriptions is three rows -- deduplication is
  -- per subscription because delivery is.
  CONSTRAINT partner_webhook_deliveries_occurrence_key
    UNIQUE (webhook_id, event_occurrence_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhook_deliveries_webhook_in_workspace'
  ) THEN
    ALTER TABLE public.partner_webhook_deliveries
      ADD CONSTRAINT partner_webhook_deliveries_webhook_in_workspace
      FOREIGN KEY (webhook_id, workspace_id)
      REFERENCES public.partner_webhooks (id, workspace_id) ON DELETE CASCADE;
  END IF;
END $$;

-- The claim predicate's index. Partial, because 'delivered' rows are the ones
-- that accumulate and the worker never looks at them again.
CREATE INDEX IF NOT EXISTS partner_webhook_deliveries_claimable_idx
  ON public.partner_webhook_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS partner_webhook_deliveries_webhook_created_idx
  ON public.partner_webhook_deliveries (webhook_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. The claim (5.3)
-- ---------------------------------------------------------------------------
--
-- FOR UPDATE SKIP LOCKED *plus a lease*, explicitly not the select-then-loop in
-- whatsapp-scheduled-sender/index.ts:26-32, which has no atomic claim and
-- double-delivers under concurrency. D5 names that function by line number for
-- exactly this reason.
CREATE OR REPLACE FUNCTION public.claim_partner_webhook_deliveries(
  p_limit         INTEGER,
  p_lease_seconds INTEGER,
  p_max_attempts  INTEGER
)
RETURNS SETOF public.partner_webhook_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit <= 0 OR p_lease_seconds <= 0 OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'claim_partner_webhook_deliveries requires positive parameters';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT d.id
      FROM public.partner_webhook_deliveries d
      JOIN public.partner_webhooks w ON w.id = d.webhook_id
     WHERE d.status IN ('pending', 'delivering')
       AND d.next_attempt_at <= now()
       AND d.attempts < p_max_attempts
       AND (d.lease_expires_at IS NULL OR d.lease_expires_at < now())
       -- A disabled endpoint is not retried. Re-enabling it (or a redrive) is
       -- what puts its backlog back in play.
       AND w.is_active
     ORDER BY d.next_attempt_at, d.created_at
     LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE public.partner_webhook_deliveries d
     SET status           = 'delivering',
         attempts         = d.attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    FROM claimed
   WHERE d.id = claimed.id
  RETURNING d.*;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The settle (5.3)
-- ---------------------------------------------------------------------------
--
-- The backoff ladder itself lives in TypeScript (_shared/partnerWebhookDelivery.ts)
-- and is passed in as seconds, so there is one ladder with one set of tests
-- rather than a copy here that can drift from it.
CREATE OR REPLACE FUNCTION public.settle_partner_webhook_delivery(
  p_id              UUID,
  p_ok              BOOLEAN,
  p_status_code     INTEGER,
  p_error           TEXT,
  p_backoff_seconds INTEGER,
  p_max_attempts    INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    public.partner_webhook_deliveries;
  v_status TEXT;
BEGIN
  SELECT * INTO v_row FROM public.partner_webhook_deliveries WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settle_partner_webhook_delivery: no delivery %', p_id;
  END IF;

  IF p_ok THEN
    UPDATE public.partner_webhook_deliveries
       SET status = 'delivered', delivered_at = now(), lease_expires_at = NULL,
           last_status_code = p_status_code, last_error = NULL
     WHERE id = p_id;

    UPDATE public.partner_webhooks
       SET consecutive_failures = 0, last_success_at = now(), last_error = NULL,
           updated_at = now()
     WHERE id = v_row.webhook_id;

    RETURN 'delivered';
  END IF;

  -- Exhaustion is decided on the attempt just charged, not on a re-read: the
  -- claim incremented attempts, so v_row.attempts is how many have now been
  -- spent.
  v_status := CASE WHEN v_row.attempts >= p_max_attempts THEN 'exhausted' ELSE 'pending' END;

  UPDATE public.partner_webhook_deliveries
     SET status           = v_status,
         lease_expires_at = NULL,
         next_attempt_at  = CASE
                              WHEN v_status = 'pending'
                              THEN now() + make_interval(secs => GREATEST(p_backoff_seconds, 1))
                              ELSE next_attempt_at
                            END,
         last_status_code = p_status_code,
         last_error       = left(coalesce(p_error, ''), 500)
   WHERE id = p_id;

  UPDATE public.partner_webhooks
     SET consecutive_failures = consecutive_failures + 1,
         last_failure_at      = now(),
         last_error           = left(coalesce(p_error, ''), 500),
         -- D5: auto-disable ONLY after the ladder is exhausted. Disabling on a
         -- run of failures instead would take an endpoint down for a deploy
         -- window it would have recovered from on its own.
         is_active       = CASE WHEN v_status = 'exhausted' THEN FALSE ELSE is_active END,
         disabled_at     = CASE WHEN v_status = 'exhausted' THEN now() ELSE disabled_at END,
         disabled_reason = CASE
                             WHEN v_status = 'exhausted'
                             THEN 'retry ladder exhausted'
                             ELSE disabled_reason
                           END,
         updated_at = now()
   WHERE id = v_row.webhook_id;

  RETURN v_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Operations (5.4)
-- ---------------------------------------------------------------------------
--
-- A correct outbox accumulates undelivered rows in perfect silence. These two
-- functions are the difference between that being visible and it not being.
CREATE OR REPLACE FUNCTION public.partner_webhook_backlog()
RETURNS TABLE (
  pending_count            BIGINT,
  delivering_count         BIGINT,
  exhausted_count          BIGINT,
  stuck_lease_count        BIGINT,
  oldest_pending_age_secs  NUMERIC,
  disabled_webhook_count   BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE d.status = 'pending'),
    count(*) FILTER (WHERE d.status = 'delivering'),
    count(*) FILTER (WHERE d.status = 'exhausted'),
    count(*) FILTER (WHERE d.status = 'delivering' AND d.lease_expires_at < now()),
    coalesce(
      max(EXTRACT(EPOCH FROM (now() - d.created_at)))
        FILTER (WHERE d.status = 'pending' AND d.next_attempt_at <= now()),
      0
    ),
    (SELECT count(*) FROM public.partner_webhooks WHERE NOT is_active)
  FROM public.partner_webhook_deliveries d;
$$;

-- Redrive re-enables the endpoint as well as resetting its rows, because the
-- claim requires an active webhook: resetting rows alone would return an
-- encouraging count and deliver nothing.
CREATE OR REPLACE FUNCTION public.redrive_partner_webhook_deliveries(
  p_webhook_id UUID,
  p_limit      INTEGER DEFAULT 100
)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_limit <= 0 THEN
    RAISE EXCEPTION 'redrive_partner_webhook_deliveries requires a positive limit';
  END IF;

  UPDATE public.partner_webhooks
     SET is_active = TRUE, disabled_at = NULL, disabled_reason = NULL,
         consecutive_failures = 0, updated_at = now()
   WHERE id = p_webhook_id;

  RETURN QUERY
  WITH target AS (
    SELECT id FROM public.partner_webhook_deliveries
     -- Only exhausted rows. A pending row is already queued and a delivered one
     -- is done; "redriving" either would re-send something nobody lost.
     WHERE webhook_id = p_webhook_id AND status = 'exhausted'
     ORDER BY created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.partner_webhook_deliveries d
     SET status = 'pending', attempts = 0, next_attempt_at = now(),
         lease_expires_at = NULL
    FROM target
   WHERE d.id = target.id
  RETURNING d.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants -- the same convention as partner_api_key_accounts
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- RLS on, no policies: every access path is a service-role edge function or a
-- SECURITY DEFINER function, so the fail-closed default IS the contract. Grants
-- are stated rather than inherited so the tables do not depend on
-- environment-specific default privileges.
REVOKE ALL ON public.partner_webhooks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.partner_webhook_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_webhooks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_webhook_deliveries TO service_role;

REVOKE ALL ON FUNCTION public.claim_partner_webhook_deliveries(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_partner_webhook_delivery(UUID, BOOLEAN, INTEGER, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partner_webhook_backlog() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redrive_partner_webhook_deliveries(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_partner_webhook_deliveries(INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_partner_webhook_delivery(UUID, BOOLEAN, INTEGER, TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_webhook_backlog() TO service_role;
GRANT EXECUTE ON FUNCTION public.redrive_partner_webhook_deliveries(UUID, INTEGER) TO service_role;
