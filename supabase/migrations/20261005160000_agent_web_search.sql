-- ============================================================================
-- Per-agent "Use web search" switch
-- ============================================================================
-- Type: additive column, default off. Safe before the code that reads it: until
-- then nothing reads the column, and afterwards every existing agent keeps
-- today's behaviour until its owner switches it on.
--
-- When true, ai-agent-reply offers the model a `web_search` tool that runs the
-- admin's Search ladder (/admin/settings → Search Models). Off by default
-- because a search adds one to several seconds to the reply.
--
-- Spec: docs/superpowers/specs/2026-10-05-vision-ladder-and-model-cleanup.md (Phase D)
-- ============================================================================

ALTER TABLE public.ai_agent_configs
  ADD COLUMN IF NOT EXISTS web_search_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ai_agent_configs.web_search_enabled IS
  'When true the AI agent may call web_search (admin Search ladder). Off by default: it adds latency.';
