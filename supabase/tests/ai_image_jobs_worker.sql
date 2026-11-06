-- ============================================================================
-- supabase/tests/ai_image_jobs_worker.sql
-- Phase B (migration 20261107120000_ai_image_jobs_worker.sql).
-- One transaction, labelled ASSERTs, ROLLBACK, sentinel last.
--   W1  the migration applies twice; each cron exists once
--   W2  claims return distinct jobs, oldest first
--   W3  a claim sets running, a fresh token, claimed_at, attempts+1
--   W4  an expired, undispatched lease is re-claimed with a NEW token
--   W5  an expired, dispatched lease fails as ai_interrupted, never re-claimed
--   W6  an expired lease with attempts >= 3 fails as ai_attempts_exhausted
--   W7  a job queued > 5 minutes times out as ai_queue_timeout
--   W8  complete with a stale token writes nothing and returns false
--   W9  complete with the live token writes job + payload once
--   W10 video rows and sync image rows are never claimed
--   W11 owner-only SELECT; authenticated cannot read payloads or run the RPCs
--   W12 jobs are in supabase_realtime, payloads are not
--   W13 cron commands resolve the secret at run time
--   W14 an orphan (no payload) older than a healthy job neither blocks it nor survives
--   W15 at most p_max_per_user running worker jobs per user; other users unaffected
--   W16 a running worker row whose payload was purged fails without a worker call
--   W17 delayed reclaims cannot extend the server lifetime beyond the client deadline
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _cron_before AS SELECT jobname, schedule, command FROM cron.job;

\ir ../migrations/20261107120000_ai_image_jobs_worker.sql
\ir ../migrations/20261107120000_ai_image_jobs_worker.sql

