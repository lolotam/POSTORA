-- Index for the knowledge sources list's "indexed on" date.
--
-- The panel reads the newest chunk per source in one round trip:
--   .select("*, ai_knowledge_chunks(created_at)")
--   .order("created_at", { referencedTable: "ai_knowledge_chunks", ascending: false })
--   .limit(1, { referencedTable: "ai_knowledge_chunks" })
--
-- ai_knowledge_chunks had indexes on id, user_id and an hnsw index on the
-- embedding, but nothing on source_id -- a foreign key does not create one.
-- PostgREST therefore ran a sequential scan of the whole chunk table once per
-- source: measured on production at 39 loops over 3,039 rows, ~30k shared
-- buffers. The list re-runs that read every 5 seconds while any source is
-- ingesting, and the table is shared across tenants, so the cost grew with
-- everyone's corpus rather than the caller's.
--
-- created_at DESC matches the ordering so the limit-1 is an index scan rather
-- than a sort. See docs/superpowers/plans/2026-09-09-knowledge-ux-and-graph-export-plan.md.
--
-- Not CONCURRENTLY: these migrations run inside a transaction, which forbids it.
-- The table is small enough that the brief write lock is not worth the
-- split-transaction handling CONCURRENTLY would require.

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_source_created
  ON public.ai_knowledge_chunks (source_id, created_at DESC);
