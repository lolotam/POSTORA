-- Store-event tenancy hardening (Spec B, PR 2): bind each store_events row
-- to its binding structurally.
--
-- store_events already carries user_id/social_account_id/connector_id, but
-- only binding_id is enforced (REFERENCES ... (id)). The Edge Functions run
-- under the service role, which bypasses RLS, so "same owner" must be proven
-- with a composite foreign key, never left to the caller.
--
-- This migration adds UNIQUE (id, user_id, social_account_id, connector_id)
-- on store_webhook_bindings (id is already the PK; the composite key exists
-- only as the FK target) and a four-column FK from store_events to it.
-- Rows that are null or do not match their binding are deleted first
-- (production has 0 rows); social_account_id and connector_id then become
-- NOT NULL.
--
-- Idempotent: both constraints are added only when missing (DO blocks
-- checking pg_constraint — the unique key is never dropped on re-run, a FK
-- depends on it), and the DELETE plus SET NOT NULL re-run cleanly.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Composite identity key on store_webhook_bindings as the FK target.
--    Added only when missing: a DROP on re-run would fail once the
--    store_events FK below depends on it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_webhook_bindings_identity_key'
      AND conrelid = 'public.store_webhook_bindings'::regclass
  ) THEN
    ALTER TABLE public.store_webhook_bindings
      ADD CONSTRAINT store_webhook_bindings_identity_key
      UNIQUE (id, user_id, social_account_id, connector_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. Drop rows that cannot satisfy the new FK: null identity columns, or
--    identity columns that do not match the referenced binding. The NOT
--    EXISTS leg also covers a binding_id with no binding row at all.
-- ---------------------------------------------------------------------------
DELETE FROM public.store_events AS e
WHERE e.user_id IS NULL
   OR e.social_account_id IS NULL
   OR e.connector_id IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM public.store_webhook_bindings AS b
     WHERE b.id = e.binding_id
       AND b.user_id = e.user_id
       AND b.social_account_id = e.social_account_id
       AND b.connector_id = e.connector_id
   );

-- ---------------------------------------------------------------------------
-- C. The FK legs must be NOT NULL before the composite FK is added.
--    SET NOT NULL is idempotent, so no DO-block guard is needed.
-- ---------------------------------------------------------------------------
ALTER TABLE public.store_events
  ALTER COLUMN social_account_id SET NOT NULL;
ALTER TABLE public.store_events
  ALTER COLUMN connector_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- D. Composite FK proving "same owner" structurally: the event's
--    (binding_id, user_id, social_account_id, connector_id) must equal the
--    binding's (id, user_id, social_account_id, connector_id).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'store_events_binding_identity_fk'
      AND conrelid = 'public.store_events'::regclass
  ) THEN
    ALTER TABLE public.store_events
      ADD CONSTRAINT store_events_binding_identity_fk
      FOREIGN KEY (binding_id, user_id, social_account_id, connector_id)
      REFERENCES public.store_webhook_bindings
        (id, user_id, social_account_id, connector_id)
      ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
