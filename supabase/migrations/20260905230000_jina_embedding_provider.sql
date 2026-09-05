-- ============================================================================
-- Jina AI as an embedding provider
-- ============================================================================
-- Type: additive data seeding only. Safe to re-run (ON CONFLICT merges metadata).
--
-- jina-embeddings-v5-omni-small was called against https://api.jina.ai/v1/embeddings
-- with the production key on 2026-09-05: it returns 1024-wide vectors and
-- rejects `dimensions: 1536` ("Input should be less than or equal to 1024"),
-- so it lives in the 1024 column (embedding_bge_m3) and nowhere else. Both
-- retrieval tasks (retrieval.passage, retrieval.query) returned 1024.
--
-- Selecting it for the 1024 column while Ollama's bge-m3 still owns that
-- column is refused by the ladder until the column is re-embedded; this
-- migration only makes the model selectable, it does not change the ladder.
-- ============================================================================

BEGIN;

INSERT INTO public.ai_providers (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active)
VALUES ('jina', 'Jina AI', 'https://api.jina.ai/v1', 'JINA_API_KEY', 'openai', false, true)
ON CONFLICT (provider_code) DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, context_limit, metadata, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['embedding']::text[], true, v.ctx,
  jsonb_build_object('embedding_dimensions', jsonb_build_object('native', v.native_dims, 'requested', v.requested_dims)),
  v.cin, 0::numeric
FROM public.ai_providers p,
  (VALUES
    -- Cost is recorded as 0: the account runs on Jina's free monthly token
    -- allowance and no paid rate was verified. Update when a top-up is bought.
    ('jina-embeddings-v5-omni-small', 'Jina Embeddings v5 Omni Small', 'Multilingual retrieval embeddings with asymmetric passage/query tasks; native 1024 width', 1024, 1024, 32768, 0::numeric)
  ) AS v(model_id, name, description, native_dims, requested_dims, ctx, cin)
WHERE p.provider_code = 'jina'
ON CONFLICT (provider_id, model_id) DO UPDATE
  -- Merge only: refresh the verified dimensionality, leave an admin's edits to
  -- name/description/capabilities/cost/active state alone.
  SET metadata = public.ai_models.metadata || EXCLUDED.metadata;

COMMIT;