DO $t$
DECLARE
  u_a uuid := 'b1b1b1b1-1111-4111-8111-b1b1b1b1b1b1';
  u_b uuid := 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';
  u_c uuid := 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3';
  j1 uuid; j2 uuid; j3 uuid; orphan uuid; healthy uuid;
  r1 public.ai_generation_jobs; r2 public.ai_generation_jobs;
  tok uuid; n int; ok boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (u_a, 'ai-image-worker-a@example.invalid'),
    (u_b, 'ai-image-worker-b@example.invalid'),
    (u_c, 'ai-image-worker-c@example.invalid');

  j1 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"a"}',
          '[{"url":"data:image/png;base64,AAAA","type":"style","priority":1}]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '2 minutes' WHERE id = j1;
  j2 := public.enqueue_ai_image_job(u_a, 'gpt-image-1', '{"prompt":"b"}', '[]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '1 minute' WHERE id = j2;
  ASSERT (SELECT provider = 'postora' AND model_id = 'auto' AND credential_source = 'platform' AND status = 'queued'
            AND params->>'worker' = 'true' FROM public.ai_generation_jobs WHERE id = j1), 'enqueue writes placeholders + marker';
  ASSERT (SELECT model_id FROM public.ai_generation_jobs WHERE id = j2) = 'gpt-image-1', 'enqueue keeps the requested model';
  ASSERT EXISTS (SELECT 1 FROM public.ai_image_job_payloads WHERE job_id = j1), 'enqueue writes the payload in the same call';

  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, provider_job_id, params)
  VALUES (u_a, 'higgsfield', 'v', 'video', 'platform', 'queued', 'pj-1', '{}');
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, result_url, params)
  VALUES (u_a, 'higgsfield', 'i', 'image', 'platform', 'succeeded', 'https://x.invalid/i.png', '{"prompt":"s"}');

  -- W2/W3
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT * INTO r2 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1 AND r2.id = j2, 'W2: oldest first, distinct jobs';
  ASSERT r1.status = 'running' AND r1.claim_token IS NOT NULL AND r1.claimed_at IS NOT NULL AND r1.attempts = 1, 'W3';
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(5, interval '3 minutes');
  ASSERT n = 0, 'W10: video and sync rows are never claimed';

  -- W4
  tok := r1.claim_token;
  UPDATE public.ai_generation_jobs SET claimed_at = now() - interval '4 minutes' WHERE id = j1;
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = j1 AND r1.claim_token <> tok AND r1.attempts = 2, 'W4';

  -- W8
  SELECT public.complete_ai_image_job(j1, tok, 'succeeded', 'https://x.invalid/stale.png', NULL, NULL, 'google', 'm', 'platform', '{}') INTO ok;
  ASSERT ok IS FALSE AND (SELECT status FROM public.ai_generation_jobs WHERE id = j1) = 'running', 'W8';

  -- W9
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'succeeded', NULL, 'data:image/png;base64,BBBB', NULL,
    'google', 'gemini-2.5-flash-image', 'platform', '{"description":"ok"}') INTO ok;
  ASSERT ok, 'W9: live token completes';
  ASSERT (SELECT status = 'succeeded' AND provider = 'google' AND claim_token IS NULL AND params->>'worker' = 'true'
            FROM public.ai_generation_jobs WHERE id = j1), 'W9: job written, marker kept';
  ASSERT (SELECT reference_images = '[]'::jsonb AND result_data_url = 'data:image/png;base64,BBBB'
            FROM public.ai_image_job_payloads WHERE job_id = j1), 'W9: payload written, references cleared';
  SELECT public.complete_ai_image_job(j1, r1.claim_token, 'failed', NULL, NULL, 'x', NULL, NULL, NULL, '{}') INTO ok;
  ASSERT ok IS FALSE, 'W9: completes once';

  -- W5: standalone sweep works even when the edge worker is down.
  UPDATE public.ai_generation_jobs SET dispatched_at = now() - interval '4 minutes', claimed_at = now() - interval '4 minutes' WHERE id = j2;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_interrupted' FROM public.ai_generation_jobs WHERE id = j2), 'W5';

  -- W6
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"c"}', '[]');
  UPDATE public.ai_generation_jobs SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 3,
         claim_token = gen_random_uuid() WHERE id = j3;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_attempts_exhausted' FROM public.ai_generation_jobs WHERE id = j3), 'W6';

  -- W7
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"d"}', '[]');
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '4 minutes 59 seconds' WHERE id = j3;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'queued' FROM public.ai_generation_jobs WHERE id = j3), 'W7: keep the full five-minute queue window';
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '5 minutes 1 second' WHERE id = j3;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'timeout' AND params->>'error_code' = 'ai_queue_timeout' FROM public.ai_generation_jobs WHERE id = j3), 'W7';

  -- W16: payload purged before an undispatched lease can be reclaimed.
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"purged"}', '[]');
  UPDATE public.ai_generation_jobs SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 1,
         claim_token = gen_random_uuid() WHERE id = j3;
  DELETE FROM public.ai_image_job_payloads WHERE job_id = j3;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_payload_missing' AND claim_token IS NULL
            FROM public.ai_generation_jobs WHERE id = j3), 'W16: running orphan stops occupying the user cap';

  -- W17: delayed reclaims cannot extend the total lifetime beyond the browser deadline.
  j3 := public.enqueue_ai_image_job(u_a, NULL, '{"prompt":"delayed reclaim"}', '[]');
  UPDATE public.ai_generation_jobs SET status = 'running', claimed_at = now() - interval '4 minutes', attempts = 1,
         created_at = now() - interval '11 minutes 1 second', claim_token = gen_random_uuid() WHERE id = j3;
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1);
  ASSERT n = 0, 'W17: no late reclaim that could outlive the total age bound';
  UPDATE public.ai_generation_jobs SET created_at = now() - interval '14 minutes 1 second' WHERE id = j3;
  PERFORM public.sweep_ai_image_jobs();
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_attempts_exhausted'
            FROM public.ai_generation_jobs WHERE id = j3), 'W17: absolute age bound with attempts left';

  -- W14: orphan older than a healthy job (rows inserted directly; enqueue can no longer make one)
  INSERT INTO public.ai_generation_jobs (user_id, provider, model_id, modality, credential_source, status, params, created_at)
  VALUES (u_b, 'postora', 'auto', 'image', 'platform', 'queued', '{"worker":true}', now() - interval '5 minutes')
  RETURNING id INTO orphan;
  healthy := public.enqueue_ai_image_job(u_b, NULL, '{"prompt":"h"}', '[]');
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = healthy, 'W14: the healthy job is claimed despite the older orphan';
  ASSERT (SELECT status = 'failed' AND params->>'error_code' = 'ai_payload_missing' FROM public.ai_generation_jobs WHERE id = orphan),
    'W14: the orphan is settled as failed';

  -- W15: per-user cap (sequential claims; the advisory lock serialises concurrent ones the same way)
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c1"}', '[]');
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c2"}', '[]');
  PERFORM public.enqueue_ai_image_job(u_c, NULL, '{"prompt":"c3"}', '[]');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  SELECT count(*) INTO n FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs WHERE user_id = u_c AND status = 'running') = 2, 'W15: cap of 2 per user';
  ASSERT n = 0, 'W15: the third claim finds nothing for the capped user';
  healthy := public.enqueue_ai_image_job(u_b, NULL, '{"prompt":"other"}', '[]');
  SELECT * INTO r1 FROM public.claim_ai_image_jobs(1, interval '3 minutes');
  ASSERT r1.id = healthy, 'W15: another user is not blocked by the capped user';

  -- W12
  ASSERT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_generation_jobs'), 'W12a';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ai_image_job_payloads'), 'W12b';

  -- W11 grants
  ASSERT NOT has_function_privilege('authenticated', 'public.sweep_ai_image_jobs()', 'EXECUTE'), 'W11 sweep authenticated';
  ASSERT NOT has_function_privilege('anon', 'public.sweep_ai_image_jobs()', 'EXECUTE'), 'W11 sweep anon';
  ASSERT has_function_privilege('service_role', 'public.sweep_ai_image_jobs()', 'EXECUTE'), 'W11 sweep service_role';
  ASSERT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'] FROM pg_proc
            WHERE oid = 'public.sweep_ai_image_jobs()'::regprocedure), 'W11 sweep definer and search_path';
  ASSERT NOT has_function_privilege('authenticated', 'public.enqueue_ai_image_job(uuid, text, jsonb, jsonb)', 'EXECUTE'), 'W11 enqueue';
  ASSERT NOT has_function_privilege('authenticated', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 claim';
  ASSERT NOT has_function_privilege('anon', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 claim anon';
  ASSERT NOT has_function_privilege('authenticated',
    'public.complete_ai_image_job(uuid, uuid, text, text, text, text, text, text, text, jsonb)', 'EXECUTE'), 'W11 complete';
  ASSERT has_function_privilege('service_role', 'public.claim_ai_image_jobs(integer, interval, integer)', 'EXECUTE'), 'W11 service_role';
  ASSERT NOT has_table_privilege('authenticated', 'public.ai_image_job_payloads', 'SELECT'), 'W11 payloads';

  -- W1/W13
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'sweep-ai-image-jobs') = 1, 'W1 sweep cron once';
  ASSERT (SELECT schedule = '* * * * *' AND command = 'SELECT public.sweep_ai_image_jobs();'
            FROM cron.job WHERE jobname = 'sweep-ai-image-jobs'), 'W13 sweep is pure SQL every minute';
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'ai-image-worker') = 1, 'W1 worker cron once';
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'purge-ai-image-payloads') = 1, 'W1 purge cron once';
  ASSERT (SELECT schedule FROM cron.job WHERE jobname = 'ai-image-worker') = '* * * * *', 'W13 schedule';
  ASSERT (SELECT position('get_cron_secret()' in command) > 0 AND position('Bearer ' in command) > 0
            AND command !~ '''[A-Za-z0-9_-]{24,}''' AND command !~ '[A-Za-z0-9_-]{40,}'
            AND position('/functions/v1/ai-image-worker' in command) > 0
          FROM cron.job WHERE jobname = 'ai-image-worker'), 'W13 no literal secret';
  ASSERT NOT EXISTS (SELECT jobname, schedule, command FROM _cron_before EXCEPT SELECT jobname, schedule, command FROM cron.job),
    'W13 other jobs unchanged';
END
$t$;

-- W11 RLS
SELECT set_config('request.jwt.claims', '{"sub":"b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3', true);
SET LOCAL ROLE authenticated;
DO $rls$ BEGIN
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs WHERE user_id <> 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3') = 0,
    'W11: a user sees no one else''s jobs';
  ASSERT (SELECT count(*) FROM public.ai_generation_jobs) = 3, 'W11: a user sees their own jobs';
END $rls$;
RESET ROLE;

ROLLBACK;
\echo '=== ai_image_jobs_worker: ALL CHECKS PASSED ==='
