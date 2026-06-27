-- ═══════════════════════════════════════════════════════════════════
-- P3-4: Admin Audit Log — RLS Policy
-- ═══════════════════════════════════════════════════════════════════
-- The table public.admin_audit_log already exists with columns:
--   id (uuid PK), admin_id (uuid NOT NULL), action (text NOT NULL),
--   resource_type (text NOT NULL), resource_id (text),
--   details (jsonb), ip_address (text), user_agent (text),
--   created_at (timestamptz NOT NULL DEFAULT now())
-- RLS is already enabled. Indexes already exist.
--
-- This migration adds the admin-only read policy.
-- Written from edge functions via the service-role key (bypasses RLS).
-- Readable only by admin-role users.
--
-- Rollback:
--   DROP POLICY IF EXISTS admin_audit_log_admin_read ON public.admin_audit_log;
-- ═══════════════════════════════════════════════════════════════════

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
