-- ============================================================================
-- Refresh AI catalog with the latest models (June 2026)
-- ============================================================================
-- Type: data update (ai_providers, ai_models)
-- Safe to re-run: YES — every INSERT uses ON CONFLICT DO NOTHING, every
--                 UPDATE is idempotent.
-- Rollback: see "ROLLBACK NOTES" at the bottom.
--
-- Scope:
--   * Adds the newest publicly available chat/image/video/tts/stt/embedding
--     model IDs for every provider already in ai_providers.
--   * Repricing for previously-seeded rows is left untouched on purpose
--     (admins can edit per row in the dashboard) — this script only ADDS
--     new rows and DEACTIVATES clearly retired ones.
--   * Firecrawl is intentionally NOT added to ai_providers — it already
--     lives in the admin "External Services" card (see
--     src/pages/admin/AIConfigurationTab.tsx) and uses the v2 endpoint
--     after the ai-config edge-function update shipped alongside this file.
--
-- Caveats:
--   * Pricing values are best-effort from public provider docs; tune in the
--     admin UI per workspace if needed.
--   * No model referenced by public.default_models is deactivated — admins
--     must switch defaults in the UI before retiring a model.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- SECTION A: ensure 'google' and 'gemini' provider codes both exist
-- (historical migrations used both). Anything we add below targets whichever
-- code is present.
-- ---------------------------------------------------------------------------
-- (No insert needed — both are seeded by 20260323193759 / 20260323210807.)

-- ---------------------------------------------------------------------------
-- SECTION B: OpenAI — chat / reasoning
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('gpt-5-nano',     'GPT-5 Nano',     'Fast, low-cost GPT-5 variant for high-volume tasks',           400000,  0.05,  0.40),
    ('gpt-5.4-nano',   'GPT-5.4 Nano',   'Fastest, lowest-cost GPT-5.4 variant',                          400000,  0.10,  0.80),
    ('gpt-5.4-pro',    'GPT-5.4 Pro',    'Premium GPT-5.4 variant for the most complex reasoning',        400000,  5.00, 40.00),
    ('gpt-5.5',        'GPT-5.5',        'Most capable GPT-5.5 model for demanding reasoning and coding', 400000,  3.50, 28.00),
    ('gpt-5.5-pro',    'GPT-5.5 Pro',    'Premium GPT-5.5 with extended reasoning',                       400000,  7.50, 60.00),
    ('o4',             'o4',             'OpenAI flagship reasoning model',                               200000, 15.00, 60.00)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'openai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION C: OpenAI — image / TTS / STT / embeddings
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, v.caps::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('gpt-image-2',                'GPT Image 2',                  'State-of-the-art image generation via /v1/images/generations', ARRAY['image']),
    ('gpt-image-1-mini',           'GPT Image 1 Mini',             'Cost-efficient image generation via /v1/images/generations',   ARRAY['image']),
    ('gpt-4o-mini-tts',            'GPT-4o Mini TTS',              'Text-to-speech via /v1/audio/speech',                          ARRAY['tts']),
    ('gpt-4o-mini-transcribe',     'GPT-4o Mini Transcribe',       'Speech-to-text via /v1/audio/transcriptions',                  ARRAY['stt']),
    ('gpt-4o-transcribe',          'GPT-4o Transcribe',            'Higher-accuracy speech-to-text',                               ARRAY['stt']),
    ('text-embedding-3-large',     'Text Embedding 3 Large',       'Highest-quality OpenAI text embeddings',                       ARRAY['embedding']),
    ('text-embedding-3-small',     'Text Embedding 3 Small',       'Cost-efficient OpenAI text embeddings',                        ARRAY['embedding']),
    ('sora-2',                     'Sora 2',                       'OpenAI text-to-video generation',                              ARRAY['video'])
  ) AS v(model_id, name, description, caps)
WHERE p.provider_code = 'openai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION D: Anthropic / Claude — chat
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('claude-haiku-4.6',  'Claude Haiku 4.6',  'Fast, affordable Claude for high-volume tasks',         200000,  0.80,  4.00),
    ('claude-opus-4.8',   'Claude Opus 4.8',   'Most capable Anthropic model, deep reasoning',         1000000, 15.00, 75.00),
    ('claude-sonnet-4.8', 'Claude Sonnet 4.8', 'Balanced Claude flagship with 1M context',             1000000,  3.00, 15.00),
    ('claude-6.8-sonnet', 'Claude 6.8 Sonnet', 'Next-generation Sonnet (preview)',                     1000000,  4.00, 20.00),
    ('claude-6.8-opus',   'Claude 6.8 Opus',   'Next-generation Opus (preview)',                       1000000, 18.00, 90.00)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'claude'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION E: Google / Gemini — chat + image + video + embeddings
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('gemini-3-flash-preview',  'Gemini 3 Flash Preview',  'Default fast Gemini 3 preview',                     1000000, 0.10, 0.40),
    ('gemini-3.1-flash',        'Gemini 3.1 Flash',        'Gemini 3.1 fast multimodal',                        1000000, 0.15, 0.60),
    ('gemini-3.1-flash-lite',   'Gemini 3.1 Flash Lite',   'Cost-efficient Gemini 3.1',                         1000000, 0.08, 0.30),
    ('gemini-3.1-pro-preview',  'Gemini 3.1 Pro Preview',  'Next-gen Gemini reasoning',                         2000000, 2.50, 10.00),
    ('gemini-3.5-flash',        'Gemini 3.5 Flash',        'High-efficiency Gemini 3.5 for coding & reasoning', 2000000, 0.20, 0.80)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code IN ('gemini','google')
