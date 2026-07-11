CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.ai_agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'facebook', 'instagram')),
  is_enabled BOOLEAN DEFAULT false,
  default_mode TEXT NOT NULL DEFAULT 'human_then_ai' CHECK (default_mode IN ('ai_first', 'human_first', 'human_then_ai')),
  persona_instructions TEXT,
  business_profile_text TEXT,
  language_mode TEXT NOT NULL DEFAULT 'auto' CHECK (language_mode IN ('auto', 'ar', 'en')),
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  temperature NUMERIC DEFAULT 0.4,
  admin_phone_numbers TEXT[] NOT NULL DEFAULT '{}',
  daily_message_cap INTEGER NOT NULL DEFAULT 50,
  reply_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
  max_tool_iterations INTEGER NOT NULL DEFAULT 5,
  handoff_on_request BOOLEAN DEFAULT true,
  handoff_on_low_confidence BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, platform)
);

CREATE TABLE public.ai_conversation_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'facebook', 'instagram')),
  conversation_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ai_first', 'human_first', 'human_then_ai')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, platform, conversation_id)
);

CREATE TABLE public.ai_knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_type TEXT CHECK (source_type IN ('excel', 'csv', 'pdf', 'doc', 'image', 'catalog', 'profile_text')),
  file_name TEXT,
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error TEXT,
  chunk_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.ai_knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.ai_knowledge_sources(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ai_knowledge_chunks_embedding ON public.ai_knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_ai_knowledge_chunks_user_id ON public.ai_knowledge_chunks (user_id);

CREATE TABLE public.ai_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'facebook', 'instagram')),
  conversation_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, platform, conversation_id)
);

CREATE TABLE public.ai_thread_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.ai_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT,
  tool_calls JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ai_thread_messages_thread_created ON public.ai_thread_messages (thread_id, created_at);

CREATE TABLE public.ai_agent_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  tool_type TEXT NOT NULL DEFAULT 'n8n_webhook' CHECK (tool_type IN ('builtin', 'n8n_webhook')),
  url TEXT,
  secret TEXT,
  is_enabled BOOLEAN DEFAULT true,
  admin_only BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE public.ai_agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT CHECK (platform IN ('whatsapp', 'facebook', 'instagram')),
  conversation_id TEXT,
  inbound_text TEXT,
  reply_text TEXT,
  retrieved_chunk_ids UUID[],
  tool_calls JSONB,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  status TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ai_agent_logs_user_created ON public.ai_agent_logs (user_id, created_at DESC);

ALTER TABLE public.ai_agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_conversation_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_thread_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own ai agent configs" ON public.ai_agent_configs FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai conversation modes" ON public.ai_conversation_modes FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai knowledge sources" ON public.ai_knowledge_sources FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai knowledge chunks" ON public.ai_knowledge_chunks FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai threads" ON public.ai_threads FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai thread messages" ON public.ai_thread_messages FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai agent tools" ON public.ai_agent_tools FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own ai agent logs" ON public.ai_agent_logs FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_ai_agent_configs_updated_at BEFORE UPDATE ON public.ai_agent_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_ai_conversation_modes_updated_at BEFORE UPDATE ON public.ai_conversation_modes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_ai_knowledge_sources_updated_at BEFORE UPDATE ON public.ai_knowledge_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_ai_threads_updated_at BEFORE UPDATE ON public.ai_threads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_ai_agent_tools_updated_at BEFORE UPDATE ON public.ai_agent_tools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();