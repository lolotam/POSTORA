-- =============================================================================
-- Postora — Priority-1 Security Hardening (Phase 3, batch B)
-- Generated: 2026-06-27 UTC
-- Audit reference: docs/security/audit-2026-06.md
--
-- NOTE ON PATH
--   The requested path was supabase/migrations/20260627121905_p1_security_hardening.sql,
--   but the Lovable migrations directory is gated by an auto-applier that this
--   project explicitly bans for self-hosted Supabase. This file is therefore
--   placed under supabase/manual-sql/ which is the established convention here
--   (see supabase/manual-sql/20260627_brand_search_history.sql etc.) for SQL
--   that the owner must review and run by hand on the Contabo VPS Postgres.
--
-- WHAT THIS DOES
--   1. Idempotently enables Row Level Security and tightens default policies
--      on five sensitive tables: password_reset_otps, backup_codes,
--      user_roles, api_logs, app_settings.
--   2. Adds an index that backs the per-email OTP rate-limit query proposed
--      in audit finding A3 (paired with the OTP code changes in this batch).
--   3. Provides a *commented-out* template for refreshing pg_cron job HTTP
--      headers so that the three newly-protected cron functions
--      (observability-alerts, notify-expiring-ai-overrides,
--      send-token-expiry-notifications) send Authorization: Bearer
--      <CRON_SECRET>. The owner MUST edit the job names + secret reference
--      and run that template manually.
--
-- HOW TO APPLY
--   This file is NOT executed by Lovable. Review on the Contabo VPS and run
--   with psql against the self-hosted Postgres at api.postora.cloud:
--
--     psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f \
--       supabase/manual-sql/20260627121905_p1_security_hardening.sql
--
--   The statements are written to be idempotent (DROP POLICY IF EXISTS +
--   CREATE, CREATE INDEX IF NOT EXISTS) so re-running is safe.
--
-- ROLLBACK NOTES
--   - Sections 1.x: each policy is wrapped in DROP POLICY IF EXISTS + CREATE.
--     To roll back a single policy: DROP POLICY <name> ON <table>; the prior
--     policy must be restored from its original migration.
--   - To fully disable RLS on a table (NOT recommended):
--       ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;
--   - Section 2: DROP INDEX IF EXISTS idx_password_reset_otps_email_created_at;
--   - Section 3 is commented out; nothing to roll back unless you uncomment.
--
-- SECRETS
--   No secrets are embedded. CRON_SECRET is referenced by name only in the
--   pg_cron template comments.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Section 1.1 — password_reset_otps
-- -----------------------------------------------------------------------------
-- This table holds short-lived OTP hashes for MFA-gated password reset. It
-- must NEVER be readable by anon or authenticated roles directly — only the
-- service-role (used by send-reset-otp + verify-reset-otp edge functions)
-- should ever touch rows here. Disclosure of code_hash + expires_at would
-- allow offline brute-force of an OTP whose 6-digit space is small.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'password_reset_otps'
  ) THEN
    EXECUTE 'ALTER TABLE public.password_reset_otps ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.password_reset_otps FORCE ROW LEVEL SECURITY';
  END IF;
END$$;

DROP POLICY IF EXISTS "password_reset_otps_no_anon_access"          ON public.password_reset_otps;
DROP POLICY IF EXISTS "password_reset_otps_no_authenticated_access" ON public.password_reset_otps;

-- Deny every operation for anon + authenticated. Service-role bypasses RLS.
CREATE POLICY "password_reset_otps_no_anon_access"
  ON public.password_reset_otps
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_reset_otps_no_authenticated_access"
  ON public.password_reset_otps
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);


-- -----------------------------------------------------------------------------
-- Section 1.2 — backup_codes
-- -----------------------------------------------------------------------------
-- 2FA backup codes (SHA-256 hashed). The plaintext is shown once at creation
-- and never persisted. Even the owner must not read code_hash from the
-- client — they should only see metadata (id, used_at, created_at).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'backup_codes'
  ) THEN
    EXECUTE 'ALTER TABLE public.backup_codes ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;

DROP POLICY IF EXISTS "backup_codes_owner_select_metadata" ON public.backup_codes;
DROP POLICY IF EXISTS "backup_codes_no_anon"               ON public.backup_codes;
DROP POLICY IF EXISTS "backup_codes_no_client_writes"      ON public.backup_codes;

-- anon has no access at all.
CREATE POLICY "backup_codes_no_anon"
  ON public.backup_codes
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- Owner may SELECT their own rows (so the UI can show "5 of 10 used").
-- The client SELECT in the app should still project away code_hash; this
-- policy is a defense-in-depth deny for cross-user reads.
CREATE POLICY "backup_codes_owner_select_metadata"
  ON public.backup_codes
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- All writes (INSERT/UPDATE/DELETE) must go through the service-role inside
-- an edge function so we can hash + audit them. Block direct client writes.
CREATE POLICY "backup_codes_no_client_writes"
  ON public.backup_codes
  FOR INSERT
  TO authenticated
  WITH CHECK (false);


-- -----------------------------------------------------------------------------
-- Section 1.3 — user_roles
-- -----------------------------------------------------------------------------
-- Roles must NEVER be writable by clients (privilege escalation). Owners may
-- read their own roles. Admins may read any role via the has_role() helper.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_roles'
  ) THEN
    EXECUTE 'ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;

DROP POLICY IF EXISTS "user_roles_owner_select"     ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_admin_select"     ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_no_client_writes" ON public.user_roles;
DROP POLICY IF EXISTS "user_roles_no_anon"          ON public.user_roles;

