
-- Partner API v1, Phase 1 (spec D12, section 8): append-only
-- credential-lifecycle audit trail. Records who did what to which key, when.
-- Appends happen from service-role lifecycle paths; workspace admins may
-- read their own workspace's trail.

CREATE TABLE public.partner_audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE, like every workspace FK in the partner tables: workspace
  -- deletion is an explicit, tenant-wide destructive act, and the trail of a
  -- workspace that no longer exists goes with it (same semantics as
  -- partner_api_usage). It is the only path by which audit rows disappear.
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- NOT NULL is load-bearing, not a completeness preference. A composite FK
  -- is MATCH SIMPLE: when any referencing column is NULL the constraint is
  -- not checked at all. A nullable key_id would therefore let this row be
  -- written against ANY workspace while naming another workspace's key in
  -- metadata -- defeating the exact invariant this table's FK exists to
  -- create (spec section 9.1). Every action below is a key-lifecycle event,
  -- so a targetless row has no meaning anyway. If workspace-level events are
  -- ever needed, model them with an explicit target type and a conditional
  -- constraint; do not weaken this column.
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
  -- Same tenancy control as partner_api_usage: an audit row cannot name a
  -- key from another workspace, so it can never be attributed to a
  -- workspace other than its target's (spec section 9.1).
  --
  -- CASCADE, and deliberately NOT the RESTRICT that partner_api_usage uses.
  -- RESTRICT was tried first and breaks an ordinary user action: the
  -- foundation migration cascades a social_accounts delete into
  -- partner_api_keys (20260813120000, the partner_api_keys_account_in_workspace
  -- constraint), so a RESTRICT here makes disconnecting a WhatsApp account
  -- fail for every key that has ever been audited -- which, once the
  -- lifecycle writes a 'create' row, is every key. Verified against a clone
  -- of the production schema. Mixed cascade/restrict graphs also make
  -- workspace deletion order-dependent and unreliable.
  --
  -- The cost is stated plainly: audit history is bound to the existence of
  -- its key, so a hard-deleted key takes its trail with it. Keeping history
  -- past that point is a lifecycle policy -- keys must be REVOKED, never
  -- deleted -- and belongs to the credential-lifecycle work, not to a
  -- foreign-key action that silently breaks account disconnection.
  CONSTRAINT partner_audit_logs_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE CASCADE
);

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
