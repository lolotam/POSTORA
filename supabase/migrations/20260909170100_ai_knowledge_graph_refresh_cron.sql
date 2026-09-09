-- Nightly knowledge-graph refresh: activity rollup plus its cron schedule.

-- 2a. One-row-per-user rollup so the nightly refresh worker can decide
-- staleness in one round trip instead of two counts per user.

-- NOTE: PG17 crashes the whole cluster when a function returns a table's
-- composite type, so the RETURNS TABLE column list below is spelled out
-- explicitly and must never be written as RETURNS SETOF <table>.
CREATE OR REPLACE FUNCTION public.ai_knowledge_graph_activity()
RETURNS TABLE (user_id uuid, email text, entity_count bigint, relation_count bigint, newest_activity timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH e AS (
    SELECT
      entities.user_id AS user_id,
      count(*)::bigint AS entity_count,
      max(entities.created_at) AS newest_entity
    FROM public.ai_knowledge_entities AS entities
    GROUP BY entities.user_id
  ),
  r AS (
    SELECT
      relations.user_id AS user_id,
      count(*)::bigint AS relation_count,
      max(relations.created_at) AS newest_relation
    FROM public.ai_knowledge_relations AS relations
    GROUP BY relations.user_id
  )
  SELECT
    coalesce(e.user_id, r.user_id) AS user_id,
    u.email AS email,
    coalesce(e.entity_count, 0) AS entity_count,
    coalesce(r.relation_count, 0) AS relation_count,
    -- GREATEST returns NULL when either side is NULL, so it cannot be used
    -- directly here: a user with entities but no relations would report NULL.
    -- max() over the two maxima ignores NULLs and is NULL only when both are.
    (SELECT max(t) FROM (VALUES (e.newest_entity), (r.newest_relation)) AS v(t)) AS newest_activity
  FROM e
  FULL OUTER JOIN r ON r.user_id = e.user_id
  LEFT JOIN auth.users AS u ON u.id = coalesce(e.user_id, r.user_id);
$$;

COMMENT ON FUNCTION public.ai_knowledge_graph_activity() IS
  'Per-user entity/relation counts plus newest activity, so the nightly refresh worker can decide staleness in one round trip instead of two counts per user.';

-- This function returns every user's email address, so it must never be
-- callable from a browser. Revoked first, then granted to service_role only.
REVOKE ALL ON FUNCTION public.ai_knowledge_graph_activity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_graph_activity() TO service_role;

-- 2b. The refresh cron.
--
-- Runs at 03:45 specifically because prune-ai-knowledge-graph-daily runs at
-- 15 3 * * * and deletes orphan entities. Refreshing before the prune would
-- publish a graph that is invalidated thirty minutes later.
--
-- Unscheduled first so re-applying the migration replaces the job rather than
-- failing on the duplicate name.
SELECT cron.unschedule('refresh-ai-knowledge-graphs')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-ai-knowledge-graphs');

SELECT cron.schedule(
  'refresh-ai-knowledge-graphs',
  '45 3 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/ai-knowledge-graph-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $cron$
);