ON CONFLICT (provider_id, model_id) DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, v.caps::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('gemini-3.1-flash-image', 'Gemini 3.1 Flash Image (Nano Banana 2)', 'Fast high-quality image generation/editing', ARRAY['image']),
    ('gemini-3-pro-image',     'Gemini 3 Pro Image',                      'Higher-quality image generation/editing',    ARRAY['image']),
    ('imagen-4-ultra',         'Imagen 4 Ultra',                          'Highest-quality Google image generation',    ARRAY['image']),
    ('veo-3',                  'Veo 3',                                   'Google text-to-video generation',            ARRAY['video']),
    ('veo-3-fast',             'Veo 3 Fast',                              'Faster, cheaper Veo 3 variant',              ARRAY['video']),
    ('gemini-embedding-001',   'Gemini Embedding 001',                    'Default Google text embeddings',             ARRAY['embedding']),
    ('gemini-embedding-2',     'Gemini Embedding 2',                      'Multimodal Google embeddings',               ARRAY['embedding'])
  ) AS v(model_id, name, description, caps)
WHERE p.provider_code IN ('gemini','google')
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION F: xAI / Grok — chat + image
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('grok-4.3',         'Grok 4.3',         'xAI flagship with extended reasoning',     256000, 3.00, 15.00),
    ('grok-4.3-mini',    'Grok 4.3 Mini',    'Fast, affordable Grok 4.3',                256000, 0.30, 1.50),
    ('grok-4-heavy',     'Grok 4 Heavy',     'Heavy multi-agent Grok variant',           256000, 5.00, 25.00),
    ('grok-code-fast-1', 'Grok Code Fast 1', 'Optimized for coding and tool use',        256000, 0.50, 2.50)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'xai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['image']::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('grok-image-3',   'Grok Image 3',  'Latest xAI image generation'),
    ('grok-image-2',   'Grok Image 2',  'Previous xAI image generation')
  ) AS v(model_id, name, description)
WHERE p.provider_code = 'xai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION G: MiniMax — chat + image + video + TTS
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('MiniMax-M3',    'MiniMax M3',    'Latest MiniMax flagship chat model',         256000, 1.20, 6.00),
    ('MiniMax-Text-01','MiniMax Text 01','Long-context text model (4M tokens)',     4000000, 0.20, 1.10),
    ('abab7-chat',    'abab7 Chat',    'MiniMax conversational model',              245000, 1.00, 5.00)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'minimax'
ON CONFLICT (provider_id, model_id) DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, v.caps::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('image-01',         'MiniMax Image 01',     'MiniMax text-to-image',                ARRAY['image']),
    ('hailuo-02',        'Hailuo 02',            'MiniMax text-to-video (Hailuo 02)',    ARRAY['video']),
    ('hailuo-02-pro',    'Hailuo 02 Pro',        'Higher-fidelity Hailuo 02',            ARRAY['video']),
    ('video-01-live2d',  'MiniMax Video 01',     'Image-to-video generation',            ARRAY['video']),
    ('speech-2.6-hd',    'Speech 2.6 HD',        'MiniMax high-definition TTS',          ARRAY['tts']),
    ('voice-clone-2',    'Voice Clone 2',        'MiniMax voice cloning',                ARRAY['tts'])
  ) AS v(model_id, name, description, caps)
WHERE p.provider_code = 'minimax'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION H: Z.AI / GLM — chat + video
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('glm-5.2',        'GLM 5.2',        'Z.AI latest flagship chat model',         200000, 0.60, 2.20),
    ('glm-5.2-air',    'GLM 5.2 Air',    'Faster, cheaper GLM 5.2',                 200000, 0.20, 1.00),
    ('glm-4.7',        'GLM 4.7',        'Previous-gen Z.AI flagship',              200000, 0.50, 2.00),
    ('glm-4.7-flash',  'GLM 4.7 Flash',  'Free / very low cost Z.AI chat',          128000, 0.00, 0.00),
    ('glm-z1-32b',     'GLM Z1 32B',     'Z.AI reasoning model',                    128000, 1.00, 4.00)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'zai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, v.caps::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('cogview-4',  'CogView 4',  'Z.AI text-to-image',           ARRAY['image']),
    ('cogvideox-2','CogVideoX 2','Z.AI text-to-video generation',ARRAY['video'])
  ) AS v(model_id, name, description, caps)
