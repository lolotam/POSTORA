-- ===========================================================================
-- YouTube OAuth attempt lifecycle (Stage 1a of the YouTube lifecycle
-- authorization work).
--
-- Plan:  docs/plans/2026-11-03-youtube-integration-completion.md (stage 1)
-- Spec:  docs/specs/2026-11-03-youtube-integration-completion.md
--        "OAuth attempts require server-issued expiring single-use state,
--         approved return origins, owner/profile binding, replay consumption
--         and safe legacy callback transition."
-- Mirrors: 20261027110000_meta_oauth_attempt_lifecycle.sql (nonce DIGEST only,
--          service-only RPCs, no browser policy).
--
-- APPLY AS supabase_admin. It is the migration role on this stack and the
-- superuser of the self-hosted image. A REVOKE issued by a non-owner is a
-- WARNING that changes nothing, so the role this runs as is load-bearing.
--
-- ===========================================================================
-- WHAT THIS ADDS (additive only; no existing table, function or reader is
-- touched, so the legacy youtube-oauth callback keeps working unchanged)
--
--   youtube_oauth_attempts                   one service-only row per attempt
--   create_youtube_oauth_attempt(...)        issues the server-side nonce
--   consume_youtube_oauth_attempt(...)       atomic, expiring, single-use
--   purge_expired_youtube_oauth_attempts(..) bounded cleanup sweep
--
-- THE MODEL
--
-- The database generates the nonce and returns it exactly once. Only its
-- SHA-256 digest is stored, so a database read, a backup or a log of this
-- table never yields a usable nonce. The attempt is bound at creation to the
-- owning user AND the intended social profile; consume must present all three
-- (nonce, user, profile) and a mismatch is refused without burning the
-- attempt, so a stranger who somehow holds a nonce cannot destroy the owner's
-- pending attempt.
--
-- Consume refusals are returned as {"ok": false, "reason": <code>} and never
-- carry any attempt column. Stable reasons:
--   invalid_request   a required argument is NULL
--   invalid_nonce     the nonce is blank or over-long
--   not_found         no attempt has that nonce
--   owner_mismatch    the attempt belongs to another user
--   profile_mismatch  the attempt targets another social profile
--   already_consumed  the attempt was already used (replay)
--   expired           the attempt's deadline has passed
-- Check order is exactly that order, so a presenter who fails the ownership
-- checks learns nothing about the attempt's lifecycle state.
--
-- Argument errors on the service-only create and purge RPCs raise:
--   YOA01  invalid argument
--   YOA02  the profile does not exist or is not owned by the user
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The attempt relation. Nonsecret apart from the digest, service-only.
-- ---------------------------------------------------------------------------
CREATE TABLE public.youtube_oauth_attempts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL
                       REFERENCES auth.users (id) ON DELETE CASCADE,
  social_profile_id  UUID NOT NULL
                       REFERENCES public.social_profiles (id) ON DELETE CASCADE,
  -- SHA-256 of the raw nonce, lower-case hex. The raw nonce is never stored.
  nonce_digest       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  CONSTRAINT youtube_oauth_attempts_status_check
    CHECK (status IN ('pending', 'consumed')),
  CONSTRAINT youtube_oauth_attempts_digest_check
    CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT youtube_oauth_attempts_deadline_check
    CHECK (expires_at > created_at),
  CONSTRAINT youtube_oauth_attempts_consumed_check
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);

-- The consume lookup, and the guarantee no two attempts share a nonce.
CREATE UNIQUE INDEX idx_youtube_oauth_attempts_nonce_digest
  ON public.youtube_oauth_attempts (nonce_digest);

-- Cleanup sweep scans by deadline.
CREATE INDEX idx_youtube_oauth_attempts_expires_at
  ON public.youtube_oauth_attempts (expires_at);

-- Cleanup of consumed rows, and the supporting index for the cascade from
-- auth.users and social_profiles.
CREATE INDEX idx_youtube_oauth_attempts_consumed_at
  ON public.youtube_oauth_attempts (consumed_at)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX idx_youtube_oauth_attempts_user
  ON public.youtube_oauth_attempts (user_id);

CREATE INDEX idx_youtube_oauth_attempts_profile
  ON public.youtube_oauth_attempts (social_profile_id);

COMMENT ON TABLE public.youtube_oauth_attempts IS
  'Service-only record of one YouTube OAuth authorization attempt. Holds a '
  'nonce DIGEST (never the raw nonce), the owning user and intended social '
  'profile, a deadline and a single-use consumption mark. Reached only '
  'through create_/consume_/purge_ youtube_oauth_attempt(s) RPCs.';

