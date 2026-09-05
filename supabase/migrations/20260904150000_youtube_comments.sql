-- YouTube joins the comment surfaces. Every table below pins `platform` with a CHECK that
-- stops at 'threads'; each is widened by lookup on its definition, the way
-- 20260822180000_threads_agent_platform.sql did, because the inline constraints carry
-- generated names that differ between environments.
DO $migration$
DECLARE
  v_table text;
  v_conname text;
  v_allowed text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'social_inbox_events',
    'messenger_auto_replies',
    'ai_agent_configs',
    'ai_conversation_modes',
    'ai_threads',
    'ai_agent_logs',
    'comment_workflow_rules'
  ]
  LOOP
    v_allowed := CASE
      WHEN v_table IN ('messenger_auto_replies', 'comment_workflow_rules', 'social_inbox_events')
        THEN '''facebook'', ''instagram'', ''threads'', ''youtube'''
      ELSE '''whatsapp'', ''facebook'', ''instagram'', ''threads'', ''youtube'''
    END;

    -- Postgres renders `platform IN (...)` as `platform = ANY (ARRAY[...])`, and
    -- comment_workflow_rules has a second CHECK mentioning platform (cwr_threads_has_no_dm),
    -- so the match is on the ANY form and every match is dropped, not the first one found.
    FOR v_conname IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = format('public.%I', v_table)::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%platform = ANY%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (platform IN (%s))',
      v_table, v_table || '_platform_check', v_allowed
    );
  END LOOP;
END
$migration$;

-- YouTube has no private messages, exactly as Threads has none: a rule labelled youtube can
-- never carry DM copy or a file, whatever the form sends.
ALTER TABLE public.comment_workflow_rules
  DROP CONSTRAINT IF EXISTS cwr_youtube_has_no_dm,
  ADD CONSTRAINT cwr_youtube_has_no_dm
    CHECK (platform <> 'youtube' OR (dm_message IS NULL AND media_file_id IS NULL));

-- Every five minutes: one commentThreads.list per eligible channel (1 quota unit each against
-- Google's 10,000/day default), so 5 minutes keeps ~30 channels under budget.
DO $$
BEGIN
  PERFORM cron.unschedule('poll-youtube-comments');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'poll-youtube-comments',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/youtube-poll-comments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Off by default; admins receive every non-visibility flag regardless (useFeatureFlags).
INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_youtube_comments', 'false'::jsonb, 'YouTube comments (Comment Manager, agent, workflows)')
ON CONFLICT (key) DO NOTHING;
