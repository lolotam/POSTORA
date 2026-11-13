-- OpenRouter joins the subscription sign-ins.
--
-- The oauth_provider ids are ours, not pi-ai's: pi-ai 0.73.1 ships an
-- API-key provider for OpenRouter but no OAuth one, so the sign-in runs
-- OpenRouter's own PKCE flow (2026-11-12-ai-provider-auth-more-providers-design
-- §4). The CHECK is widened to the seven ids the design names; only
-- 'openrouter' has a client behind it so far, the rest arrive with their own
-- PRs.
--
-- The constraint is dropped and re-added rather than altered in place: the
-- inline column CHECK has to be dropped before a new one with the same name
-- can be added, and DROP ... IF EXISTS keeps the migration re-runnable.

ALTER TABLE public.ai_provider_oauth_connections
  DROP CONSTRAINT IF EXISTS ai_provider_oauth_connections_oauth_provider_check;

ALTER TABLE public.ai_provider_oauth_connections
  ADD CONSTRAINT ai_provider_oauth_connections_oauth_provider_check
  CHECK (oauth_provider IN ('anthropic','openai-codex','openrouter','xai','kimi-coding','minimax-code','zai-coding'));

-- PostgREST caches the table's shape; the new provider id must be visible to
-- the service-role RPCs that read it.
NOTIFY pgrst, 'reload schema';
