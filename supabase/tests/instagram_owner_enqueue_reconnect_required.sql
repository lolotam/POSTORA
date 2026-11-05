-- Real database contract for 20261104150000_instagram_owner_enqueue_reconnect_required.sql.
--
-- An owner sync request for an account without a capability record is
-- refused with reconnect_required: no job is written, the throttle window is
-- not spent and the refusal is audited. Once the account has a capability
-- record the same request is accepted, so the capability record is the only
-- thing the refusal depends on. Production incident 2026-11-04: curemedkw was
-- answered "queued" and its job was abandoned as context_missing.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email) VALUES
 ('f3110000-0000-4000-8000-000000000001','reconnect-required-owner@example.invalid');
INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active)
VALUES ('f3120000-0000-4000-8000-000000000001','f3110000-0000-4000-8000-000000000001','instagram','ig-reconnect-required','reconnect_required','synthetic-reconnect-token','facebook_page',true);
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_insights_enabled','true'::jsonb,'Synthetic reconnect fixture'),
('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"allowlist","account_ids":["f3120000-0000-4000-8000-000000000001"]},"competitors":{"mode":"off","targets":[]}}'::jsonb,'Synthetic reconnect fixture')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','f3110000-0000-4000-8000-000000000001',true);

DO $without_capability$
DECLARE v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_job('owner','f3120000-0000-4000-8000-000000000001','normal');
  ASSERT v_result->>'accepted' = 'false', 'an account without a capability record is not accepted: ' || v_result;
  ASSERT v_result->>'refused' = 'true', 'the answer is a definite refusal: ' || v_result;
  ASSERT v_result->>'reason_code' = 'reconnect_required', 'the refusal names reconnect_required: ' || v_result;
  ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000001'),
    'no job is written for an account that cannot be collected';
  ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_collection_request_throttles WHERE target_id='f3120000-0000-4000-8000-000000000001'),
    'the refusal does not spend the throttle window';
  ASSERT EXISTS(SELECT 1 FROM public.system_logs
    WHERE source='instagram-collection-rollout' AND user_id='f3110000-0000-4000-8000-000000000001'
      AND metadata->>'event'='collection_enqueue_refused' AND metadata->>'reason_code'='reconnect_required'),
    'the refusal is audited';
END $without_capability$;

INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES ('f3120000-0000-4000-8000-000000000001','f3110000-0000-4000-8000-000000000001','instagram','page_linked','ok',ARRAY['instagram_manage_insights'],now(),1);

DO $with_capability$
DECLARE v_result jsonb;
BEGIN
  v_result := public.enqueue_instagram_collection_job('owner','f3120000-0000-4000-8000-000000000001','normal');
  ASSERT v_result->>'accepted' = 'true', 'the same request is accepted once the capability record exists: ' || v_result;
  ASSERT v_result->>'reason' = 'enqueued', 'the accepted request created the job: ' || v_result;
END $with_capability$;

-- ===========================================================================
-- The context-missing loop (migration
-- 20261105200000_instagram_context_missing_settlement.sql).
--
-- Three proofs about the daily owner enqueue and the terminal settlement of
-- a job the claim could never bind:
--
--   1. the daily page enqueues the account WITH a capability row, skips the
--      account WITHOUT one, and audits the gap (one rollout-audit row per page);
--   2. a context-less owner job whose account has NO capability row is
--      settled once, as unavailable / capability_missing, with the lease
--      cleared, so it can never come back;
--   3. a context-less job whose account HAS a capability row is still refused
--      with IG_COLLECTION_CONTEXT_MISSING: that is a stale claim, not an
--      unenrolled account.
--
-- The fixture above had to enroll ...0001 to prove the refusal, and it left
-- a job for it. The blocks below need the opposite shape - ...0001 UNENROLLED
-- and ...0002 enrolled - so the capability row and the job of ...0001 are
-- removed here, and the policy is widened to 'owners: all' so the daily page
-- sees both synthetic accounts.
-- ===========================================================================

INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active)
VALUES ('f3120000-0000-4000-8000-000000000002','f3110000-0000-4000-8000-000000000001','instagram','ig-reconnect-required-second','reconnect_required_second','synthetic-reconnect-token','facebook_page',true);

-- The ENROLLED account of the blocks below, written the way
-- instagram_capabilities.sql writes one: a page-linked account whose
-- permission read already landed, at credential generation 1.
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
VALUES ('f3120000-0000-4000-8000-000000000002','f3110000-0000-4000-8000-000000000001','instagram','page_linked','ok',ARRAY['instagram_manage_insights'],now(),1);

-- ...0001 is now the account WITHOUT a capability row.
DELETE FROM public.instagram_account_capabilities WHERE social_account_id='f3120000-0000-4000-8000-000000000001';
DELETE FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000001';

