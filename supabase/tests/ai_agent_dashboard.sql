-- ============================================================================
-- ai_agent_dashboard.sql — AI agent dashboard RPC (20260926100000)
--
-- Proves, for public.ai_agent_dashboard(p_days, p_platform):
--   D1 rows sharing an idempotency_key count once, and the LATEST row is the
--      work item's outcome (an error followed by a sent retry counts as one
--      answered reply, not one error plus one reply);
--   D2 sandbox rows (status = 'test') are excluded everywhere, tokens included;
--   D3 any row whose tool_calls include escalate_to_human counts as escalated
--      (a sent reply, or a no_reply_generated skip), and so does
--      escalated_after_model_exhaustion;
--   D4 skip reasons are grouped by the error column;
--   D5 median and p90 latency are over sent replies only (percentile_cont);
--   D6 tokens are summed per attempt, not per work item;
--   D7 intents and the triage fast-path counts come from the new columns;
--   D8 the per-account breakdown carries platform + social_account_id;
--   D9 another user's rows are invisible, and the window/platform filters hold;
--   D10 p_days outside 1..90 is refused; only `authenticated` holds EXECUTE.
--
-- Run with psql AS A SUPERUSER against the throwaway database created by
-- scripts/db-harness.sh, with every migration applied. NEVER against
-- production. Self-cleaning.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== ai_agent_dashboard: start ==='

CREATE TEMP TABLE aad_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO aad_ids VALUES
  ('owner',    'aad00000-aad0-4000-8000-000000000001'),
  ('stranger', 'aad00000-aad0-4000-8000-000000000002'),
  ('acct_a',   'aad00000-aad0-4000-8000-0000000000a1'),
  ('acct_b',   'aad00000-aad0-4000-8000-0000000000b1');

CREATE OR REPLACE FUNCTION pg_temp.aad_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_us uuid[] := ARRAY(SELECT id FROM aad_ids WHERE k IN ('owner', 'stranger'));
BEGIN
  DELETE FROM public.ai_agent_logs WHERE user_id = ANY(v_us);
  DELETE FROM auth.users WHERE id = ANY(v_us);
END $$;

SELECT pg_temp.aad_cleanup();

CREATE OR REPLACE FUNCTION pg_temp.aad_act_as(p_user UUID) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), false)::void;
$$;

