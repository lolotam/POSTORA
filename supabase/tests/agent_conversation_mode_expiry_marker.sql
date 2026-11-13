-- supabase/tests/agent_conversation_mode_expiry_marker.sql
-- The escalation marker of an expired human_first window (migration
-- 20261113230000_agent_conversation_mode_expiry_marker.sql). One transaction, synthetic
-- fixtures, labelled E1..En ASSERTs, ROLLBACK, sentinel last. Assumes the migrations are
-- applied. No secrets and no real accounts.
--
-- The window and the marker are one fact: the apology for a window that ended unanswered is
-- made by the agent's next reply, and it is made once. The marker was written with an UPDATE
-- on the thread, while the turn itself upserts the thread -- so the two could run at the same
-- time and the marker could be written to a thread that did not exist yet. The marker is now
-- written the way the thread is:
--
--   c_fresh  a window that expires with no thread yet
--   c_kept   a window that expires for a thread that already carries a marker
BEGIN;
DO $$
DECLARE
  u_a uuid := 'a3a3a3a3-3331-4331-8331-cccccccccccc';
  u_b uuid := 'b4b4b4b4-4442-4442-8442-cccccccccccc';
  t_kept uuid := 'c5c5c5c5-0001-4001-8001-dddddddddddd';
  v_mode uuid := 'd6d6d6d6-0001-4001-8001-dddddddddddd';
  v_mode2 uuid := 'e7e7e7e7-0001-4001-8001-dddddddddddd';
  v_older timestamptz := now() - interval '9 hours';
  v_newer timestamptz := now() - interval '1 hour';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'expiry-marker-a-' || u_a::text || '@example.invalid'),
    (u_b, 'expiry-marker-b-' || u_b::text || '@example.invalid');

  INSERT INTO public.ai_threads (id, user_id, platform, conversation_id, unanswered_escalation_since)
  VALUES (t_kept, u_a, 'whatsapp', 'c_kept', v_older);

  INSERT INTO public.ai_conversation_modes (id, user_id, platform, conversation_id, mode, expires_at, escalated_at)
  VALUES
    (v_mode, u_a, 'whatsapp', 'c_fresh', 'human_first', now() - interval '1 minute', v_newer),
    (v_mode2, u_a, 'whatsapp', 'c_kept', 'human_first', now() - interval '1 minute', v_newer);

  -- E1: a window that expires with no thread yet leaves the marker. The thread is created
  -- with it, because the turn that would have created the thread runs at the same time.
  ASSERT public.expire_conversation_mode(v_mode, u_a, (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode)),
    'E1 the expired window is consumed';
  ASSERT (SELECT count(*) FROM public.ai_threads
          WHERE user_id = u_a AND platform = 'whatsapp' AND conversation_id = 'c_fresh') = 1,
    'E1 the thread exists';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads
          WHERE user_id = u_a AND platform = 'whatsapp' AND conversation_id = 'c_fresh') = v_newer,
    'E1 the marker is left behind';

  -- E2: the turn's own upsert finds the thread the expiry made and leaves the marker alone.
  INSERT INTO public.ai_threads (user_id, platform, conversation_id)
  VALUES (u_a, 'whatsapp', 'c_fresh')
  ON CONFLICT (user_id, platform, conversation_id)
  DO UPDATE SET platform = EXCLUDED.platform;
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads
          WHERE user_id = u_a AND platform = 'whatsapp' AND conversation_id = 'c_fresh') = v_newer,
    'E2 the marker survives the thread upsert';

  -- E3: an earlier marker is kept: staff replies since then still count.
  ASSERT public.expire_conversation_mode(v_mode2, u_a, (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode2)),
    'E3 the expired window is consumed';
  ASSERT (SELECT unanswered_escalation_since FROM public.ai_threads WHERE id = t_kept) = v_older,
    'E3 the earlier marker is kept';

  -- E4: the window is gone, and another tenant cannot expire it.
  ASSERT NOT EXISTS (SELECT 1 FROM public.ai_conversation_modes WHERE id = v_mode),
    'E4 the window is gone';
  ASSERT NOT public.expire_conversation_mode(v_mode, u_b, (SELECT expires_at FROM public.ai_conversation_modes WHERE id = v_mode)),
    'E4 a consumed window cannot be expired again';

  -- E5: only service_role reaches the function.
  ASSERT NOT has_function_privilege('anon', 'public.expire_conversation_mode(uuid, uuid, timestamptz)', 'EXECUTE'),
    'E5 anon cannot expire a window';
  ASSERT NOT has_function_privilege('authenticated', 'public.expire_conversation_mode(uuid, uuid, timestamptz)', 'EXECUTE'),
    'E5 authenticated cannot expire a window';
  ASSERT has_function_privilege('service_role', 'public.expire_conversation_mode(uuid, uuid, timestamptz)', 'EXECUTE'),
    'E5 service_role can expire a window';
END $$;

ROLLBACK;
\echo '=== agent_conversation_mode_expiry_marker: ALL CHECKS PASSED ==='
