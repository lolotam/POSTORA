
-- Partner API v1, Phase 1 (spec D12, section 8): append-only
-- credential-lifecycle audit trail. Records who did what to which key, when.
-- Appends happen from service-role lifecycle paths; workspace admins may
-- read their own workspace's trail.

CREATE TABLE public.partner_audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, like every workspace FK in the partner tables: workspace
  -- deletion is an explicit, tenant-wide destructive act, and the trail of a
  -- workspace that no longer exists goes with it (same semantics as
  -- partner_api_usage). With key_id carrying no FK (see below), this is now
  -- the ONLY path by which an audit row disappears -- deleting or
  -- disconnecting the key or its social account no longer touches the trail.
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- NOT NULL is load-bearing, not a completeness preference. The tenancy
  -- trigger below is only meaningful if it always has a key to check; a
  -- nullable key_id would let a row be written against ANY workspace while
  -- naming another workspace's key in metadata, which is the escape the
  -- earlier composite-FK design had via MATCH SIMPLE and which cost this
  -- table a review round. Every action is a key-lifecycle event, so a
  -- targetless row has no meaning anyway. If workspace-level events are ever
  -- needed, model them with an explicit target type; do not weaken this.
  key_id       UUID NOT NULL,
  actor_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The credential lifecycle D12 requires today: creation, rotation,
  -- revocation, and broadening a key's scope/account grant. Widening this
  -- set is a deliberate future migration, never an application decision.
  action       TEXT NOT NULL
    CHECK (action IN ('create', 'rotate', 'revoke', 'grant_broaden')),
  request_id   TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- DELIBERATELY NO FOREIGN KEY ON key_id. Spec section 9.1 requires a
  -- composite FK on every partner table and requires that, where one is
  -- genuinely impossible, the reason and the compensating control are stated
  -- explicitly rather than passed over in silence. This is that case, and
  -- both alternatives were built and tested against a clone of the
  -- production schema before this one was chosen:
  --
  --   ON DELETE RESTRICT  breaks an ordinary user action. The foundation
  --     migration cascades a social_accounts delete into partner_api_keys
  --     (partner_api_keys_account_in_workspace), and the app really does
  --     hard-delete accounts (src/hooks/useSocialProfiles.tsx,
  --     useDisconnectAccountFromProfile). RESTRICT here makes disconnecting a
  --     WhatsApp account fail for every key that has ever been audited --
  --     which, once the lifecycle writes its 'create' row, is every key.
  --
  --   ON DELETE CASCADE   destroys the trail on that same ordinary
  --     disconnect. An audit log that is deleted by the routine operation of
  --     the product is not an audit log. It also only half-fixes the wedge:
  --     partner_api_usage still RESTRICTs, so a key with any usage keeps
  --     blocking the disconnect anyway.
  --
  -- An append-only trail must not be hostage to the lifetime of the row it
  -- describes. So key_id is durable data, not a reference, and tenancy is
  -- asserted at write time by the trigger below.
  --
  -- COMPENSATING CONTROL (spec 9.1), and it takes TWO triggers, not one,
  -- because a foreign key does two jobs and a single INSERT check only does
  -- the first:
  --
  --   partner_audit_logs_assert_tenancy (BEFORE INSERT here) refuses a row
  --     whose key does not belong to the stated workspace, taking FOR KEY
  --     SHARE on the key so a concurrent workspace move cannot slip between
  --     the check and the insert.
  --   partner_api_keys_workspace_is_immutable (BEFORE UPDATE on the parent)
  --     refuses to move a key between workspaces at all, which is what keeps
  --     already-written rows correct afterwards.
  --
  -- Stated precisely, because an earlier draft of this comment overclaimed:
  -- this is NOT identical to a composite FK. It is equivalent for writes and
  -- for parent updates, and deliberately different for deletes -- that
  -- difference is the entire reason the FK could not be used. It is also
  -- weaker in one respect worth naming: the table owner can disable a user
  -- trigger more easily than Postgres's internal FK triggers, and
  -- session_replication_role = 'replica' skips it. Both require privileges
  -- (owner, superuser) that are already a trusted administrative boundary
  -- here. Triggers do fire for service_role and inside COPY, which RLS does
  -- not.
  key_prefix   TEXT
);