CREATE OR REPLACE FUNCTION pg_temp.aad_must(p_cond BOOLEAN, p_label TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_label; END IF;
END $$;

INSERT INTO auth.users (id, email) VALUES
  ((SELECT id FROM aad_ids WHERE k = 'owner'),    'aad-owner@example.invalid'),
  ((SELECT id FROM aad_ids WHERE k = 'stranger'), 'aad-stranger@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- Fixture. Account A (whatsapp) and account B (facebook), all for the owner.
INSERT INTO public.ai_agent_logs
  (user_id, platform, social_account_id, conversation_id, status, error, latency_ms,
   prompt_tokens, completion_tokens, tool_calls, idempotency_key, intent, triage_fast_path,
   used_model, created_at)
SELECT o.id, v.platform, a.id, v.conv, v.status, v.error, v.latency_ms,
       v.pt, v.ct, v.tools::jsonb, v.idem, v.intent, v.fast, v.model, now() - v.age
  FROM (SELECT id FROM aad_ids WHERE k = 'owner') o
  CROSS JOIN (VALUES
    -- D1: one work item, first an error, then a sent retry 1 minute later.
    ('acct_a', 'whatsapp', 'c1', 'error', 'boom', 500, NULL::int, NULL::int, NULL, 'outbox-1', NULL, NULL::boolean, NULL, interval '2 days 1 minute'),
    ('acct_a', 'whatsapp', 'c1', 'sent', NULL, 1000, 100, 20, '[]', 'outbox-1', 'pricing', FALSE, 'openrouter/openai/gpt-4o-mini', interval '2 days'),
    -- plain answered replies without idempotency keys
    ('acct_a', 'whatsapp', 'c2', 'sent', NULL, 2000, 200, 30, NULL, NULL, 'pricing', TRUE, 'openrouter/openai/gpt-4o-mini', interval '1 day'),
    ('acct_a', 'whatsapp', 'c3', 'sent', NULL, 3000, 300, 40, NULL, NULL, 'greeting', TRUE, 'openrouter/openai/gpt-4o-mini', interval '1 day'),
    -- D3: escalated through the tool, and through the model-outage floor
    ('acct_b', 'facebook', 'c4', 'sent', NULL, 4000, 400, 50, '[{"name":"escalate_to_human","arguments":{}}]', NULL, 'complaint', FALSE, 'openai/gpt-4o', interval '1 day'),
    ('acct_b', 'facebook', 'c5', 'escalated_after_model_exhaustion', 'all models failed', 9000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, interval '1 day'),
    -- D3: escalated, then no closing text: logged as a skip, still a handoff
    ('acct_b', 'facebook', 'c11', 'skipped', 'no_reply_generated', 800, 50, 5, '[{"name":"escalate_to_human","arguments":{}}]', NULL, NULL, NULL, NULL, interval '1 day'),
    -- D4: skips
    ('acct_b', 'facebook', 'c6', 'skipped', 'human_assigned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, interval '1 day'),
    ('acct_b', 'facebook', 'c7', 'skipped', 'human_assigned', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, interval '1 day'),
    ('acct_b', 'facebook', 'c8', 'skipped', 'cooldown', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, interval '1 day'),
    -- D2: sandbox run, must vanish entirely (tokens included)
    ('acct_a', 'whatsapp', 'c9', 'test', NULL, 100, 99999, 99999, NULL, NULL, 'lead', TRUE, 'sandbox/test-only', interval '1 day'),
    -- D9: outside the 7-day window, inside the 30-day one
    ('acct_a', 'whatsapp', 'c10', 'sent', NULL, 5000, 10, 1, NULL, NULL, NULL, NULL, NULL, interval '10 days')
  ) AS v(acct, platform, conv, status, error, latency_ms, pt, ct, tools, idem, intent, fast, model, age)
  JOIN aad_ids a ON a.k = v.acct;

-- D9: the stranger's rows must never appear in the owner's dashboard.
INSERT INTO public.ai_agent_logs (user_id, platform, conversation_id, status, latency_ms, prompt_tokens, completion_tokens)
SELECT id, 'whatsapp', 'x1', 'sent', 1, 77777, 77777 FROM aad_ids WHERE k = 'stranger';

DO $d$
DECLARE
  v_owner uuid := (SELECT id FROM aad_ids WHERE k = 'owner');
  v_acct_a text := (SELECT id::text FROM aad_ids WHERE k = 'acct_a');
  v jsonb;
  t jsonb;
  acct jsonb;
BEGIN
  PERFORM pg_temp.aad_act_as(v_owner);
  v := public.ai_agent_dashboard(7);
  t := v -> 'totals';

  -- D1 + D2 + D9: 12 owner rows - 1 duplicate - 1 test - 1 out of window = 9 items.
  PERFORM pg_temp.aad_must((t ->> 'items')::int = 9, 'D1 items de-duplicated to 9, got ' || (t ->> 'items'));
  PERFORM pg_temp.aad_must((t ->> 'answered')::int = 3, 'D1 answered = 3 (retry counts once), got ' || (t ->> 'answered'));
  PERFORM pg_temp.aad_must((t ->> 'errors')::int = 0, 'D1 superseded error is not counted, got ' || (t ->> 'errors'));
  -- D3
  PERFORM pg_temp.aad_must((t ->> 'escalated')::int = 3, 'D3 escalated = 3 (tool on a sent reply and on a skip, plus the outage floor), got ' || (t ->> 'escalated'));
  -- D4
  PERFORM pg_temp.aad_must((t ->> 'skipped')::int = 3, 'D4 skipped = 3');
  PERFORM pg_temp.aad_must(v -> 'skip_reasons' -> 0 = '{"reason":"human_assigned","count":2}'::jsonb,
    'D4 top skip reason is human_assigned x2, got ' || (v -> 'skip_reasons')::text);
  -- D5: sent latencies 1000, 2000, 3000, 4000 -> p50 2500, p90 3700.
  PERFORM pg_temp.aad_must((t ->> 'latency_p50_ms')::numeric = 2500, 'D5 p50 = 2500, got ' || (t ->> 'latency_p50_ms'));
  PERFORM pg_temp.aad_must((t ->> 'latency_p90_ms')::numeric = 3700, 'D5 p90 = 3700, got ' || (t ->> 'latency_p90_ms'));
  -- D6: 100+200+300+400+50 prompt, 20+30+40+50+5 completion; the test row's 99999 excluded.
  PERFORM pg_temp.aad_must((t ->> 'prompt_tokens')::int = 1050, 'D6 prompt tokens = 1050, got ' || (t ->> 'prompt_tokens'));
  PERFORM pg_temp.aad_must((t ->> 'completion_tokens')::int = 145, 'D6 completion tokens = 145');
  -- D7
  PERFORM pg_temp.aad_must(v -> 'intents' -> 0 = '{"intent":"pricing","count":2}'::jsonb,
    'D7 top intent pricing x2, got ' || (v -> 'intents')::text);
  PERFORM pg_temp.aad_must((t ->> 'fast_path')::int = 2 AND (t ->> 'triaged')::int = 4,
    'D7 fast path 2 of 4 triaged, got ' || (t ->> 'fast_path') || '/' || (t ->> 'triaged'));
  PERFORM pg_temp.aad_must(jsonb_array_length(v -> 'models') = 2, 'D7 two models (test model excluded)');
  -- D8
  PERFORM pg_temp.aad_must(jsonb_array_length(v -> 'accounts') = 2, 'D8 two account rows');
  SELECT e INTO acct FROM jsonb_array_elements(v -> 'accounts') e WHERE e ->> 'social_account_id' = v_acct_a;
  PERFORM pg_temp.aad_must(acct ->> 'platform' = 'whatsapp' AND (acct ->> 'answered')::int = 3,
    'D8 account A: whatsapp, 3 answered, got ' || COALESCE(acct::text, 'null'));

  -- D9: window and platform filters.
  v := public.ai_agent_dashboard(30);
  PERFORM pg_temp.aad_must((v -> 'totals' ->> 'items')::int = 10, 'D9 30-day window includes the 10-day-old row');
  v := public.ai_agent_dashboard(7, 'facebook');
  PERFORM pg_temp.aad_must((v -> 'totals' ->> 'items')::int = 6, 'D9 facebook filter = 6 items, got ' || (v -> 'totals' ->> 'items'));

  -- D9: the stranger sees only their own single row.
  PERFORM pg_temp.aad_act_as((SELECT id FROM aad_ids WHERE k = 'stranger'));
  v := public.ai_agent_dashboard(7);
  PERFORM pg_temp.aad_must((v -> 'totals' ->> 'items')::int = 1, 'D9 stranger sees 1 item');
  PERFORM pg_temp.aad_must((v -> 'totals' ->> 'prompt_tokens')::int = 77777, 'D9 stranger sees only own tokens');

  -- Empty window: a real document, not NULL.
  PERFORM pg_temp.aad_act_as('aad00000-aad0-4000-8000-0000000000ff');
  v := public.ai_agent_dashboard(7);
  PERFORM pg_temp.aad_must((v -> 'totals' ->> 'items')::int = 0 AND v -> 'accounts' = '[]'::jsonb,
    'empty caller gets zero totals and no accounts, got ' || v::text);

  -- D10: bad window refused.
  BEGIN
    PERFORM public.ai_agent_dashboard(0);
    RAISE EXCEPTION 'ASSERTION FAILED: D10 p_days = 0 accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.ai_agent_dashboard(91);
    RAISE EXCEPTION 'ASSERTION FAILED: D10 p_days = 91 accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $d$;

-- D10: grant surface.
DO $g$
BEGIN
  PERFORM pg_temp.aad_must(
    NOT has_function_privilege('anon', 'public.ai_agent_dashboard(integer, text)', 'EXECUTE'),
    'D10 anon must not execute ai_agent_dashboard');
  PERFORM pg_temp.aad_must(
    has_function_privilege('authenticated', 'public.ai_agent_dashboard(integer, text)', 'EXECUTE'),
    'D10 authenticated executes ai_agent_dashboard');
END $g$;

-- D9 under RLS as well, not only the explicit filter: as `authenticated`.
SELECT pg_temp.aad_act_as((SELECT id FROM aad_ids WHERE k = 'owner'));
SET ROLE authenticated;
-- No pg_temp helpers in here: `authenticated` has no access to this session's
-- temp schema.
DO $r$
BEGIN
  IF (public.ai_agent_dashboard(7) -> 'totals' ->> 'items')::int IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: D9 owner as authenticated sees 9 items';
  END IF;
END $r$;
RESET ROLE;

SELECT pg_temp.aad_cleanup();
\echo '=== ai_agent_dashboard: PASS ==='
