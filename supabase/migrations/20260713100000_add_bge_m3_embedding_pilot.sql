-- Adds a reversible bge-m3 pilot alongside Gemini embeddings.
-- Model: bge-m3:latest; dimensions: 1024; provider: internal Ollama.
-- Model digest: 7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab.
-- Migration date: 2026-07-13.

ALTER TABLE public.ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_bge_m3 vector(1024);

COMMENT ON COLUMN public.ai_knowledge_chunks.embedding_bge_m3 IS
  'Pilot embedding: bge-m3:latest, 1024 dimensions, internal Ollama, digest 7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab, migration 2026-07-13.';

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks_bge_m3(
  query_embedding vector(1024),
  p_user_id uuid,
  match_count int DEFAULT 6
) RETURNS TABLE (id uuid, source_id uuid, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding_bge_m3 <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks c
  WHERE c.user_id = p_user_id AND c.embedding_bge_m3 IS NOT NULL
  ORDER BY c.embedding_bge_m3 <=> query_embedding
  LIMIT match_count;
$$;
