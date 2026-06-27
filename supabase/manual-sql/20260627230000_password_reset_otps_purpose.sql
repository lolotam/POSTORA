-- Postora password OTP purpose column (manual execution only).
--
-- Purpose:
--   Distinguish "forgot password" OTPs from "logged-in change password" OTPs
--   inside the existing public.password_reset_otps table so that one purpose
--   cannot be redeemed for the other.
--
-- Backwards compatibility:
--   Default 'reset' keeps every existing row valid for the forgot-password flow.
--   New rows inserted by send-change-password-otp use 'change_password'.
--
-- This file is intentionally not a Supabase CLI migration. Run it manually on
-- the self-hosted Postgres after review.

BEGIN;

ALTER TABLE public.password_reset_otps
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'reset';

-- Constrain to the two known values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_otps_purpose_chk'
  ) THEN
    ALTER TABLE public.password_reset_otps
      ADD CONSTRAINT password_reset_otps_purpose_chk
      CHECK (purpose IN ('reset', 'change_password'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_reset_otps_email_purpose
  ON public.password_reset_otps (email, purpose);

COMMIT;

-- Rollback notes:
--   ALTER TABLE public.password_reset_otps DROP CONSTRAINT IF EXISTS password_reset_otps_purpose_chk;
--   DROP INDEX IF EXISTS public.idx_reset_otps_email_purpose;
--   ALTER TABLE public.password_reset_otps DROP COLUMN IF EXISTS purpose;
