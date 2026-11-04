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

ROLLBACK;
\echo 'ALL CHECKS PASSED'
