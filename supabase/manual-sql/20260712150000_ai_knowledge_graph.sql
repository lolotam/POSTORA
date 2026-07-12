CREATE TABLE public.ai_knowledge_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  normalized_name text GENERATED ALWAYS AS (lower(name)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized_name, type)
);

CREATE TABLE public.ai_knowledge_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_entity_id uuid NOT NULL REFERENCES public.ai_knowledge_entities(id) ON DELETE CASCADE,
  target_entity_id uuid NOT NULL REFERENCES public.ai_knowledge_entities(id) ON DELETE CASCADE,
  relation text NOT NULL,
  weight real NOT NULL DEFAULT 1,
  source_chunk_id uuid NOT NULL REFERENCES public.ai_knowledge_chunks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_chunk_id, source_entity_id, target_entity_id, relation)
);

CREATE INDEX idx_ai_knowledge_entities_user_id
  ON public.ai_knowledge_entities (user_id);
CREATE INDEX idx_ai_knowledge_relations_user_id
  ON public.ai_knowledge_relations (user_id);
CREATE INDEX idx_ai_knowledge_relations_source_chunk
  ON public.ai_knowledge_relations (source_chunk_id);
CREATE INDEX idx_ai_knowledge_relations_source_entity
  ON public.ai_knowledge_relations (source_entity_id);
CREATE INDEX idx_ai_knowledge_relations_target_entity
  ON public.ai_knowledge_relations (target_entity_id);

CREATE OR REPLACE FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.ai_knowledge_entities entity
  WHERE entity.user_id = p_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.ai_knowledge_relations relation
      WHERE relation.source_entity_id = entity.id
         OR relation.target_entity_id = entity.id
    );
$$;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_graph_relations(
  p_user_id uuid,
  p_source_chunk_ids uuid[],
  match_count integer DEFAULT 12
)
RETURNS TABLE (
  source_name text,
  source_type text,
  relation text,
  target_name text,
  target_type text
)
LANGUAGE sql
STABLE
AS $$
  WITH seed_entities AS (
    SELECT relation.source_entity_id AS entity_id
    FROM public.ai_knowledge_relations relation
    WHERE relation.user_id = p_user_id
      AND relation.source_chunk_id = ANY(p_source_chunk_ids)
    UNION
    SELECT relation.target_entity_id
    FROM public.ai_knowledge_relations relation
    WHERE relation.user_id = p_user_id
      AND relation.source_chunk_id = ANY(p_source_chunk_ids)
  )
  SELECT source.name, source.type, relation.relation, target.name, target.type
  FROM public.ai_knowledge_relations relation
  JOIN public.ai_knowledge_entities source ON source.id = relation.source_entity_id
  JOIN public.ai_knowledge_entities target ON target.id = relation.target_entity_id
  WHERE relation.user_id = p_user_id
    AND (
      relation.source_entity_id IN (SELECT entity_id FROM seed_entities)
      OR relation.target_entity_id IN (SELECT entity_id FROM seed_entities)
    )
  ORDER BY relation.weight DESC, relation.created_at DESC
  LIMIT match_count;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_knowledge_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_knowledge_relations TO authenticated;
GRANT ALL ON public.ai_knowledge_entities, public.ai_knowledge_relations TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_ai_knowledge_entities(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_graph_relations(uuid, uuid[], integer) TO service_role;

ALTER TABLE public.ai_knowledge_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_knowledge_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own ai knowledge entities"
  ON public.ai_knowledge_entities FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users manage own ai knowledge relations"
  ON public.ai_knowledge_relations FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins manage all ai knowledge entities"
  ON public.ai_knowledge_entities FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage all ai knowledge relations"
  ON public.ai_knowledge_relations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
