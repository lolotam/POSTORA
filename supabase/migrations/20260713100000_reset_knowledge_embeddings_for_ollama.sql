-- Test knowledge can be re-indexed from the preserved sources. Remove only
-- generated chunks and graph artifacts before changing vector dimensions.
DELETE FROM public.ai_knowledge_chunks;
DELETE FROM public.ai_knowledge_entities;

UPDATE public.ai_knowledge_sources
SET status = 'pending', chunk_count = 0, error = NULL;

DROP INDEX IF EXISTS public.idx_ai_knowledge_chunks_embedding;
ALTER TABLE public.ai_knowledge_chunks
  ALTER COLUMN embedding TYPE vector(1024) USING NULL;
CREATE INDEX idx_ai_knowledge_chunks_embedding
  ON public.ai_knowledge_chunks USING hnsw (embedding vector_cosine_ops);

DROP FUNCTION IF EXISTS public.match_ai_knowledge_chunks(vector, uuid, integer);
CREATE FUNCTION public.match_ai_knowledge_chunks(
  query_embedding vector(1024),
  p_user_id uuid,
  match_count int DEFAULT 6
) RETURNS TABLE (id uuid, source_id uuid, content text, metadata jsonb, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks c
  WHERE c.user_id = p_user_id AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
