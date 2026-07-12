-- Rollback for 20260713100000_add_bge_m3_embedding_pilot.sql.
-- Do not run while an Ollama pilot is active.

DROP FUNCTION IF EXISTS public.match_ai_knowledge_chunks_bge_m3(vector, uuid, integer);

ALTER TABLE public.ai_knowledge_chunks
  DROP COLUMN IF EXISTS embedding_bge_m3;
