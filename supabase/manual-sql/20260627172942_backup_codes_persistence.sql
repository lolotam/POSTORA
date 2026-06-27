-- Postora backup-code persistence hardening (manual execution only).
--
-- Purpose:
--   1. Keep public.backup_codes behind RLS.
--   2. Prevent anon/authenticated clients from reading code_hash or writing rows.
--   3. Preserve privileged CRUD for the service-role Edge Function.
--
-- This file is intentionally not a migration and must not be executed by Codex.

BEGIN;

ALTER TABLE public.backup_codes ENABLE ROW LEVEL SECURITY;

-- Remove every existing row policy, including legacy owner policies. Client
-- access is denied by both missing policies and revoked table privileges.
DO $$
DECLARE
  existing_policy RECORD;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'backup_codes'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.backup_codes',
      existing_policy.policyname
    );
  END LOOP;
END
$$;

REVOKE ALL PRIVILEGES ON TABLE public.backup_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.backup_codes TO service_role;

COMMIT;

-- Rollback notes:
-- Restoring direct authenticated access would expose code_hash and allow
-- clients to bypass server-side hashing/consumption. If rollback is required,
-- restore the exact prior grants and policies from a reviewed schema snapshot;
-- do not broadly re-grant client access. Keeping these restrictions in place
-- is safe even if the manage-backup-codes Edge Function is rolled back.
