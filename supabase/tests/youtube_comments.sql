-- ============================================================================
-- youtube_comments.sql — YouTube joins the comment surfaces (Slice B)
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
-- Mirrors supabase/tests/comment_workflow.sql.
--
-- What it is here to prove, in order:
--   1. a platform = 'youtube' row inserts into each of the seven widened tables
--   2. cwr_youtube_has_no_dm rejects a youtube rule carrying DM copy
--   2b. the widening kept cwr_threads_has_no_dm and the platform CHECK, and a
--       threads rule with DM copy is still rejected
--   3. the poll-youtube-comments cron job exists on a 5-minute schedule
--   4. the feature_youtube_comments flag ships off
-- ============================================================================

\set ON_ERROR_STOP on
\echo '=== youtube_comments: start ==='

CREATE TEMP TABLE yt_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO yt_ids VALUES
  ('acct_yt', '77777777-7777-4777-8777-777777777701'),
  ('acct_th', '77777777-7777-4777-8777-777777777702'),
  ('evt',     '77777777-7777-4777-8777-777777777711'),
  ('mar',     '77777777-7777-4777-8777-777777777712'),
  ('cfg',     '77777777-7777-4777-8777-777777777713'),
  ('mode',    '77777777-7777-4777-8777-777777777714'),
  ('thread',  '77777777-7777-4777-8777-777777777715'),
  ('log',     '77777777-7777-4777-8777-777777777716'),
  ('rule',    '77777777-7777-4777-8777-777777777717');

CREATE OR REPLACE FUNCTION pg_temp.yt_cleanup() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Dependents first: the rules, events and configs name their account through
  -- composite keys, so the accounts go last.
  DELETE FROM public.comment_workflow_rules WHERE id IN (SELECT id FROM yt_ids WHERE k = 'rule');
  DELETE FROM public.social_inbox_events WHERE id IN (SELECT id FROM yt_ids WHERE k = 'evt');
  DELETE FROM public.ai_agent_configs WHERE id IN (SELECT id FROM yt_ids WHERE k = 'cfg');
  DELETE FROM public.ai_conversation_modes WHERE id IN (SELECT id FROM yt_ids WHERE k = 'mode');
  DELETE FROM public.ai_threads WHERE id IN (SELECT id FROM yt_ids WHERE k = 'thread');
  DELETE FROM public.ai_agent_logs WHERE id IN (SELECT id FROM yt_ids WHERE k = 'log');
  DELETE FROM public.messenger_auto_replies WHERE id IN (SELECT id FROM yt_ids WHERE k = 'mar');
  DELETE FROM public.social_accounts WHERE id IN (SELECT id FROM yt_ids WHERE k IN ('acct_yt', 'acct_th'));
END $$;

SELECT pg_temp.yt_cleanup();

-- Every row below is owned by the one auth.users row the harness seeds; the
-- comment_workflow_rules and ai_agent_configs rows additionally name the
-- youtube account through their composite (id, user_id, platform) keys, so the
-- account row they point at must itself be platform = 'youtube'.
INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username, access_token, is_active)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'acct_yt'), (SELECT id FROM auth.users LIMIT 1),
   'youtube', 'yt-comments-suite', 'YT Suite', 'seed-yt', true),
  ((SELECT id FROM yt_ids WHERE k = 'acct_th'), (SELECT id FROM auth.users LIMIT 1),
   'threads', 'yt-comments-suite-th', 'YT Suite TH', 'seed-th', true)
ON CONFLICT (id) DO NOTHING;


-- (1) A youtube row inserts into each of the seven widened tables. Under
--     ON_ERROR_STOP any rejection aborts the suite; the DO block pins the cause.
INSERT INTO public.social_inbox_events
  (id, user_id, social_account_id, platform, event_type, external_event_id, payload)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'evt'), (SELECT id FROM auth.users LIMIT 1),
   (SELECT id FROM yt_ids WHERE k = 'acct_yt'), 'youtube', 'comment', 'yt-comment-1', '{}'::jsonb);

INSERT INTO public.messenger_auto_replies
  (id, user_id, platform, name, rule_type, reply_message)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'mar'), (SELECT id FROM auth.users LIMIT 1),
   'youtube', 'yt rule', 'keyword', 'thanks');

INSERT INTO public.ai_agent_configs
  (id, user_id, platform, social_account_id)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'cfg'), (SELECT id FROM auth.users LIMIT 1),
   'youtube', (SELECT id FROM yt_ids WHERE k = 'acct_yt'));

INSERT INTO public.ai_conversation_modes
  (id, user_id, platform, conversation_id, mode)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'mode'), (SELECT id FROM auth.users LIMIT 1),
   'youtube', 'yt-conv-1', 'ai_first');

INSERT INTO public.ai_threads
  (id, user_id, platform, conversation_id)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'thread'), (SELECT id FROM auth.users LIMIT 1),
   'youtube', 'yt-conv-1');

INSERT INTO public.ai_agent_logs
  (id, user_id, platform)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'log'), (SELECT id FROM auth.users LIMIT 1), 'youtube');

