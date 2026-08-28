-- ============================================================================
-- Expand the OpenRouter embedding catalogue
-- ============================================================================
-- Type: additive data seeding only. Safe to re-run (ON CONFLICT merges metadata).
--
-- Every model below was called against https://openrouter.ai/api/v1/embeddings
-- with the production key and its RETURNED width recorded. Nothing here is
-- seeded from a published table, because that table proved wrong three times:
--   * qwen/qwen3-embedding-0.6b        -> HTTP 404 "No endpoints found"
--   * liquid/lfm2.5-embedding-350m     -> HTTP 400 "does not exist"; the working
--                                         slug is liquid/lfm-2.5-embedding-350m:free
--                                         (hyphen), already seeded on 2026-08-28
--   * nvidia/nemotron-3-embed-1b:free  -> "dimensions must be one of 2048"
-- Those three are deliberately absent: a row the admin can select but Postora
-- cannot call is worse than no row at all.
--
-- The `:batch` variants are also omitted. They are asynchronous batch endpoints
-- with different semantics from the synchronous embedding path this ladder uses;
-- seeding them would offer a discount the code cannot actually take.
--
-- ai_knowledge_chunks stores exactly two widths -- embedding vector(1536) and
-- embedding_bge_m3 vector(1024) -- so `requested` is the width Postora asks for
-- and is always one of those two. Models whose native width is larger are
-- narrowed via the `dimensions` parameter, which each one below was verified to
-- honour.
-- ============================================================================

BEGIN;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, context_limit, metadata, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['embedding']::text[], true, v.ctx,
  jsonb_build_object('embedding_dimensions', jsonb_build_object('native', v.native_dims, 'requested', v.requested_dims)),
  v.cin, 0::numeric
FROM public.ai_providers p,
  (VALUES
    ('google/gemini-embedding-2',          'Gemini Embedding 2 (OpenRouter)',       'Google embeddings via OpenRouter, requested at 1536',            3072, 1536,  8192, 0.20::numeric),
    ('google/gemini-embedding-001',        'Gemini Embedding 001 (OpenRouter)',     'Google embeddings via OpenRouter, requested at 1536',            3072, 1536, 20000, 0.15::numeric),
    ('google/gemini-embedding-2-preview',  'Gemini Embedding 2 Preview (OpenRouter)','Preview Google embeddings via OpenRouter, requested at 1536',   3072, 1536,  8192, 0.20::numeric),
    ('openai/text-embedding-3-large',      'Text Embedding 3 Large (OpenRouter)',   'OpenAI embeddings via OpenRouter, requested at 1536',            3072, 1536,  8192, 0.13::numeric),
    ('openai/text-embedding-3-small',      'Text Embedding 3 Small (OpenRouter)',   'Cost-efficient OpenAI embeddings via OpenRouter',                1536, 1536,  8192, 0.02::numeric),
    ('openai/text-embedding-ada-002',      'Text Embedding Ada 002 (OpenRouter)',   'Legacy OpenAI embeddings via OpenRouter',                        1536, 1536,  8192, 0.10::numeric),
    ('qwen/qwen3-embedding-8b',            'Qwen3 Embedding 8B',                    'Long-context Qwen embeddings, requested at 1536',                4096, 1536, 32768, 0.01::numeric),
    ('qwen/qwen3-embedding-4b',            'Qwen3 Embedding 4B',                    'Mid-tier Qwen embeddings, requested at 1536',                    2560, 1536, 32768, 0.02::numeric),
    ('mistralai/mistral-embed-2312',       'Mistral Embed 2312',                    'General-purpose Mistral embeddings; native 1024 width',          1024, 1024,  8192, 0.10::numeric),
    ('mistralai/codestral-embed-2505',     'Codestral Embed 2505',                  'Code-optimised Mistral embeddings; native 1536 width',           1536, 1536,  8192, 0.15::numeric)
  ) AS v(model_id, name, description, native_dims, requested_dims, ctx, cin)
WHERE p.provider_code = 'openrouter'
ON CONFLICT (provider_id, model_id) DO UPDATE
  -- Merge only: refresh the verified dimensionality, leave an admin's edits to
  -- name/description/capabilities/cost/active state alone.
  SET metadata = public.ai_models.metadata || EXCLUDED.metadata;

COMMIT;
