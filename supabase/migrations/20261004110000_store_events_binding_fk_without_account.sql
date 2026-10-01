-- WhatsApp account continuity, PR-BC (spec 2026-10-01 §5.3).
--
-- store_events_binding_identity_fk pinned (binding_id, user_id, social_account_id,
-- connector_id) to the binding, so a binding with any event could never change account —
-- which is exactly what moving a WhatsApp setup to a new connection must do. Events now
-- keep their own social_account_id as history; the binding link drops the account column.
--
-- That old FK was also the only proof that an event names its owner's account
-- (store_events.social_account_id has no FK of its own, 20260927120000:87-94), so this
-- migration adds one directly to social_accounts (id, user_id).

-- Preflight: refuse to proceed if any existing event names an account its owner lacks.
DO $pre$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.store_events e
     WHERE NOT EXISTS (
       SELECT 1 FROM public.social_accounts a
        WHERE a.id = e.social_account_id AND a.user_id = e.user_id)
  ) THEN
    RAISE EXCEPTION 'store_events has rows whose account is not the owner''s; resolve before adding the FK';
  END IF;
END $pre$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'store_webhook_bindings_id_user_connector_key'
       AND conrelid = 'public.store_webhook_bindings'::regclass
  ) THEN
    ALTER TABLE public.store_webhook_bindings
      ADD CONSTRAINT store_webhook_bindings_id_user_connector_key UNIQUE (id, user_id, connector_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'store_events_binding_tenant_fk'
       AND conrelid = 'public.store_events'::regclass
  ) THEN
    ALTER TABLE public.store_events
      ADD CONSTRAINT store_events_binding_tenant_fk
      FOREIGN KEY (binding_id, user_id, connector_id)
      REFERENCES public.store_webhook_bindings (id, user_id, connector_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'store_events_account_owner_fk'
       AND conrelid = 'public.store_events'::regclass
  ) THEN
    ALTER TABLE public.store_events
      ADD CONSTRAINT store_events_account_owner_fk
      FOREIGN KEY (social_account_id, user_id)
      REFERENCES public.social_accounts (id, user_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Dropped last, once both replacements exist, so no window lacks a tenancy proof.
ALTER TABLE public.store_events DROP CONSTRAINT IF EXISTS store_events_binding_identity_fk;
