-- ═══════════════════════════════════════════════════════════════════
-- P3-4: Admin Audit Log Table
-- ═══════════════════════════════════════════════════════════════════
-- Purpose: Track security-relevant admin actions for compliance and
-- incident investigation. Written from edge functions via the service-
-- role key (bypasses RLS). Readable only by admin-role users.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.admin_audit_log;
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    action      TEXT        NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    ip_address  INET,
    user_agent  TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for chronological queries by actor
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor
    ON public.admin_audit_log (actor_id, created_at DESC);

-- Index for filtering by action type
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
    ON public.admin_audit_log (action, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Only admins can read audit entries
CREATE POLICY "admin_audit_log_admin_read"
    ON public.admin_audit_log FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role = 'admin'
        )
    );

-- No INSERT policy for authenticated users — all inserts go through
-- the service-role key from edge functions, which bypasses RLS.
