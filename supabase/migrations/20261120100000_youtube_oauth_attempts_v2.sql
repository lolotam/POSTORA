-- YouTube OAuth attempts v2: retain the validated return URL and allow the
-- sessionless Google GET callback to consume an attempt by nonce alone.
-- Apply as supabase_admin. Stage 1a objects remain unchanged.

BEGIN;

ALTER TABLE public.youtube_oauth_attempts
  ADD COLUMN return_to TEXT NULL;

COMMENT ON COLUMN public.youtube_oauth_attempts.return_to IS
  'Validated post-OAuth application URL. NULL only on attempts created by the '
  'Stage 1a RPC; those attempts use the application default when consumed.';

CREATE OR REPLACE FUNCTION public.create_youtube_oauth_attempt_v2(
  p_user_id           UUID,
  p_social_profile_id UUID,
  p_return_to         TEXT,
  p_ttl_seconds       INTEGER DEFAULT 600
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_nonce      TEXT;
  v_now        TIMESTAMPTZ := clock_timestamp();
  v_attempt_id UUID;
  v_expires_at TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL OR p_social_profile_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_social_profile_id are required'
      USING ERRCODE = 'YOA01';
  END IF;
  IF p_return_to IS NULL OR btrim(p_return_to) = '' OR length(p_return_to) > 2048 THEN
    RAISE EXCEPTION 'p_return_to is required and must be at most 2048 characters'
      USING ERRCODE = 'YOA01';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 1800 THEN
    RAISE EXCEPTION 'p_ttl_seconds must be between 60 and 1800'
      USING ERRCODE = 'YOA01';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.social_profiles AS p
     WHERE p.id = p_social_profile_id AND p.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'the social profile is not owned by the user'
      USING ERRCODE = 'YOA02';
  END IF;

  v_nonce := replace(gen_random_uuid()::TEXT, '-', '')
          || replace(gen_random_uuid()::TEXT, '-', '');
  v_expires_at := v_now + make_interval(secs => p_ttl_seconds);

  INSERT INTO public.youtube_oauth_attempts (
    user_id, social_profile_id, nonce_digest, return_to, created_at, expires_at
  ) VALUES (
    p_user_id, p_social_profile_id,
    encode(sha256(convert_to(v_nonce, 'UTF8')), 'hex'),
    p_return_to, v_now, v_expires_at
  )
  RETURNING id INTO v_attempt_id;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt_id,
    'nonce', v_nonce,
    'expires_at', v_expires_at
  );
END
$function$;

COMMENT ON FUNCTION public.create_youtube_oauth_attempt_v2(UUID, UUID, TEXT, INTEGER) IS
  'Service-only. Creates an owner/profile-bound YouTube OAuth attempt with a '
  'validated return URL. Returns the raw nonce once; stores only its digest.';

CREATE OR REPLACE FUNCTION public.consume_youtube_oauth_attempt_by_nonce(
  p_nonce TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_attempt public.youtube_oauth_attempts%ROWTYPE;
  v_now     TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_nonce IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;
  IF p_nonce !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nonce');
  END IF;

  SELECT a.* INTO v_attempt
    FROM public.youtube_oauth_attempts AS a
   WHERE a.nonce_digest = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_attempt.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_consumed');
  END IF;
  IF v_attempt.expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  UPDATE public.youtube_oauth_attempts
     SET status = 'consumed', consumed_at = v_now
   WHERE id = v_attempt.id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_attempt.user_id,
    'social_profile_id', v_attempt.social_profile_id,
    'return_to', v_attempt.return_to
  );
END
$function$;

COMMENT ON FUNCTION public.consume_youtube_oauth_attempt_by_nonce(TEXT) IS
  'Service-only. Atomically consumes one unexpired YouTube OAuth attempt by '
  'nonce for either the sessionless GET or authenticated POST callback. '
  'Returns no nonce or digest. Refusals use the stable Stage 1a reason codes.';

REVOKE ALL ON FUNCTION public.create_youtube_oauth_attempt_v2(UUID, UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_youtube_oauth_attempt_by_nonce(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_youtube_oauth_attempt_v2(UUID, UUID, TEXT, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_youtube_oauth_attempt_by_nonce(TEXT)
  TO service_role;

DO $assert_boundary$
BEGIN
  ASSERT NOT has_function_privilege('authenticated',
    'public.create_youtube_oauth_attempt_v2(uuid,uuid,text,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.create_youtube_oauth_attempt_v2(uuid,uuid,text,integer)', 'EXECUTE'),
    'browser roles must not create YouTube attempts';
  ASSERT NOT has_function_privilege('authenticated',
    'public.consume_youtube_oauth_attempt_by_nonce(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon',
      'public.consume_youtube_oauth_attempt_by_nonce(text)', 'EXECUTE'),
    'browser roles must not consume YouTube attempts';
END
$assert_boundary$;

COMMIT;