WHERE p.provider_code = 'zai'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION I: ElevenLabs — TTS / STT
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, is_active, cost_per_1m_input_tokens, cost_per_1m_output_tokens)
SELECT p.id, v.model_id, v.name, v.description, v.caps::text[], true, NULL, NULL
FROM public.ai_providers p,
  (VALUES
    ('eleven_v3',                 'ElevenLabs v3',                 'Latest expressive TTS model',                 ARRAY['tts']),
    ('eleven_turbo_v2_5',         'ElevenLabs Turbo v2.5',         'Low-latency multilingual TTS',                ARRAY['tts']),
    ('eleven_multilingual_v2',    'ElevenLabs Multilingual v2',    'High-quality multilingual TTS',               ARRAY['tts']),
    ('eleven_flash_v2_5',         'ElevenLabs Flash v2.5',         'Ultra-fast TTS for real-time',                ARRAY['tts']),
    ('scribe_v1',                 'ElevenLabs Scribe v1',          'Speech-to-text with diarization',             ARRAY['stt'])
  ) AS v(model_id, name, description, caps)
WHERE p.provider_code = 'elevenlabs'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION J: Perplexity — search/chat
-- ---------------------------------------------------------------------------
INSERT INTO public.ai_models (provider_id, model_id, name, description, capabilities, context_limit, cost_per_1m_input_tokens, cost_per_1m_output_tokens, is_active)
SELECT p.id, v.model_id, v.name, v.description, ARRAY['search','chat']::text[], v.ctx, v.cin, v.cout, true
FROM public.ai_providers p,
  (VALUES
    ('sonar',                'Sonar',                'Fast everyday grounded-search Q&A',     128000, 1.00, 1.00),
    ('sonar-pro',            'Sonar Pro',            'Multi-step search with 2x citations',   200000, 3.00, 15.00),
    ('sonar-reasoning',      'Sonar Reasoning',      'Chain-of-thought + real-time search',   128000, 1.00, 5.00),
    ('sonar-reasoning-pro',  'Sonar Reasoning Pro',  'Advanced reasoning (DeepSeek R1 based)',128000, 2.00, 8.00),
    ('sonar-deep-research',  'Sonar Deep Research',  'Multi-query expert research pipeline',  200000, 2.00, 8.00)
  ) AS v(model_id, name, description, ctx, cin, cout)
WHERE p.provider_code = 'perplexity'
ON CONFLICT (provider_id, model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- SECTION K: deactivate clearly-retired model IDs
-- (only deactivates — never deletes — and never touches a model referenced
--  by public.default_models so admin defaults don't break.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  retired_ids text[] := ARRAY[
    'gpt-4','gpt-4-turbo','gpt-3.5-turbo',
    'claude-3-opus','claude-3-sonnet','claude-3-haiku',
    'gemini-1.5-pro','gemini-1.5-flash','gemini-1.0-pro',
    'grok-2','grok-2-mini'
  ];
BEGIN
  IF to_regclass('public.default_models') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.ai_models
      SET is_active = false
      WHERE model_id = ANY($1)
        AND NOT EXISTS (
          SELECT 1 FROM public.default_models dm
          WHERE dm.model_id = public.ai_models.model_id
        )
    $sql$ USING retired_ids;
  ELSE
    UPDATE public.ai_models
    SET is_active = false
    WHERE model_id = ANY(retired_ids);
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK NOTES
-- ============================================================================
-- 1) To remove all rows added by this script (only the ones with the IDs
--    listed above):
--      DELETE FROM public.ai_models WHERE model_id IN (
--        'gpt-5-nano','gpt-5.4-nano','gpt-5.4-pro','gpt-5.5','gpt-5.5-pro','o4',
--        'gpt-image-2','gpt-image-1-mini','gpt-4o-mini-tts',
--        'gpt-4o-mini-transcribe','gpt-4o-transcribe',
--        'text-embedding-3-large','text-embedding-3-small','sora-2',
--        'claude-haiku-4.6','claude-opus-4.8','claude-sonnet-4.8',
--        'claude-6.8-sonnet','claude-6.8-opus',
--        'gemini-3-flash-preview','gemini-3.1-flash','gemini-3.1-flash-lite',
--        'gemini-3.1-pro-preview','gemini-3.5-flash',
--        'gemini-3.1-flash-image','gemini-3-pro-image','imagen-4-ultra',
--        'veo-3','veo-3-fast','gemini-embedding-001','gemini-embedding-2',
--        'grok-4.3','grok-4.3-mini','grok-4-heavy','grok-code-fast-1',
--        'grok-image-3','grok-image-2',
--        'MiniMax-M3','MiniMax-Text-01','abab7-chat','image-01',
--        'hailuo-02','hailuo-02-pro','video-01-live2d','speech-2.6-hd','voice-clone-2',
--        'glm-5.2','glm-5.2-air','glm-4.7','glm-z1-32b',
--        'cogview-4','cogvideox-2',
--        'eleven_v3','eleven_turbo_v2_5','eleven_multilingual_v2','eleven_flash_v2_5','scribe_v1',
--        'sonar','sonar-pro','sonar-reasoning','sonar-reasoning-pro','sonar-deep-research'
--      );
-- 2) To re-activate the legacy rows deactivated in Section K, set
--    is_active = true on those model_ids.
-- ============================================================================
