-- No catalogue/network calls in a migration. Recover only evidence already
-- persisted by a provider/admin, plus the documented non-thinking DeepSeek
-- aliases. OpenRouter rows whose supported_parameters was discarded require
-- a successful API catalogue sync before enabling feature_ai_text_auth_lists.
UPDATE public.ai_models m
SET metadata = COALESCE(m.metadata, '{}'::jsonb) || '{"tool_calling":true}'::jsonb
FROM public.ai_providers p
WHERE p.id = m.provider_id AND m.auth_method = 'api_key'
  AND 'chat' = ANY(m.capabilities)
  AND NOT COALESCE(m.metadata, '{}'::jsonb) ? 'tool_calling'
  AND (m.metadata->'supported_parameters' @> '["tools"]'::jsonb
    OR (p.provider_code = 'vercel' AND m.metadata->'tags' @> '["tool-use"]'::jsonb)
    OR (p.provider_code = 'deepseek' AND m.model_id IN ('deepseek-chat','deepseek-flash')));