-- The daily page is global: 'owners: all' admits both synthetic accounts.
-- The mode 'all' carries no id list, so the list is empty.
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_rollout_policy','{"version":1,"owners":{"mode":"all","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb,'Synthetic context-missing fixture')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

DO $daily_page_skips_unenrolled$
DECLARE v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  v_result := public.enqueue_instagram_collection_daily_page('owner', true);
  ASSERT (v_result->>'accepted')::boolean, 'the daily page is accepted: ' || v_result;
  ASSERT v_result ? 'skipped_reconnect_required' IS FALSE, 'the receipt carries no skipped key; the gap is audited instead: ' || v_result;
  ASSERT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000002' AND target_kind='owner'),
    'the account with a capability row is enqueued';
  ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000001'),
    'the account without a capability row gets no job';
  -- The gap is AUDITED, not returned: the receipt is a closed projection and
  -- it does not change.
  ASSERT EXISTS(
    SELECT 1 FROM public.system_logs
     WHERE source = 'instagram-collection-rollout'
       AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required'
       AND (metadata -> 'details' ->> 'skipped')::int = 1),
    'the skipped account is audited';
END $daily_page_skips_unenrolled$;

DO $contextless_owner_job_is_settled$
DECLARE v_job public.instagram_collection_jobs%ROWTYPE; v_claimed jsonb; v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  -- A job the OLD enqueue would have written: no context, account without a capability row.
  INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on,status,due_at)
  VALUES ('f3110000-0000-4000-8000-000000000001','owner','f3120000-0000-4000-8000-000000000001','f3120000-0000-4000-8000-000000000001',current_date,'queued',now()-interval '1 minute')
  RETURNING * INTO v_job;
  -- The claim answers in jsonb: the token and the generation are read from it.
  SELECT * INTO v_claimed
    FROM public.claim_instagram_collection_jobs('owner', 10) AS c
   WHERE c ->> 'job_id' = v_job.id::text;
  ASSERT v_claimed IS NOT NULL, 'the job is claimed';
  ASSERT (v_claimed -> 'context' ->> 'viewer_social_account_id') IS NULL,
    'the claim bound no context: the account has no capability row';
  v_result := public.complete_instagram_collection_job_capability_unavailable(v_job.id, (v_claimed->>'claim_token')::uuid, (v_claimed->>'job_generation')::bigint);
  ASSERT v_result->>'status' = 'unavailable' AND v_result->>'reason_code' = 'capability_missing', 'settled unavailable/capability_missing: ' || v_result;
  SELECT * INTO v_job FROM public.instagram_collection_jobs WHERE id = v_job.id;
  ASSERT v_job.status = 'unavailable' AND v_job.lease_token IS NULL AND v_job.lease_expires_at IS NULL AND v_job.last_reason_code = 'capability_missing',
    'the row is terminal with the lease cleared';
END $contextless_owner_job_is_settled$;

DO $contextless_job_with_capability_is_still_refused$
DECLARE v_job public.instagram_collection_jobs%ROWTYPE; v_claimed jsonb; v_refused boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on,status,due_at)
  VALUES ('f3110000-0000-4000-8000-000000000001','owner','f3120000-0000-4000-8000-000000000002','f3120000-0000-4000-8000-000000000002',current_date - 1,'queued',now()-interval '1 minute')
  RETURNING * INTO v_job;
  -- Blank the context the claim bound, as a stale claim would look.
  SELECT * INTO v_claimed
    FROM public.claim_instagram_collection_jobs('owner', 10) AS c
   WHERE c ->> 'job_id' = v_job.id::text;
  ASSERT v_claimed IS NOT NULL, 'the job is claimed';
  UPDATE public.instagram_collection_jobs SET context_viewer_social_account_id=NULL, context_credential_generation=NULL, context_login_kind=NULL WHERE id=v_job.id;
  BEGIN
    PERFORM public.complete_instagram_collection_job_capability_unavailable(v_job.id, (v_claimed->>'claim_token')::uuid, (v_claimed->>'job_generation')::bigint);
  EXCEPTION WHEN OTHERS THEN
    v_refused := split_part(SQLERRM, ':', 1) = 'IG_COLLECTION_CONTEXT_MISSING';
  END;
  ASSERT v_refused, 'a context-less job whose account has a capability row is still refused';
END $contextless_job_with_capability_is_still_refused$;

-- ===========================================================================
-- The window of a page (migration
-- 20261105200000_instagram_context_missing_settlement.sql, fix round 1).
--
-- The page reads a WINDOW: the first twenty five account ids after the
-- cursor. The enrolment decides what happens INSIDE the window, never which
-- rows the window is, so an unenrolled account consumes its slot and is
-- counted once. The page must never scan past an unenrolled account looking
-- for enrolled ones: that is an unbounded read.
--
-- The thirty accounts below make two pages, and every third one has NO
-- capability row: ten unenrolled and twenty enrolled. The first window
-- holds accounts one to twenty five (eight unenrolled, seventeen enrolled)
-- and the second holds the remaining five (two unenrolled, three enrolled).
-- ===========================================================================

