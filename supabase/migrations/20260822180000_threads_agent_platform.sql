-- Threads gets the same agent surface Facebook and Instagram have: auto-reply rules, AI
-- agent config, per-conversation engagement modes, threads and logs. Every one of those
-- tables pins `platform` with an inline CHECK that predates Threads, so writing a Threads
-- row fails today no matter what the application code does.
--
-- The constraints were created inline with their tables, so their generated names are not
-- guaranteed to match across environments (prod was migrated by hand more than once). Each
-- is dropped by lookup on its definition rather than by name, the same way
-- 20260822120000_social_inbox_events_threads.sql widened social_inbox_events.
DO $migration$
DECLARE
  v_table text;
  v_conname text;
  v_allowed text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'messenger_auto_replies',
    'ai_agent_configs',
    'ai_conversation_modes',
    'ai_threads',
    'ai_agent_logs'
  ]
  LOOP
    -- messenger_auto_replies is a Meta-messaging table and never allowed 'whatsapp';
    -- the four ai_* tables did. Widening is strictly additive either way.
    v_allowed := CASE
      WHEN v_table = 'messenger_auto_replies' THEN '''facebook'', ''instagram'', ''threads'''
      ELSE '''whatsapp'', ''facebook'', ''instagram'', ''threads'''
    END;

    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = format('public.%I', v_table)::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%platform%';

    IF v_conname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_conname);
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (platform IN (%s))',
      v_table,
      v_table || '_platform_check',
      v_allowed
    );
  END LOOP;
END
$migration$;
