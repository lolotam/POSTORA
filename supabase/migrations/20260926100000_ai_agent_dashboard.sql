-- AI Agent dashboard (roadmap Phase 3 #5).
--
-- Two parts:
--
-- 1. Four columns on ai_agent_logs, written by ai-agent-reply's logOutcome.
--    The triage intent, the triage plan and the model used were only ever
--    written to system_logs.metadata, and system_logs is admin-only under RLS
--    ("Admins can read system logs"). A user's own dashboard cannot read it, so
--    the few fields the dashboard needs are copied onto the user-facing row.
--
--    All four are nullable, with NO check constraint and NO foreign key, on
--    purpose. PostgREST rejects the whole insert when any constraint fails
--    (and when a column it was sent does not exist), so a constraint here
--    would turn "a label value we did not anticipate" or "an account deleted
--    mid-request" into a missing Logs-tab row. The log write must never be the
--    thing that fails.
--
--    Rows written before this migration keep NULL in all four; the dashboard
--    says tracking starts at deploy, and nothing is backfilled.
--
-- 2. ai_agent_dashboard(p_days, p_platform): one jsonb document per call, so
--    the browser receives aggregates instead of thousands of rows.
--    SECURITY INVOKER: the caller's own RLS policy on ai_agent_logs does the
--    scoping, and the body also filters user_id = auth.uid() explicitly.
--    Returns jsonb rather than RETURNS TABLE of composites (PG17 has crashed on
--    composite RETURNS TABLE in this cluster).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying ai-agent-reply. The new
-- function sends these columns on every insert; against a schema without them
-- PostgREST answers PGRST204 and every ai_agent_logs row is lost.

ALTER TABLE public.ai_agent_logs
  ADD COLUMN IF NOT EXISTS social_account_id uuid,
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS triage_fast_path boolean,
  ADD COLUMN IF NOT EXISTS used_model text;

COMMENT ON COLUMN public.ai_agent_logs.social_account_id IS
  'Account the reply was for. No FK: a deleted account must not make the log insert fail. NULL before 2026-09-26 and for sandbox runs.';
COMMENT ON COLUMN public.ai_agent_logs.intent IS
  'Triage intent (pricing, order_status, complaint, lead, greeting, other) when triage was at least 80% confident; NULL otherwise.';
COMMENT ON COLUMN public.ai_agent_logs.triage_fast_path IS
  'TRUE when triage let the turn skip knowledge retrieval (small talk, handoff, or no knowledge needed); FALSE when triage ran and did not; NULL when triage did not run.';
COMMENT ON COLUMN public.ai_agent_logs.used_model IS
  'provider/model of the last model that answered, as logged in system_logs.metadata.used_model.';

CREATE OR REPLACE FUNCTION public.ai_agent_dashboard(p_days integer, p_platform text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_since timestamptz;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 90' USING ERRCODE = '22023';
  END IF;
  v_since := now() - make_interval(days => p_days);

  WITH attempts AS (
    -- Every non-sandbox row in the window. Tokens are summed over these: each
    -- attempt that reached a model was billed, retried or not.
    SELECT l.*
      FROM public.ai_agent_logs l
     WHERE l.user_id = v_uid
       AND l.created_at >= v_since
       AND COALESCE(l.status, '') <> 'test'
       AND (p_platform IS NULL OR l.platform = p_platform)
  ),
  items AS (
    -- One row per work item. Rows sharing an idempotency_key (outbox id) are
    -- retries, redeliveries or recovery notes for the same inbound message;
    -- the latest one is that item's final outcome.
    SELECT DISTINCT ON (COALESCE(a.idempotency_key, a.id::text)) a.*
      FROM attempts a
     ORDER BY COALESCE(a.idempotency_key, a.id::text), a.created_at DESC, a.id DESC
  ),
  classified AS (
    SELECT i.*,
           -- The escalate_to_human check comes first and is not limited to 'sent':
           -- a model that escalates and then writes no closing text is logged as
           -- skipped/no_reply_generated with the tool call on the row, and that is
           -- still a handoff.
           CASE
             WHEN jsonb_typeof(i.tool_calls) = 'array'
                  AND jsonb_path_exists(i.tool_calls, '$[*] ? (@.name == "escalate_to_human")')
               THEN 'escalated'
             WHEN i.status = 'escalated_after_model_exhaustion' THEN 'escalated'
             WHEN i.status = 'sent' THEN 'answered'
             WHEN i.status = 'skipped' THEN 'skipped'
             WHEN i.status IN ('error', 'model_exhaustion_unhandled', 'recovery_failed', 'delivery_unknown')
               THEN 'error'
             ELSE 'other'
           END AS outcome
      FROM items i
  ),
  outcome_groups AS (
    SELECT GROUPING(c.platform, c.social_account_id) AS grp,
           c.platform,
           c.social_account_id,
           count(*)                                          AS items,
           count(*) FILTER (WHERE c.outcome = 'answered')    AS answered,
           count(*) FILTER (WHERE c.outcome = 'escalated')   AS escalated,
           count(*) FILTER (WHERE c.outcome = 'skipped')     AS skipped,
           count(*) FILTER (WHERE c.outcome = 'error')       AS errors,
           count(*) FILTER (WHERE c.outcome = 'other')       AS other,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY c.latency_ms)
             FILTER (WHERE c.status = 'sent' AND c.latency_ms IS NOT NULL) AS latency_p50_ms,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY c.latency_ms)
             FILTER (WHERE c.status = 'sent' AND c.latency_ms IS NOT NULL) AS latency_p90_ms,
           count(*) FILTER (WHERE c.triage_fast_path IS TRUE)     AS fast_path,
           count(*) FILTER (WHERE c.triage_fast_path IS NOT NULL) AS triaged
      FROM classified c
     GROUP BY GROUPING SETS ((), (c.platform, c.social_account_id))
  ),
  token_groups AS (
    SELECT GROUPING(a.platform, a.social_account_id) AS grp,
           a.platform,
           a.social_account_id,
           COALESCE(sum(a.prompt_tokens), 0)     AS prompt_tokens,
           COALESCE(sum(a.completion_tokens), 0) AS completion_tokens
      FROM attempts a
     GROUP BY GROUPING SETS ((), (a.platform, a.social_account_id))
  ),
  merged AS (
    SELECT o.*,
           COALESCE(t.prompt_tokens, 0)     AS prompt_tokens,
           COALESCE(t.completion_tokens, 0) AS completion_tokens
      FROM outcome_groups o
      LEFT JOIN token_groups t
        ON t.grp = o.grp
       AND t.platform IS NOT DISTINCT FROM o.platform
       AND t.social_account_id IS NOT DISTINCT FROM o.social_account_id
  )
  SELECT jsonb_build_object(
    'days', p_days,
    'since', v_since,
    'platform', p_platform,
    'totals', COALESCE(
      (SELECT to_jsonb(m) - 'grp' - 'platform' - 'social_account_id' FROM merged m WHERE m.grp = 3),
      jsonb_build_object(
        'items', 0, 'answered', 0, 'escalated', 0, 'skipped', 0, 'errors', 0, 'other', 0,
        'latency_p50_ms', NULL, 'latency_p90_ms', NULL, 'fast_path', 0, 'triaged', 0,
        'prompt_tokens', 0, 'completion_tokens', 0)),
    'accounts', COALESCE(
      (SELECT jsonb_agg(to_jsonb(m) - 'grp' ORDER BY m.items DESC, m.platform, m.social_account_id)
         FROM merged m WHERE m.grp = 0),
      '[]'::jsonb),
    'skip_reasons', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n) ORDER BY r.n DESC, r.reason)
         FROM (SELECT COALESCE(c.error, 'unknown') AS reason, count(*) AS n
                 FROM classified c WHERE c.outcome = 'skipped' GROUP BY 1) r),
      '[]'::jsonb),
    'intents', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('intent', x.intent, 'count', x.n) ORDER BY x.n DESC, x.intent)
         FROM (SELECT c.intent, count(*) AS n
                 FROM classified c WHERE c.intent IS NOT NULL GROUP BY 1) x),
      '[]'::jsonb),
    'models', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
                'model', mm.used_model,
                'prompt_tokens', mm.p,
                'completion_tokens', mm.c) ORDER BY mm.p + mm.c DESC, mm.used_model)
         FROM (SELECT a.used_model,
                      COALESCE(sum(a.prompt_tokens), 0)     AS p,
                      COALESCE(sum(a.completion_tokens), 0) AS c
                 FROM attempts a
                WHERE a.used_model IS NOT NULL
                GROUP BY 1) mm),
      '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.ai_agent_dashboard(integer, text) IS
  'AI agent dashboard aggregates for the caller over the last p_days (1-90), optionally one platform. Outcome counts and latency are per work item (rows sharing idempotency_key count once, latest wins); tokens are per attempt. Sandbox (status=test) rows are excluded.';

REVOKE ALL ON FUNCTION public.ai_agent_dashboard(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_agent_dashboard(integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.ai_agent_dashboard(integer, text) TO authenticated;

-- Self-hosted PostgREST caches the schema; a new RPC stays invisible to the API
-- until it is told to reload.
NOTIFY pgrst, 'reload schema';
