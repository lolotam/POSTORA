-- ============================================================================
-- CONTRACT half of the ai_models catalogue rollout.
--
-- This is the second half of the pair:
--
--   20261113180000_ai_provider_health.sql          (EXPAND)
--     adds ai_models.auth_method and the three-column unique index
--     (provider_id, model_id, auth_method), and KEEPS the old two-column unique
--     constraint ai_models_provider_id_model_id_key.
--
--   20261113180100_ai_model_catalog_drop_legacy_unique.sql   (this file, CONTRACT)
--     drops the old two-column unique constraint.
--
-- WHY THE SPLIT
-- The catalogue write path upserts on (provider_id, model_id, auth_method) after
-- this feature, and on (provider_id, model_id) before it. Postgres answers 42P10
-- ("there is no unique or exclusion constraint matching the ON CONFLICT
-- specification") when the constraint the upsert names is gone. Dropping the old
-- constraint in the same migration that adds the new index would therefore break
-- the code that is deployed at that moment.
--
-- THE ROLLOUT, IN ORDER
--   1. apply the EXPAND migration (20261113180000) BEFORE the merge
--      -- both unique indexes exist, and the code that is live still works
--   2. merge, and deploy the edge functions (ai-provider-health, ai-config)
--   3. apply THIS migration (CONTRACT)
--
-- WHAT IS LOST UNTIL STEP 3
-- The old two-column constraint still forbids a second row for the same
-- (provider_id, model_id). An OAuth catalogue row for a model that already has
-- an API-key row cannot be written until this migration is applied: the
-- OAuth catalogue sync reports that as a sync error instead of quietly
-- pretending the catalogue is in sync.
--
-- SAFETY
-- The three-column unique index must exist before the two-column constraint
-- goes. Without it the table would have no unique index at all and the
-- catalogue could grow duplicate rows. The check below refuses to run in that
-- case.
-- ============================================================================

DO $contract_ai_model_catalogue$
BEGIN
  IF to_regclass('public.ai_models') IS NULL THEN
    RAISE EXCEPTION 'ai_model_catalog_drop_legacy_unique: public.ai_models does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ai_models_provider_model_auth_method_key'
       AND i.indrelid = 'public.ai_models'::regclass
       AND i.indisunique
       AND i.indisvalid
       AND i.indpred IS NULL
       AND i.indexprs IS NULL
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM pg_attribute a
             WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
           = ARRAY['auth_method', 'model_id', 'provider_id']
  ) THEN
    RAISE EXCEPTION
      'ai_model_catalog_drop_legacy_unique: the unique index ai_models_provider_model_auth_method_key is missing; apply the EXPAND migration first';
  END IF;
END $contract_ai_model_catalogue$;

ALTER TABLE public.ai_models DROP CONSTRAINT IF EXISTS ai_models_provider_id_model_id_key;
