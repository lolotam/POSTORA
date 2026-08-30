
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
  -- Nullable: rows may describe workspace-level events with no specific key.
  -- A NULL key_id is not FK-checked (MATCH SIMPLE), so those rows are pinned
  -- to their workspace only by workspace_id; whenever key_id IS set, the
  -- composite FK below makes misattribution unrepresentable.
  key_id       UUID,
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
  -- RESTRICT, not CASCADE, matching partner_api_usage: audit rows are
  -- history and must outlive key churn. Keys are meant to be REVOKED, not
  -- deleted -- revocation is itself an event this table exists to record --
  -- so a hard delete of an audited key is refused rather than silently
  -- rewriting the trail. A key with no audit history and no usage history
  -- can still be deleted; those rows cascade nothing.
  CONSTRAINT partner_audit_logs_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE RESTRICT
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
REVOKE ALL ON public.partner_audit_logs FROM PUBLIC;
REVOKE ALL ON public.partner_audit_logs FROM anon;
REVOKE ALL ON public.partner_audit_logs FROM authenticated;
REVOKE ALL ON public.partner_audit_logs FROM service_role;
GRANT SELECT ON public.partner_audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.partner_audit_logs TO service_role;