-- ---------------------------------------------------------------------------
-- 2. create_youtube_oauth_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_youtube_oauth_attempt(
  p_user_id           UUID,
  p_social_profile_id UUID,
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

  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 1800 THEN
    RAISE EXCEPTION 'p_ttl_seconds must be between 60 and 1800'
      USING ERRCODE = 'YOA01';
  END IF;

  -- The profile must exist and belong to the user. One message for both
  -- cases so the refusal does not reveal whether a foreign profile exists.
  IF NOT EXISTS (
    SELECT 1
      FROM public.social_profiles AS p
     WHERE p.id = p_social_profile_id
       AND p.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'the social profile is not owned by the user'
      USING ERRCODE = 'YOA02';
  END IF;

  -- 256 bits from two core random UUIDs; no extension dependency.
  v_nonce := replace(gen_random_uuid()::TEXT, '-', '')
          || replace(gen_random_uuid()::TEXT, '-', '');
  v_expires_at := v_now + make_interval(secs => p_ttl_seconds);

  INSERT INTO public.youtube_oauth_attempts (
    user_id, social_profile_id, nonce_digest, created_at, expires_at
  )
  VALUES (
    p_user_id,
    p_social_profile_id,
    encode(sha256(convert_to(v_nonce, 'UTF8')), 'hex'),
    v_now,
    v_expires_at
  )
  RETURNING id INTO v_attempt_id;

  -- The only moment the raw nonce exists outside the caller's hands.
  RETURN jsonb_build_object(
    'attempt_id', v_attempt_id,
    'nonce', v_nonce,
    'expires_at', v_expires_at
  );
END
$function$;

COMMENT ON FUNCTION public.create_youtube_oauth_attempt(UUID, UUID, INTEGER) IS
  'Service-only. Issues a YouTube OAuth attempt bound to a user and one of '
  'that user''s social profiles. Returns the raw nonce exactly once; only '
  'its digest is stored.';

-- ---------------------------------------------------------------------------
-- 3. consume_youtube_oauth_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_youtube_oauth_attempt(
  p_nonce             TEXT,
  p_user_id           UUID,
  p_social_profile_id UUID
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
  IF p_nonce IS NULL OR p_user_id IS NULL OR p_social_profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF btrim(p_nonce) = '' OR length(p_nonce) > 256 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nonce');
  END IF;

  -- The row lock serialises concurrent presenters of one nonce: the loser
  -- re-reads the committed status and is refused as already_consumed.
  SELECT a.*
    INTO v_attempt
    FROM public.youtube_oauth_attempts AS a
   WHERE a.nonce_digest = encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex')
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_attempt.user_id <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'owner_mismatch');
  END IF;

  IF v_attempt.social_profile_id <> p_social_profile_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_mismatch');
  END IF;

  IF v_attempt.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_consumed');
  END IF;

  IF v_attempt.expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  UPDATE public.youtube_oauth_attempts
     SET status = 'consumed',
         consumed_at = v_now
   WHERE id = v_attempt.id;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt.id,
    'user_id', v_attempt.user_id,
    'social_profile_id', v_attempt.social_profile_id
  );
END
$function$;

COMMENT ON FUNCTION public.consume_youtube_oauth_attempt(TEXT, UUID, UUID) IS
  'Service-only. Atomically consumes a YouTube OAuth attempt: the nonce, user '
  'and social profile must all match, the attempt must be unexpired and '
  'unused. Refusals return {ok:false, reason} with stable reasons and no '
  'attempt columns; a mismatch or expiry does not consume the attempt.';

-- ---------------------------------------------------------------------------
-- 4. purge_expired_youtube_oauth_attempts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_youtube_oauth_attempts(
  p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_removed INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000'
      USING ERRCODE = 'YOA01';
  END IF;

  -- A one hour grace keeps a just-expired or just-consumed attempt visible
  -- to a late callback long enough to be refused with its real reason.
  WITH doomed AS (
    SELECT a.id
      FROM public.youtube_oauth_attempts AS a
     WHERE a.expires_at <= clock_timestamp() - INTERVAL '1 hour'
        OR a.consumed_at <= clock_timestamp() - INTERVAL '1 hour'
     ORDER BY a.expires_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.youtube_oauth_attempts AS a
   USING doomed
   WHERE a.id = doomed.id;

  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END
$function$;

COMMENT ON FUNCTION public.purge_expired_youtube_oauth_attempts(INTEGER) IS
  'Service-only. Deletes up to p_limit YouTube OAuth attempts that expired or '
  'were consumed more than one hour ago. Returns the number removed.';

-- ---------------------------------------------------------------------------
-- 5. Privileges.
--
--    The stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--    anon, authenticated, so every REVOKE below is load-bearing, not
--    decoration. Nothing here is reachable by a browser role, and RLS is on
--    with NO policy so a future grant mistake still returns nothing.
-- ---------------------------------------------------------------------------
ALTER TABLE public.youtube_oauth_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_oauth_attempts
  FROM PUBLIC, anon, authenticated, service_role;
-- Mutations go through the RPCs only; the service role may read for ops.
GRANT SELECT ON public.youtube_oauth_attempts TO service_role;

REVOKE ALL ON FUNCTION public.create_youtube_oauth_attempt(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_youtube_oauth_attempt(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_youtube_oauth_attempts(INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_youtube_oauth_attempt(UUID, UUID, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_youtube_oauth_attempt(TEXT, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_youtube_oauth_attempts(INTEGER)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Boundary self-check: fail the migration rather than ship an open door.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
BEGIN
  ASSERT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_oauth_attempts'::regclass),
    'youtube_oauth_attempts must have RLS enabled';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_oauth_attempts'
  ), 'youtube_oauth_attempts must carry no policy';
  ASSERT NOT has_table_privilege('authenticated', 'public.youtube_oauth_attempts', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.youtube_oauth_attempts', 'SELECT'),
    'browser roles must not read youtube_oauth_attempts';
  ASSERT NOT has_function_privilege('authenticated',
      'public.consume_youtube_oauth_attempt(text, uuid, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon',
      'public.consume_youtube_oauth_attempt(text, uuid, uuid)', 'EXECUTE'),
    'browser roles must not execute the YouTube attempt RPCs';
END
$assert_boundary$;

COMMIT;
