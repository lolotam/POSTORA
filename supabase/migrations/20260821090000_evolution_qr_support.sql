ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS connection_mode text DEFAULT 'cloud_api';

UPDATE public.social_accounts
SET connection_mode = CASE
  WHEN account_metadata->>'connection_mode' IN ('cloud_api', 'coexistence', 'evolution_qr')
    THEN account_metadata->>'connection_mode'
  ELSE 'cloud_api'
END
WHERE platform = 'whatsapp';

ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_connection_mode_chk
  CHECK (
    platform <> 'whatsapp'
    OR connection_mode IN ('cloud_api', 'coexistence', 'evolution_qr')
  ) NOT VALID;

ALTER TABLE public.social_accounts
  VALIDATE CONSTRAINT social_accounts_connection_mode_chk;

CREATE INDEX IF NOT EXISTS social_accounts_evolution_qr_idx
  ON public.social_accounts (user_id, platform)
  WHERE connection_mode = 'evolution_qr';

CREATE TABLE public.whatsapp_evolution_instances (
  social_account_id uuid PRIMARY KEY
    REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  instance_name text NOT NULL UNIQUE,
  jwt_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  last_connection_state text,
  last_qr text
);

ALTER TABLE public.whatsapp_evolution_instances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_evolution_instances FROM anon, authenticated;
