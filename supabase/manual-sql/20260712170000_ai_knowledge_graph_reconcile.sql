CREATE OR REPLACE FUNCTION public.prune_all_ai_knowledge_entities()
RETURNS integer
LANGUAGE sql
AS $$
  WITH deleted AS (
    DELETE FROM public.ai_knowledge_entities entity
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.ai_knowledge_relations relation
      WHERE relation.source_entity_id = entity.id
         OR relation.target_entity_id = entity.id
    )
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION public.prune_all_ai_knowledge_entities() TO service_role;

SELECT cron.schedule(
  'prune-ai-knowledge-graph-daily',
  '15 3 * * *',
  'SELECT public.prune_all_ai_knowledge_entities();'
)
WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'prune-ai-knowledge-graph-daily'
);
