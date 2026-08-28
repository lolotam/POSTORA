-- ============================================================================
-- Embedding-model admin configuration + CSV ingestion queue
-- ============================================================================
-- Type: additive data seeding + one function replacement
-- Safe to re-run: YES — provider/model inserts use ON CONFLICT, settings use
--                 ON CONFLICT DO NOTHING (an admin's later choice is never
--                 overwritten), the claim function is CREATE OR REPLACE.
--
-- DEPLOY-ORDER WARNING (section D):
--   Section D widens the ingestion queue so CSV sources wait for the
--   ai-knowledge-excel-worker. That worker MUST be running before D is
--   applied, or every CSV upload becomes a silent permanent `pending`.
--   See docs/runbooks/deploy-ai-knowledge-worker.md. If the worker is not
--   yet deployed, apply sections A-C now and D after the worker is healthy.
--
-- Verified against production before writing:
--   * settings live in system_settings (not app_settings) as
--     default_ai_model_<category>[_fallback[_2]] with {provider_code, model_id}
--   * ai_knowledge_chunks has exactly two vector columns: embedding vector(1536)
--     and embedding_bge_m3 vector(1024) — models of any other width cannot be
--     stored, and no new vector columns are added here
--   * every model below was called against its live provider API and its
--     returned width recorded; nothing here is seeded from a docs page. Models
--     that exist but cannot be narrowed to 1024 or 1536 are NOT seeded, because
--     an unusable row in the admin dropdown is a trap:
--       - nvidia/nemotron-3-embed-1b:free  -> "dimensions must be one of 2048"
--       - gemini text-embedding-004        -> absent from the API entirely
--   * OpenRouter DOES serve embeddings, even though /api/v1/models lists none
--     (that endpoint is chat-only). Perplexity's own /embeddings is a 404, but
--     its models are reachable through OpenRouter.
--   * the self-hosted Ollama has exactly one model: bge-m3:latest (1024 dims)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- SECTION A: the self-hosted Ollama provider
-- ---------------------------------------------------------------------------
-- api_key_env_var is NOT NULL but Ollama needs no key; OLLAMA_API_KEY is a
-- placeholder that never has to exist in the environment.
INSERT INTO public.ai_providers (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active)
VALUES ('ollama', 'Ollama (self-hosted)', 'http://ollama:11434', 'OLLAMA_API_KEY', 'openai', false, true)
ON CONFLICT (provider_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION B: embedding models with recorded dimensionality
-- ---------------------------------------------------------------------------
-- metadata.embedding_dimensions is the machine-readable width used by the
-- admin UI filter and the edge-function ladder:
--   {"native": <model's fixed width>, "requested": <width Postora will request>}
-- `requested` differs from `native` only for models that accept a requested
-- output dimensionality (OpenAI v3, Gemini embedding) and is how a 3072-native
-- model becomes storable in the 1536 column.
--
-- Every row below returned its recorded width from a live call. A model whose
-- `requested` width is neither 1024 nor 1536 has no column to live in and is
-- deliberately absent rather than seeded-and-unselectable.
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, metadata, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['embedding']::text[], true,
  jsonb_build_object('embedding_dimensions', jsonb_build_object('native', v.native_dims, 'requested', v.requested_dims)),
  v.cin, v.cout
FROM public.ai_providers p,
  (VALUES
    ('openai', 'text-embedding-3-small',  'Text Embedding 3 Small',  'Cost-efficient OpenAI text embeddings',                    1536, 1536, 0.02::numeric, 0.00::numeric),
    ('openai', 'text-embedding-3-large',  'Text Embedding 3 Large',  'OpenAI embeddings requested at 1536 dimensions',           3072, 1536, 0.13::numeric, 0.00::numeric),
    ('gemini', 'gemini-embedding-001',    'Gemini Embedding 001',    'Default Google text embeddings, requested at 1536',        3072, 1536, NULL::numeric, NULL::numeric),
    ('gemini', 'gemini-embedding-2',      'Gemini Embedding 2',      'Multimodal Google embeddings, requested at 1536',           3072, 1536, NULL::numeric, NULL::numeric),
    ('ollama', 'bge-m3:latest',           'BGE-M3 (self-hosted)',    'Self-hosted 1024-dimension embeddings via the stack Ollama container; zero marginal cost', 1024, 1024, 0.00::numeric, 0.00::numeric),
    -- OpenRouter-hosted models, each verified by a live /embeddings call.
    -- The two 1024-d models land in embedding_bge_m3 alongside bge-m3, so
    -- switching between them requires a re-embed (the ladder enforces this).
    ('openrouter', 'perplexity/pplx-embed-v1-4b',              'Perplexity Embed v1 4B',      'Perplexity embeddings via OpenRouter, requested at 1536', 2560, 1536, NULL::numeric, NULL::numeric),
    ('openrouter', 'perplexity/pplx-embed-v1-0.6b',            'Perplexity Embed v1 0.6B',    'Smaller Perplexity embeddings via OpenRouter; capped at 1024', 1024, 1024, NULL::numeric, NULL::numeric),
    ('openrouter', 'nvidia/llama-nemotron-embed-vl-1b-v2:free','Nemotron Embed VL 1B (free)', 'Free NVIDIA multimodal embeddings via OpenRouter, requested at 1536', 2048, 1536, 0.00::numeric, 0.00::numeric),
    ('openrouter', 'liquid/lfm-2.5-embedding-350m:free',       'Liquid LFM 2.5 Embed (free)', 'Free Liquid embeddings via OpenRouter; fixed 1024 width', 1024, 1024, 0.00::numeric, 0.00::numeric)
  ) AS v(provider_code, model_id, name, description, native_dims, requested_dims, cin, cout)
WHERE p.provider_code = v.provider_code
ON CONFLICT (provider_id, model_id) DO UPDATE
  -- Merge only: refresh the dimensionality record, leave an admin's edits to
  -- name/description/capabilities/cost/active state untouched.
  SET metadata = public.ai_models.metadata || EXCLUDED.metadata;

-- ---------------------------------------------------------------------------
-- SECTION C: embedding ladder defaults in system_settings
-- ---------------------------------------------------------------------------
-- Primary is the self-hosted Ollama bge-m3 (what production actually runs
-- today); fallbacks come from the seeded, storable set. DO NOTHING so a re-run
-- never overwrites an admin's later choice.
INSERT INTO public.system_settings (key, value, description) VALUES
  ('default_ai_model_embedding',          '{"provider_code":"ollama","model_id":"bge-m3:latest"}'::jsonb,             'Default embedding model for Knowledge Base & RAG search'),
  ('default_ai_model_embedding_fallback', '{"provider_code":"gemini","model_id":"gemini-embedding-001"}'::jsonb,      'First embedding fallback (1536-d vector column)'),
  ('default_ai_model_embedding_fallback_2', '{"provider_code":"openai","model_id":"text-embedding-3-small"}'::jsonb,  'Second embedding fallback (1536-d vector column)')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION D: widen the ingestion queue to CSV
-- ---------------------------------------------------------------------------
-- Identical to the applied definition except source_type IN ('excel','csv').
-- The stale-`processing` reclaim (10 minutes) is unchanged and already present.
CREATE OR REPLACE FUNCTION public.claim_ai_knowledge_excel_source()
RETURNS SETOF public.ai_knowledge_sources
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.ai_knowledge_sources;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM public.ai_knowledge_sources
    WHERE source_type IN ('excel', 'csv')
      AND (
        status = 'pending'
        OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.ai_knowledge_sources source
  SET status = 'processing', error = NULL
  FROM candidate
  WHERE source.id = candidate.id
  RETURNING source.* INTO claimed;

  IF FOUND THEN RETURN NEXT claimed; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_knowledge_excel_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_knowledge_excel_source() TO service_role;

COMMIT;