-- The compensating control the comment on key_id names. This is what makes a
-- cross-workspace audit row unwritable now that key_id carries no FK.
--
-- SECURITY DEFINER with a pinned search_path, and locked down the way every
-- function in the foundation migration is: the check must run with authority
-- to see partner_api_keys regardless of the caller, and must not be
-- redirectable by a caller-controlled search_path.
CREATE OR REPLACE FUNCTION public.partner_audit_logs_assert_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  -- FOR KEY SHARE, not a bare EXISTS. A plain read leaves a race a foreign
  -- key does not have: one transaction checks that the key is in workspace A
  -- and inserts the audit row, while a concurrent transaction moves that key
  -- to workspace B; both commit, and the row is left attributed to a
  -- workspace its target no longer belongs to. A real FK coordinates with
  -- updates to the referenced row; this has to ask for that coordination
  -- explicitly.
  --
  -- KEY SHARE is the right strength: workspace_id is part of
  -- partner_api_keys_id_workspace_key, so it IS a key column, and KEY SHARE
  -- blocks exactly the updates that would change it while permitting ordinary
  -- non-key updates such as last_used_at -- which the send path touches on
  -- every request and must not be made to queue behind an audit write.
  SELECT TRUE INTO v_found
    FROM public.partner_api_keys k
   WHERE k.id = NEW.key_id
     AND k.workspace_id = NEW.workspace_id
     FOR KEY SHARE;

  IF v_found IS NULL THEN
    -- The constraint name is repeated in the message text on purpose:
    -- SQLERRM carries only the message, not the CONSTRAINT field, so a caller
    -- or test that wants to prove the rejection came from THIS check rather
    -- than some unrelated failure has nothing else to match on.
    RAISE EXCEPTION
      'partner_audit_logs_assert_tenancy: key % does not belong to workspace % (cross-workspace audit attribution refused)',
      NEW.key_id, NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'partner_audit_logs_assert_tenancy';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.partner_audit_logs_assert_tenancy() FROM PUBLIC, anon;

-- BEFORE INSERT only. There is deliberately no UPDATE trigger: no role holds
-- UPDATE on this table, so an update trigger would be dead code guarding a
-- privilege nobody has.
CREATE TRIGGER partner_audit_logs_assert_tenancy_trg
BEFORE INSERT ON public.partner_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.partner_audit_logs_assert_tenancy();

-- The other half of the control. Locking the key at insert time stops an audit
-- row being written against a workspace the key is concurrently leaving, but
-- it says nothing about a move that happens LATER: without this, a key could
-- be reassigned to another workspace a week after the fact and silently
-- orphan every audit row already attributed to the old one. A composite FK
-- would have refused that update; nothing else here does.
--
-- A partner key belongs to the workspace it was minted for, permanently.
-- There is no product operation that moves one, and D12's answer to a key in
-- the wrong place is to revoke it and mint another -- which leaves both
-- events in this table, exactly as an audit trail should.
CREATE OR REPLACE FUNCTION public.partner_api_keys_workspace_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION
      'partner_api_keys_workspace_is_immutable: a partner key cannot change workspace (% -> %); revoke it and mint a new one',
      OLD.workspace_id, NEW.workspace_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER partner_api_keys_workspace_is_immutable_trg
BEFORE UPDATE OF workspace_id ON public.partner_api_keys
FOR EACH ROW EXECUTE FUNCTION public.partner_api_keys_workspace_is_immutable();

CREATE INDEX partner_audit_logs_ws_time_idx
  ON public.partner_audit_logs (workspace_id, created_at DESC);
CREATE INDEX partner_audit_logs_key_time_idx
  ON public.partner_audit_logs (key_id, created_at DESC);

ALTER TABLE public.partner_audit_logs ENABLE ROW LEVEL SECURITY;

-- Mirrors "Workspace admins read partner keys" from the foundation
-- migration: owner/admin members may read their workspace's trail. There is
-- deliberately no INSERT policy for authenticated -- appends are
-- service-role only, so a browser session can never forge an audit event.
CREATE POLICY "Workspace admins read partner audit logs"
ON public.partner_audit_logs FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id = partner_audit_logs.workspace_id
     AND m.user_id = auth.uid()
     AND m.role IN ('owner','admin')
));

-- APPEND-ONLY IS ENFORCED HERE AT THE GRANT LEVEL, NOT IN COMMENTS.
-- Supabase's default privileges would hand UPDATE and DELETE to
-- anon/authenticated/service_role on table creation, so every grant is
-- revoked explicitly and then only SELECT/INSERT are re-granted. No role
-- receives UPDATE or DELETE on this table; the only actor that retains them
-- is the table owner (the migration role), which no application authenticates
-- as -- the compensating control is that owner-role credentials are never
-- issued to services, a property of the deployment, not of this file.
--
-- SCOPE OF THE CLAIM, stated precisely so nobody relies on more than it gives:
-- "append-only" here means NO ROLE CAN ISSUE UPDATE OR DELETE DML. It does
-- NOT mean rows are retained forever. Referential actions run outside RLS and
-- outside these grants, so a workspace owner deleting their workspace -- an
-- action authenticated users are granted -- cascades this table's rows away
-- without ever holding DELETE on it. Retention across tenant deletion is a
-- product and compliance decision (soft deletion, or an archive-then-purge
-- workflow), not something a grant can express.
REVOKE ALL ON public.partner_audit_logs FROM PUBLIC;
REVOKE ALL ON public.partner_audit_logs FROM anon;
REVOKE ALL ON public.partner_audit_logs FROM authenticated;
REVOKE ALL ON public.partner_audit_logs FROM service_role;
GRANT SELECT ON public.partner_audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.partner_audit_logs TO service_role;
