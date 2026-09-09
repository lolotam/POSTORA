-- Staleness counters for the nightly graph-refresh worker.
--
-- NULL is load-bearing: it means "this row predates the columns". The refresh
-- worker's count_changed staleness rule treats a NULL count as changed, so
-- every legacy row rebuilds exactly once. A default of 0 would silently mark
-- legacy rows as current and they would never be repaired -- hence nullable
-- with no default and no backfill.

ALTER TABLE public.ai_knowledge_graph_exports
  ADD COLUMN IF NOT EXISTS entity_count integer;

COMMENT ON COLUMN public.ai_knowledge_graph_exports.entity_count IS
  'Entities baked into this export. Read by the nightly refresh worker''s count_changed staleness rule; NULL means pre-columns legacy row and must be treated as changed so it rebuilds exactly once.';

ALTER TABLE public.ai_knowledge_graph_exports
  ADD COLUMN IF NOT EXISTS relation_count integer;

COMMENT ON COLUMN public.ai_knowledge_graph_exports.relation_count IS
  'Relations baked into this export. Read by the nightly refresh worker''s count_changed staleness rule; NULL means pre-columns legacy row and must be treated as changed so it rebuilds exactly once.';