INSERT INTO public.social_accounts(id,user_id,platform,platform_user_id,platform_username,access_token,ig_auth_type,is_active)
SELECT ('b0f30000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'f3110000-0000-4000-8000-000000000001', 'instagram',
       'ig-window-' || n, 'igwindow_' || n, 'synthetic-window-token-' || n,
       'facebook_page', true
  FROM generate_series(1, 30) AS n;

-- Two of every three accounts are ENROLLED; every third one is not.
INSERT INTO public.instagram_account_capabilities(social_account_id,user_id,platform,login_kind,permission_read_state,granted_scopes,scopes_read_at,credential_generation)
SELECT ('b0f30000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'f3110000-0000-4000-8000-000000000001', 'instagram', 'page_linked', 'ok',
       ARRAY['instagram_manage_insights'], now(), 1
  FROM generate_series(1, 30) AS n
 WHERE n % 3 <> 0;

-- The page sees exactly these thirty accounts.
INSERT INTO public.app_settings(key,value,description) VALUES
('collection_instagram_rollout_policy', jsonb_build_object(
   'version', 1,
   'owners', jsonb_build_object(
     'mode', 'allowlist',
     'account_ids', (SELECT jsonb_agg(('b0f30000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid::text ORDER BY n)
                        FROM generate_series(1, 30) AS n)),
   'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)),
 'Synthetic page-window fixture')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;

DO $page_window_is_bounded$
DECLARE
  v_page1 jsonb;
  v_page2 jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);

  -- The earlier page audited its own gap. This block counts ITS OWN rows.
  DELETE FROM public.system_logs
   WHERE source = 'instagram-collection-rollout'
     AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required';

  -- The first page reads exactly ONE window of twenty five ids.
  v_page1 := public.enqueue_instagram_collection_daily_page('owner', true);
  ASSERT (v_page1->>'scanned')::int = 25, 'the first page reads exactly one window: ' || v_page1;
  ASSERT (v_page1->>'enqueued')::int = 17, 'the enrolled accounts of the window are enqueued: ' || v_page1;
  ASSERT (v_page1->>'has_more')::boolean, 'a full window leaves more ids behind: ' || v_page1;

  -- The second page reads the remainder of the ids.
  v_page2 := public.enqueue_instagram_collection_daily_page('owner', false);
  ASSERT (v_page2->>'scanned')::int = 5, 'the second page reads the remainder: ' || v_page2;
  ASSERT (v_page2->>'enqueued')::int = 3, 'the enrolled accounts of the remainder are enqueued: ' || v_page2;
  ASSERT NOT (v_page2->>'has_more')::boolean, 'the last window ends the sweep: ' || v_page2;

  -- The gap of each page is audited, and the receipt does not carry it.
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_object_keys(v_page1) AS k WHERE k = 'skipped_reconnect_required'),
    'the receipt does not carry the gap';
  ASSERT (SELECT count(*) FROM public.system_logs
           WHERE source = 'instagram-collection-rollout'
             AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required'
             AND (metadata -> 'details' ->> 'skipped')::int = 8) = 1,
    'the first page audited its eight skipped accounts';
  ASSERT (SELECT count(*) FROM public.system_logs
           WHERE source = 'instagram-collection-rollout'
             AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required'
             AND (metadata -> 'details' ->> 'skipped')::int = 2) = 1,
    'the second page audited its two skipped accounts';

  -- Every unenrolled account is counted EXACTLY once across the two pages.
  ASSERT (SELECT COALESCE(sum((metadata -> 'details' ->> 'skipped')::int), 0)
            FROM public.system_logs
           WHERE source = 'instagram-collection-rollout'
             AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required') = 10,
    'the ten unenrolled accounts are audited once';

  -- The audit names the accounts that need a reconnect.
  ASSERT (SELECT count(*) FROM public.system_logs
           WHERE source = 'instagram-collection-rollout'
             AND metadata ->> 'event' = 'collection_daily_enqueue_skipped_reconnect_required'
             AND jsonb_array_length(metadata -> 'details' -> 'skipped_accounts')
               = (metadata -> 'details' ->> 'skipped')::int) = 2,
    'each audited page names its skipped accounts';

  -- No job for an unenrolled account.
  ASSERT NOT EXISTS (
    SELECT 1
      FROM public.instagram_collection_jobs AS j
      JOIN public.social_accounts AS sa ON sa.id = j.social_account_id
     WHERE j.user_id = 'f3110000-0000-4000-8000-000000000001'
       AND sa.id::text LIKE 'b0f30000-%'
       AND NOT EXISTS (SELECT 1 FROM public.instagram_account_capabilities AS c
                        WHERE c.social_account_id = sa.id)),
    'an unenrolled account never gets a job';

  -- Exactly one job per enrolled account.
  ASSERT (SELECT count(*)
            FROM public.instagram_collection_jobs AS j
            JOIN public.social_accounts AS sa ON sa.id = j.social_account_id
           WHERE j.user_id = 'f3110000-0000-4000-8000-000000000001'
             AND sa.id::text LIKE 'b0f30000-%') = 20,
    'every enrolled account has exactly one job';
END $page_window_is_bounded$;

ROLLBACK;
\echo 'ALL CHECKS PASSED'
