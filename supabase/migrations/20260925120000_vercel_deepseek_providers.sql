-- Vercel AI Gateway and DeepSeek, both OpenAI-compatible. Models are not seeded
-- here: ai-config `sync-models` fills them from each provider's /models.
-- Keys are never stored in a migration; admins enter them through Save & Test.
INSERT INTO public.ai_providers
  (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active)
VALUES
  ('vercel',   'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_API_KEY', 'openai', true, true),
  ('deepseek', 'DeepSeek',          'https://api.deepseek.com',        'DEEPSEEK_API_KEY',   'openai', true, true)
ON CONFLICT (provider_code) DO UPDATE SET
  name = EXCLUDED.name,
  api_endpoint = EXCLUDED.api_endpoint,
  api_key_env_var = EXCLUDED.api_key_env_var,
  api_type = EXCLUDED.api_type,
  updated_at = now();
