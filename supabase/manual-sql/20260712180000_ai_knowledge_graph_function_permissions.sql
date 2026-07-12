REVOKE ALL ON FUNCTION public.prune_ai_knowledge_entities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_graph_relations(uuid, uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_all_ai_knowledge_entities() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.prune_ai_knowledge_entities(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_graph_relations(uuid, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_all_ai_knowledge_entities() TO service_role;
