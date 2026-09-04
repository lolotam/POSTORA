-- ============================================================================
-- Comment Workflow: the stats view carries the newest failure's reason.
--
-- The pool card showed "1 failed" and nothing else. The first real failure (Meta refusing a
-- private reply because the commenter was a Facebook Page) was diagnosable only from the edge
-- function logs. The card now gets the newest failed event's error_message and its time, so
-- the reason is one glance away, and a later successful send does not erase it.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the original migration set the precedent, and it
-- keeps the column list authoritative rather than append-only. security_invoker is repeated
-- because a recreated view does not inherit it, and without it every user would read everyone
-- else's numbers.
-- ============================================================================

DROP VIEW IF EXISTS public.comment_workflow_rule_stats;
CREATE VIEW public.comment_workflow_rule_stats
WITH (security_invoker = true) AS
WITH counts AS (
  SELECT
    rule_id,
    count(*)::int                                                                       AS triggered_count,
    count(*) FILTER (WHERE public_reply_status = 'sent')::int                           AS public_sent_count,
    count(*) FILTER (WHERE dm_status = 'sent')::int                                     AS dm_sent_count,
    count(*) FILTER (WHERE public_reply_status = 'failed' OR dm_status = 'failed')::int AS failed_count,
    count(*) FILTER (WHERE public_reply_status = 'indeterminate' OR dm_status = 'indeterminate')::int AS indeterminate_count,
    max(created_at)                                                                     AS last_triggered_at
  FROM public.comment_workflow_events
  GROUP BY rule_id
),
last_failure AS (
  -- Newest failed event per rule. Failure on either leg counts, matching failed_count above.
  SELECT DISTINCT ON (rule_id) rule_id, error_message, created_at
  FROM public.comment_workflow_events
  WHERE public_reply_status = 'failed' OR dm_status = 'failed'
  ORDER BY rule_id, created_at DESC, id DESC
)
SELECT
  counts.rule_id,
  counts.triggered_count,
  counts.public_sent_count,
  counts.dm_sent_count,
  counts.failed_count,
  counts.indeterminate_count,
  counts.last_triggered_at,
  last_failure.error_message AS last_error_message,
  last_failure.created_at    AS last_error_at
FROM counts
LEFT JOIN last_failure USING (rule_id);

GRANT SELECT ON public.comment_workflow_rule_stats TO authenticated;

-- PostgREST caches the schema; without this the new columns are invisible until its next reload.
NOTIFY pgrst, 'reload schema';