CREATE POLICY "user_roles_no_anon"
  ON public.user_roles
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "user_roles_owner_select"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Optional admin read: only enable if the public.has_role(uid, role) helper
-- already exists in this database. The DO block guards against missing helper.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "user_roles_admin_select"
        ON public.user_roles
        FOR SELECT
        TO authenticated
        USING (public.has_role(auth.uid(), 'admin'::public.app_role))
    $POL$;
  END IF;
END$$;

-- Absolutely no client INSERT/UPDATE/DELETE.
CREATE POLICY "user_roles_no_client_writes"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (false);


-- -----------------------------------------------------------------------------
-- Section 1.4 — api_logs
-- -----------------------------------------------------------------------------
-- Per-user API access log (n8n + public API). Owner may read their own rows.
-- Writes are service-role only (the edge function inserts on each call).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'api_logs'
  ) THEN
    EXECUTE 'ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;

DROP POLICY IF EXISTS "api_logs_owner_select"     ON public.api_logs;
DROP POLICY IF EXISTS "api_logs_no_anon"          ON public.api_logs;
DROP POLICY IF EXISTS "api_logs_no_client_writes" ON public.api_logs;

CREATE POLICY "api_logs_no_anon"
  ON public.api_logs
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "api_logs_owner_select"
  ON public.api_logs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "api_logs_no_client_writes"
  ON public.api_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (false);


-- -----------------------------------------------------------------------------
-- Section 1.5 — app_settings
-- -----------------------------------------------------------------------------
-- Global config. Some keys are sensitive (feature flags, admin emails).
-- Only admins may read; only admins (via service-role in admin functions)
-- may write.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_settings'
  ) THEN
    EXECUTE 'ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY';
  END IF;
END$$;

DROP POLICY IF EXISTS "app_settings_admin_select"     ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_no_anon"          ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_no_client_writes" ON public.app_settings;

CREATE POLICY "app_settings_no_anon"
  ON public.app_settings
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'has_role'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "app_settings_admin_select"
        ON public.app_settings
        FOR SELECT
        TO authenticated
        USING (public.has_role(auth.uid(), 'admin'::public.app_role))
    $POL$;
  END IF;
END$$;

CREATE POLICY "app_settings_no_client_writes"
  ON public.app_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (false);


-- =============================================================================
-- Section 2 — Index for OTP per-email rate-limit (audit finding A3)
-- =============================================================================
-- The OTP flow (supabase/functions/send-reset-otp/index.ts +
-- verify-reset-otp/index.ts) lowercases the email BEFORE persisting and BEFORE
-- every query (`normalizedEmail = email.toLowerCase()`, then
-- `.eq("email", normalizedEmail)`). The stored value is therefore already
-- lower-cased, and a plain index on (email, created_at) matches the query
-- pattern directly — no `lower(email)` functional index is required.
--
-- If the table is large in production, the owner/Zed may prefer to run
-- the CREATE INDEX statement manually with CONCURRENTLY to avoid a write
-- lock on password_reset_otps:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     idx_password_reset_otps_email_created_at
--     ON public.password_reset_otps (email, created_at DESC);
--
-- CONCURRENTLY cannot run inside a transaction block, so it MUST be executed
-- outside the `-1` (single-transaction) wrapper. If you keep the in-transaction
-- CREATE below, expect a brief AccessExclusiveLock on a typically small,
-- short-lived table.

CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email_created_at
  ON public.password_reset_otps (email, created_at DESC);


-- =============================================================================
-- Section 3 — pg_cron header refresh (TEMPLATE — DO NOT RUN AS-IS)
-- =============================================================================
-- The three cron functions hardened in this batch
--   - observability-alerts
--   - notify-expiring-ai-overrides
--   - send-token-expiry-notifications
-- now require `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret`)
-- via the shared verifyCronAuth helper.
--
-- If pg_cron jobs already invoke them with the correct header (because the
-- existing jobs for process-scheduled-posts etc. use the same secret), no
-- change is needed. If they were created WITHOUT a header — for example via
-- a `SELECT net.http_post(...)` call that omitted Authorization — they will
-- now return 401.
--
-- To refresh a job's invocation, find the job_id with:
--
--   SELECT jobid, jobname, schedule, command
--   FROM cron.job
--   WHERE command LIKE '%observability-alerts%'
--      OR command LIKE '%notify-expiring-ai-overrides%'
--      OR command LIKE '%send-token-expiry-notifications%';
--
-- Then update each job's command. Example (REPLACE THE PLACEHOLDERS):
--
--   /*
--   SELECT cron.alter_job(
--     job_id   := <jobid>,
--     command  := $cmd$
--       SELECT net.http_post(
--         url     := 'https://api.postora.cloud/functions/v1/observability-alerts',
--         headers := jsonb_build_object(
--           'Content-Type',  'application/json',
--           'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
--         ),
--         body    := '{}'::jsonb
--       );
--     $cmd$
--   );
--   */
--
-- Storage of the secret:
--   We deliberately reference `current_setting('app.cron_secret', true)` so
--   the literal secret is never embedded in cron.job.command (which is
--   readable by superuser and visible in pg_stat_statements). Set it once
--   per server boot via ALTER SYSTEM, OR inline if your operational model
--   accepts that risk.
--
-- This entire section is commented out because:
--   (a) we cannot know the live job names/IDs from the repo, and
--   (b) running ALTER JOB with the wrong template would silently break crons.
-- The owner / Zed MUST review and adapt before executing.
-- =============================================================================
