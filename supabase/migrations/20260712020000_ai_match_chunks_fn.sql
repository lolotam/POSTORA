CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks(
  query_embedding vector(1536),
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