-- match_type 'any' with a public reply satisfies every rule CHECK except the
-- platform allow-list, so only the widened CHECK can be what admits this row.
INSERT INTO public.comment_workflow_rules
  (id, user_id, social_account_id, platform, name, match_type, keywords, public_replies)
VALUES
  ((SELECT id FROM yt_ids WHERE k = 'rule'), (SELECT id FROM auth.users LIMIT 1),
   (SELECT id FROM yt_ids WHERE k = 'acct_yt'), 'youtube', 'yt funnel', 'any', '{}', '{thanks}');

DO $youtube_inserts$
BEGIN
  IF NOT ((SELECT count(*) FROM public.social_inbox_events WHERE id = (SELECT id FROM yt_ids WHERE k = 'evt') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: social_inbox_events rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.messenger_auto_replies WHERE id = (SELECT id FROM yt_ids WHERE k = 'mar') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: messenger_auto_replies rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.ai_agent_configs WHERE id = (SELECT id FROM yt_ids WHERE k = 'cfg') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: ai_agent_configs rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.ai_conversation_modes WHERE id = (SELECT id FROM yt_ids WHERE k = 'mode') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: ai_conversation_modes rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.ai_threads WHERE id = (SELECT id FROM yt_ids WHERE k = 'thread') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: ai_threads rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.ai_agent_logs WHERE id = (SELECT id FROM yt_ids WHERE k = 'log') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: ai_agent_logs rejects platform youtube'; END IF;
  IF NOT ((SELECT count(*) FROM public.comment_workflow_rules WHERE id = (SELECT id FROM yt_ids WHERE k = 'rule') AND platform = 'youtube') = 1) THEN RAISE EXCEPTION 'youtube_comments: comment_workflow_rules rejects platform youtube'; END IF;
END $youtube_inserts$;
\echo 'PASS 1: platform youtube inserts into all seven widened tables'


-- (2) YouTube has no private messages: a youtube rule carrying DM copy is refused.
DO $youtube_no_dm$
DECLARE
  v_rejected BOOLEAN := FALSE;
  v_con TEXT := '';
BEGIN
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES
      ((SELECT id FROM auth.users LIMIT 1), (SELECT id FROM yt_ids WHERE k = 'acct_yt'),
       'youtube', 'yt dm funnel', 'any', '{}', '{hi}', 'x');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    v_rejected := (v_con = 'cwr_youtube_has_no_dm');
  END;
  IF NOT (v_rejected) THEN RAISE EXCEPTION 'youtube_comments: youtube rule with dm_message was not rejected by cwr_youtube_has_no_dm (constraint: %)', v_con; END IF;
END $youtube_no_dm$;
\echo 'PASS 2: cwr_youtube_has_no_dm rejects a youtube rule carrying DM copy'


-- (2b) The lookup-and-replace must never have dropped the wrong constraint:
--      comment_workflow_rules still carries both the threads no-DM rule and the
--      platform allow-list, and a threads DM rule is still refused.
DO $threads_survived$
BEGIN
  IF NOT ((SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.comment_workflow_rules'::regclass AND conname IN ('cwr_threads_has_no_dm', 'comment_workflow_rules_platform_check')) = 2) THEN RAISE EXCEPTION 'youtube_comments: comment_workflow_rules lost cwr_threads_has_no_dm or its platform check in the widening'; END IF;
END $threads_survived$;

DO $threads_no_dm$
DECLARE
  v_rejected BOOLEAN := FALSE;
  v_con TEXT := '';
BEGIN
  BEGIN
    INSERT INTO public.comment_workflow_rules
      (user_id, social_account_id, platform, name, match_type, keywords, public_replies, dm_message)
    VALUES
      ((SELECT id FROM auth.users LIMIT 1), (SELECT id FROM yt_ids WHERE k = 'acct_th'),
       'threads', 'threads dm funnel', 'any', '{}', '{hi}', 'x');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    v_rejected := (v_con = 'cwr_threads_has_no_dm');
  END;
  IF NOT (v_rejected) THEN RAISE EXCEPTION 'youtube_comments: threads rule with dm_message was not rejected by cwr_threads_has_no_dm (constraint: %)', v_con; END IF;
END $threads_no_dm$;
\echo 'PASS 2b: cwr_threads_has_no_dm survived and still rejects a threads DM rule'


-- (3) The poller is scheduled every five minutes.
DO $cron$
BEGIN
  IF NOT ((SELECT count(*) FROM cron.job WHERE jobname = 'poll-youtube-comments' AND schedule = '*/5 * * * *') = 1) THEN RAISE EXCEPTION 'youtube_comments: poll-youtube-comments cron job missing or mis-scheduled'; END IF;
END $cron$;
\echo 'PASS 3: poll-youtube-comments is scheduled every five minutes'


-- (4) The flag ships off.
DO $flag$
BEGIN
  IF NOT ((SELECT count(*) FROM public.app_settings WHERE key = 'feature_youtube_comments' AND value = 'false'::jsonb) = 1) THEN RAISE EXCEPTION 'youtube_comments: feature_youtube_comments flag missing or not off'; END IF;
END $flag$;
\echo 'PASS 4: the feature flag ships off'

SELECT pg_temp.yt_cleanup();
\echo '=== youtube_comments: ALL CHECKS PASSED ==='
