-- ===========================================================================
-- 20261028100000_meta_oauth_identity_alias.sql
--
-- The narrow protected OAuth identity-alias prerequisite.
--
-- Instagram Login issues TWO identifiers for one account:
--
--   * profile.id     the app-scoped id. It is what the publishing and the
--                    conversation endpoints address, and it is what
--                    social_accounts.platform_user_id holds.
--   * profile.user_id the distinct Instagram-scoped id (IGID). It is what
--                    the messaging webhooks address the account by, and
--                    what the self-comment check compares against.
--
-- The legacy direct writer stored the second id as the nonsecret
-- account_metadata key "ig_igid". The captured OAuth lifecycle could not
-- carry it: the callback whitelist refused the field, and the selection
-- wrote no identity metadata at all. A direct account connected through
-- the protected lifecycle therefore had no IGID, and the real webhook
-- lookup and the real self-comment check could not resolve it.
--
-- This migration closes that gap WITHOUT touching the accepted ownership,
-- credential, refresh or concurrency contracts:
--
--   * the callback accepts exactly one extra candidate field, ig_igid,
--     and only for the instagram_direct flow. It must be a present,
--     nonblank, untrimmed, bounded provider identifier. An explicit null,
--     a blank value, a wrong type and surrounding whitespace are refused.
--   * the selection applies that alias inside the accepted transaction,
--     under the accepted locks, after the captured account validation and
--     before the receipt. It touches exactly two nonsecret identity keys,
--     ig_igid and ig_user_id, and preserves every other metadata key
--     exactly.
--
-- The canonical app-scoped identity is NOT replaced. Matching by username
-- is NOT introduced. No table, no vault, no identity framework, no new
-- public mutation RPC and no new helper are added. The two public
-- signatures, their volatility, their SECURITY DEFINER posture, their
-- controlled search_path and every existing grant stay exactly as the
-- accepted migration left them.
--
-- OLD VERSUS NEW
--
-- complete_meta_oauth_callback(UUID, JSONB)   three changed blocks:
--
--   1. the candidate whitelist gains the key ig_igid.
--   2. a new validation block, inside the candidate loop and after the
--      existing flow-specific checks: the alias is refused on every flow
--      but instagram_direct (MOA02), and a supplied alias must be a
--      nonblank, untrimmed string of at most 128 characters (MOA01).
--   3. the stored candidate construction carries the alias, so it is
--      persisted immutably in the existing service-only pending stash.
--
-- commit_meta_oauth_selection(UUID, JSONB)    the alias blocks:
--
--   1. locals for the alias, the locked pre-transition capability
--      login_kind, and the previous metadata of the one Instagram account
--      in scope.
--   2. the alias is read from the attempt's own stash, never from the
--      caller, and is re-validated with the accepted identifier
--      convention. A value the identifier helper would silently trim is
--      refused.
--   3. the previous login kind is read from the locked
--      instagram_account_capabilities row BEFORE the account write and
--      BEFORE the capability bump. That read is after the accepted
--      capture revalidation. social_accounts.ig_auth_type is display
--      only and is never consulted. A stored ig_igid is not proof of a
--      previous kind.
--   4. a scoped merge or removal writes ig_igid and ig_user_id and
--      nothing else, after the account write and before the receipt. The
--      existing final expiry check runs after it, so an alias write that
--      fails or that is followed by an expired token rolls the whole
--      transition back. Shape is validated only when this block is about
--      to change identity keys.
--
-- The callback body is otherwise the accepted definition plus the alias
-- whitelist. The selection body is otherwise the accepted definition plus
-- the alias read and this identity block. No helper, table, column or
-- public signature is added.
--
-- Previous-kind authority:
--
--   protected capability row present   its login_kind is the previous
--                                      kind, for every display hint
--   capability row absent              absence is not itself a failure
--                                      and is not a previous kind. A
--                                      verified direct alias still
--                                      replaces both identity keys. An
--                                      omitted alias is a no-op only when
--                                      neither identity key holds an
--                                      unresolved assertion: ig_user_id
--                                      is absent or a valid string equal
--                                      to the selected canonical id, and
--                                      ig_igid is absent. A different,
--                                      null, non-string or malformed
--                                      value in either key refuses MOA11
--                                      and rolls back. Display metadata
--                                      is not a substitute for the
--                                      missing kind.
--
-- Actual relationship versus duplicate metadata. The locked capability
-- kind and the locked platform_user_id are the authority. A metadata
-- field that disagrees with them is not an identity transition, and the
-- accepted platform-id fence still refuses a real canonical change.
--
--   verified direct alias supplied  within SQL null, JSON null or an
--                                    object, ig_igid = the alias and
--                                    ig_user_id = the selected app-scoped
--                                    id. Old identity-key values, even
--                                    malformed ones, are replaced.
--                                    Unrelated keys stay. An array or
--                                    scalar outer value is MOA10.
--   known unchanged relationship,   a missing or equal canonical
--     alias omitted                  duplicate keeps the existing
--                                    omission behavior, including a valid
--                                    second id. A stale valid ig_user_id
--                                    string is rewritten to the
--                                    authoritative canonical id and a
--                                    valid ig_igid is kept. A present
--                                    malformed identity key refuses MOA11
--                                    rather than being coerced or deleted.
--   page-linked to direct, omitted  an actual kind change. ig_igid is
--                                    removed and ig_user_id is
--                                    synchronized. An obsolete
--                                    ig_user_id is not preserved.
--   direct to page-linked           an actual kind change. ig_user_id is
--                                    synchronized and an obsolete ig_igid
--                                    is removed unless it equals that
--                                    canonical id.
--   page plus instagram             only the Instagram companion is
--                                    eligible, and only when its
--                                    protected kind changes. The Facebook
--                                    Page and every unselected sibling
--                                    are untouched.
--
-- Stored-shape refusals, identity-mutating paths only:
--
--   SQL NULL and JSON null           treated as an empty object
--   JSON object                      unrelated keys preserved
--   array, string, number, boolean   MOA10, whole transition rolls back
--
-- MOA10 is only the outer stored shape. MOA11 is the compatibility
-- refusal: an unresolved identity assertion with no recorded kind, or a
-- malformed identity key that an unchanged relationship cannot
-- reconcile. Neither message carries metadata values or a display hint.
-- A path that does not change identity keys does not rewrite outer
-- shape. Replay returns before this block.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.complete_meta_oauth_callback(
  p_user_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key TEXT;
  v_candidate_key TEXT;
  v_attempt UUID;
  v_claim TEXT;
  v_flow TEXT;
  v_status TEXT;
  v_stored_claim TEXT;
  v_deadline TIMESTAMPTZ;
  v_picker TIMESTAMPTZ;
  v_profile UUID;
  v_stash JSONB;
  v_candidates JSONB;
  v_user_token TEXT;
  v_expires_in INTEGER;
  v_item JSONB;
  v_stored JSONB;
  v_built JSONB;
  v_anchored_at TIMESTAMPTZ;
  v_prior_guard TEXT;
  v_grant_expires TIMESTAMPTZ;
  v_direct_expires TIMESTAMPTZ;
  v_page_expires TIMESTAMPTZ;
  v_selection_key TEXT;
  v_keys TEXT[] := ARRAY[]::TEXT[];
  v_login_kind TEXT;
  v_pending UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MOA01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MOA01';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('attempt_id', 'claim_token', 'stash') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MOA01';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload -> 'attempt_id') <> 'string' THEN
    RAISE EXCEPTION 'attempt_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  v_attempt := public.meta_oauth_attempt_uuid(p_payload ->> 'attempt_id', 'attempt_id');
  v_claim := public.meta_oauth_attempt_identifier(
    p_payload ->> 'claim_token', 'claim_token', 256);

  SELECT a.status, a.claim_token, a.flow, a.callback_deadline,
         a.picker_deadline, a.intended_social_profile_id
    INTO v_status, v_stored_claim, v_flow, v_deadline, v_picker, v_profile
    FROM public.meta_oauth_attempts AS a
   WHERE a.id = v_attempt
     AND a.user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % is not owned by the given user', v_attempt
      USING ERRCODE = 'MOA02';
  END IF;

  IF v_status <> 'claimed' THEN
    RAISE EXCEPTION
      'oauth attempt % is not awaiting completion (status=%)', v_attempt, v_status
      USING ERRCODE = 'MOA03';
  END IF;

  IF v_stored_claim IS DISTINCT FROM v_claim THEN
    RAISE EXCEPTION
      'the claim token does not match the oauth attempt %', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  IF clock_timestamp() >= v_deadline THEN
    RAISE EXCEPTION
      'oauth attempt % expired before its callback was completed', v_attempt
      USING ERRCODE = 'MOA08';
  END IF;

  -- The pending insert references the owner and, when set, the profile.
  -- Both are parents of this attempt. Take them NOWAIT before the insert
  -- so a cascading delete cannot deadlock with the attempt row this
  -- transaction already holds.
  PERFORM public.meta_oauth_attempt_lock_owner(p_user_id);
  IF v_profile IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_lock_profile(p_user_id, v_profile);
  END IF;

  v_stash := public.meta_oauth_attempt_object(p_payload, 'stash');
  FOR v_key IN SELECT jsonb_object_keys(v_stash) LOOP
    IF v_key NOT IN (
      'candidates', 'user_token', 'expires_in',
      'user_token_expires_at', 'user_token_expires_in',
      'direct_token_expires_at', 'direct_token_expires_in'
    ) THEN
      RAISE EXCEPTION 'unsupported stash key: %', v_key USING ERRCODE = 'MOA01';
    END IF;
  END LOOP;

  IF jsonb_typeof(v_stash -> 'candidates') <> 'array' THEN
    RAISE EXCEPTION 'stash.candidates must be an array' USING ERRCODE = 'MOA01';
  END IF;
  IF jsonb_array_length(v_stash -> 'candidates') < 1 THEN
    RAISE EXCEPTION 'stash.candidates must not be empty' USING ERRCODE = 'MOA01';
  END IF;
  IF jsonb_array_length(v_stash -> 'candidates') > 50 THEN
    RAISE EXCEPTION 'stash.candidates must not hold more than 50 candidates'
      USING ERRCODE = 'MOA01';
  END IF;

  IF v_flow = 'instagram_direct' THEN
    v_login_kind := 'direct';
    IF v_stash ? 'user_token_expires_at' OR v_stash ? 'user_token_expires_in' THEN
      RAISE EXCEPTION
        'a direct Instagram stash must not carry a Facebook User token expiry'
        USING ERRCODE = 'MOA02';
    END IF;
  ELSIF v_flow = 'instagram_page_linked' THEN
    v_login_kind := 'page_linked';
    IF v_stash ? 'direct_token_expires_at' OR v_stash ? 'direct_token_expires_in' THEN
      RAISE EXCEPTION
        'a page-linked stash must not carry a direct-token expiry'
        USING ERRCODE = 'MOA02';
    END IF;
  ELSE
    v_login_kind := NULL;
    IF v_stash ? 'direct_token_expires_at' OR v_stash ? 'direct_token_expires_in' THEN
      RAISE EXCEPTION
        'a facebook page stash must not carry a direct-token expiry'
        USING ERRCODE = 'MOA02';
    END IF;
  END IF;

  -- Absolute expiries are anchored once, at this callback, and then stored.
  -- Selection must not add the TTL again. An omitted expiry stays unknown.
  v_anchored_at := clock_timestamp();
  IF v_flow = 'instagram_direct' THEN
    v_direct_expires := public.meta_oauth_attempt_anchor_expiry(
      v_stash ->> 'direct_token_expires_at',
      COALESCE(v_stash ->> 'direct_token_expires_in', v_stash ->> 'expires_in'),
      v_anchored_at, 'direct_token_expires_at');
    v_grant_expires := NULL;
  ELSE
    v_grant_expires := public.meta_oauth_attempt_anchor_expiry(
      v_stash ->> 'user_token_expires_at',
      COALESCE(v_stash ->> 'user_token_expires_in', v_stash ->> 'expires_in'),
      v_anchored_at, 'user_token_expires_at');
    v_direct_expires := NULL;
  END IF;

  -- The candidate whitelist. Every stored object is whitelisted key by
  -- key: an unknown key is a refusal, never a silently stored field.
  v_built := '[]'::JSONB;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_stash -> 'candidates') AS e(value) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'each stash candidate must be a JSON object' USING ERRCODE = 'MOA01';
    END IF;
    FOR v_candidate_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF v_candidate_key NOT IN (
        'ig_user_id', 'ig_username', 'ig_profile_picture_url',
        'facebook_page_id', 'facebook_page_name', 'page_access_token',
        'facebook_user_id', 'candidate_kind',
        'page_token_expires_at', 'page_token_expires_in',
        'ig_igid'
      ) THEN
        RAISE EXCEPTION 'unsupported candidate field: %', v_candidate_key
          USING ERRCODE = 'MOA01';
      END IF;
    END LOOP;

    IF v_flow = 'facebook_page' AND COALESCE(v_item ->> 'candidate_kind', '') = 'page_only' THEN
      NULL;
    ELSE
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'ig_user_id', 'ig_user_id', 128);
    END IF;

    IF v_flow = 'instagram_page_linked' THEN
      IF v_item ? 'candidate_kind'
         AND COALESCE(v_item ->> 'candidate_kind', '') <> 'ig_only' THEN
        RAISE EXCEPTION
          'an instagram_page_linked candidate must be ig_only'
          USING ERRCODE = 'MOA02';
      END IF;
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'facebook_page_id', 'facebook_page_id', 128);
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'facebook_user_id', 'facebook_user_id', 128);
      IF v_item ->> 'page_access_token' IS NULL
         OR btrim(v_item ->> 'page_access_token') = '' THEN
        RAISE EXCEPTION 'page_access_token is required for a page-linked candidate'
          USING ERRCODE = 'MOA01';
      END IF;
    ELSIF v_flow = 'facebook_page' THEN
      IF COALESCE(v_item ->> 'candidate_kind', '') NOT IN ('page_only', 'page_plus_ig') THEN
        RAISE EXCEPTION
          'a facebook_page candidate requires candidate_kind page_only or page_plus_ig'
          USING ERRCODE = 'MOA01';
      END IF;
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'facebook_page_id', 'facebook_page_id', 128);
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'facebook_user_id', 'facebook_user_id', 128);
      IF v_item ->> 'page_access_token' IS NULL
         OR btrim(v_item ->> 'page_access_token') = '' THEN
        RAISE EXCEPTION 'page_access_token is required for a facebook page candidate'
          USING ERRCODE = 'MOA01';
      END IF;
      IF (v_item ->> 'candidate_kind') = 'page_only' AND v_item ? 'ig_user_id' THEN
        RAISE EXCEPTION
          'a page_only candidate must not carry an Instagram identity'
          USING ERRCODE = 'MOA02';
      END IF;
      IF (v_item ->> 'candidate_kind') = 'page_plus_ig' THEN
        PERFORM public.meta_oauth_attempt_identifier(
          v_item ->> 'ig_user_id', 'ig_user_id', 128);
      END IF;
    ELSE
      IF v_item ? 'facebook_page_id'
         OR v_item ? 'facebook_user_id'
         OR v_item ? 'page_access_token'
         OR v_item ? 'candidate_kind'
         OR v_item ? 'page_token_expires_at'
         OR v_item ? 'page_token_expires_in' THEN
        RAISE EXCEPTION
          'a direct Instagram candidate must not carry a facebook page, grant or page token'
          USING ERRCODE = 'MOA02';
      END IF;
    END IF;

    -- The messaging-scoped identity alias.
    --
    -- Instagram Login issues two ids for one account: the app-scoped id
    -- the publishing and conversation endpoints address, and the distinct
    -- Instagram-scoped id (IGID) that the messaging webhooks and the
    -- self-comment check resolve. Only the direct flow carries the IGID,
    -- so only the direct flow may assert it.
    --
    -- A supplied alias must be a present, nonblank, untrimmed and bounded
    -- provider identifier. An explicit null, a blank value, a wrong type
    -- and surrounding whitespace are malformed payloads. They are never
    -- omitted silently and never coerced into a valid value.
    IF v_item ? 'ig_igid' THEN
      IF v_flow <> 'instagram_direct' THEN
        RAISE EXCEPTION
          'a candidate in the % flow must not carry an ig_igid alias', v_flow
          USING ERRCODE = 'MOA02';
      END IF;
      IF jsonb_typeof(v_item -> 'ig_igid') <> 'string' THEN
        RAISE EXCEPTION 'ig_igid must be a string'
          USING ERRCODE = 'MOA01';
      END IF;
      IF v_item ->> 'ig_igid' <> btrim(v_item ->> 'ig_igid') THEN
        RAISE EXCEPTION 'ig_igid must not carry surrounding whitespace'
          USING ERRCODE = 'MOA01';
      END IF;
      PERFORM public.meta_oauth_attempt_identifier(
        v_item ->> 'ig_igid', 'ig_igid', 128);
    END IF;

    v_page_expires := public.meta_oauth_attempt_anchor_expiry(
      v_item ->> 'page_token_expires_at',
      v_item ->> 'page_token_expires_in',
      v_anchored_at, 'page_token_expires_at');

    v_selection_key := public.meta_oauth_attempt_selection_key(v_flow, v_item);
    IF v_selection_key = ANY (v_keys) THEN
      RAISE EXCEPTION
        'the stash holds the same instagram identity twice: %', v_selection_key
        USING ERRCODE = 'MOA01';
    END IF;
    v_keys := v_keys || v_selection_key;

    -- Inputs page_token_expires_in / *_expires_in are not stored. The
    -- absolute fields below are the only expiry evidence commit reads.
    v_stored := jsonb_strip_nulls(jsonb_build_object(
      'candidate_kind', v_item -> 'candidate_kind',
      'ig_user_id', v_item -> 'ig_user_id',
      'ig_username', v_item -> 'ig_username',
      'ig_profile_picture_url', v_item -> 'ig_profile_picture_url',
      'facebook_page_id', v_item -> 'facebook_page_id',
      'facebook_page_name', v_item -> 'facebook_page_name',
      'page_access_token', v_item -> 'page_access_token',
      'facebook_user_id', v_item -> 'facebook_user_id',
      'ig_igid', v_item -> 'ig_igid',
      'page_token_expires_at', CASE WHEN v_page_expires IS NULL THEN NULL
        ELSE to_jsonb(v_page_expires) END,
      'grant_token_expires_at', CASE WHEN v_grant_expires IS NULL THEN NULL
        ELSE to_jsonb(v_grant_expires) END,
      'direct_token_expires_at', CASE WHEN v_direct_expires IS NULL THEN NULL
        ELSE to_jsonb(v_direct_expires) END
    ));
    v_built := v_built || jsonb_build_array(v_stored);
  END LOOP;

  -- The grant token for a page-linked attempt, the account's own token for
  -- a direct attempt. Both live in the existing stash column; there is no
  -- second secret store.
  IF jsonb_typeof(v_stash -> 'user_token') <> 'string'
     OR btrim(v_stash ->> 'user_token') = '' THEN
    RAISE EXCEPTION 'stash.user_token is required' USING ERRCODE = 'MOA01';
  END IF;
  IF char_length(v_stash ->> 'user_token') > 4096 THEN
    RAISE EXCEPTION 'stash.user_token must be at most 4096 characters'
      USING ERRCODE = 'MOA01';
  END IF;
  v_user_token := v_stash ->> 'user_token';

  -- The legacy column is NOT NULL. Zero means the absolute expiry was
  -- omitted or was supplied as a timestamp, not that the token lasts
  -- sixty days. Commit never reads this column.
  v_expires_in := 0;
  IF v_flow = 'instagram_direct' AND v_stash ? 'direct_token_expires_in' THEN
    v_expires_in := (v_stash ->> 'direct_token_expires_in')::INTEGER;
  ELSIF v_flow = 'instagram_direct' AND v_stash ? 'expires_in' THEN
    v_expires_in := (v_stash ->> 'expires_in')::INTEGER;
  ELSIF v_stash ? 'user_token_expires_in' THEN
    v_expires_in := (v_stash ->> 'user_token_expires_in')::INTEGER;
  ELSIF v_stash ? 'expires_in' THEN
    v_expires_in := (v_stash ->> 'expires_in')::INTEGER;
  END IF;

  -- The attempt now owns the stash row. From here the guard trigger lets
  -- only this attempt touch it. The previous setting is restored on the
  -- way out so a nested caller keeps its own guard.
  v_prior_guard := current_setting('postora.meta_oauth_attempt', true);
  PERFORM set_config('postora.meta_oauth_attempt', v_attempt::TEXT, true);

  INSERT INTO public.oauth_pending_instagram_selections (
    user_id, social_profile_id, ig_candidates_json, long_lived_token,
    expires_in, created_at, expires_at, meta_oauth_attempt_id
  ) VALUES (
    p_user_id, v_profile, v_built, v_user_token,
    v_expires_in, now(), v_picker, v_attempt
  )
  RETURNING id INTO v_pending;

  UPDATE public.meta_oauth_attempts AS a
     SET status = 'selection_ready',
         pending_selection_id = v_pending,
         updated_at = now()
   WHERE a.id = v_attempt
     AND a.user_id = p_user_id
     AND a.status = 'claimed';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % could not be moved to selection-ready', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  -- The attempt capability is released again. The guard trigger reads it as
  -- a transaction-local setting, so leaving it set would let anything later
  -- in the SAME transaction write or consume this attempt's stash. Restore
  -- the caller's previous value rather than clearing a nested guard.
  PERFORM set_config(
    'postora.meta_oauth_attempt', COALESCE(v_prior_guard, ''), true);

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'flow', v_flow,
    'pending_selection_id', v_pending,
    'login_kind', v_login_kind,
    'picker_deadline', v_picker,
    'candidates', (
      SELECT COALESCE(jsonb_agg(
               jsonb_build_object(
                 'selection_key', public.meta_oauth_attempt_selection_key(v_flow, e.value),
                 'ig_user_id', e.value ->> 'ig_user_id',
                 'ig_username', e.value ->> 'ig_username',
                 'ig_profile_picture_url', e.value ->> 'ig_profile_picture_url',
                 'facebook_page_id', e.value ->> 'facebook_page_id',
                 'facebook_page_name', e.value ->> 'facebook_page_name'
               )
               ORDER BY public.meta_oauth_attempt_selection_key(v_flow, e.value)
             ), '[]'::JSONB)
        FROM jsonb_array_elements(v_built) AS e(value)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.complete_meta_oauth_callback(UUID, JSONB) IS
  'Requires the exact claim and an unexpired attempt, validates the '
  'service-provided verified candidates against a strict whitelist, persists '
  'the existing pending stash ONCE and moves the attempt to selection-ready. '
  'A replay cannot overwrite or replace the stash. A direct Instagram '
  'candidate may additionally carry the nonsecret ig_igid messaging alias; '
  'every other flow refuses it and the alias is never exposed in a picker '
  'or receipt response.';

CREATE OR REPLACE FUNCTION public.commit_meta_oauth_selection(
  p_user_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key TEXT;
  v_attempt UUID;
  v_selection_key TEXT;
  v_flow TEXT;
  v_intent TEXT;
  v_status TEXT;
  v_capture JSONB;
  v_progression JSONB;
  v_picker TIMESTAMPTZ;
  v_target_capture JSONB;
  v_linked_capture JSONB;
  v_source_capture JSONB;
  v_source_expected JSONB;
  v_progressed_member JSONB;
  v_grant_capture JSONB;
  v_login_kind TEXT;
  v_writes_user_grant BOOLEAN := false;
  v_now TIMESTAMPTZ;
  v_profile UUID;
  v_prior_guard TEXT;
  v_candidate_kind TEXT;
  v_page_expires TIMESTAMPTZ;
  v_grant_expires TIMESTAMPTZ;
  v_direct_expires TIMESTAMPTZ;
  v_companion UUID;
  v_companion_generation BIGINT;
  v_companion_connection BIGINT;
  v_parent_ids UUID[] := ARRAY[]::UUID[];

  v_pending UUID;
  v_pending_candidates JSONB;
  v_pending_token TEXT;
  v_pending_expires_in INTEGER;
  v_pending_expires_at TIMESTAMPTZ;
  v_candidate JSONB;
  v_item JSONB;
  v_ig_user_id TEXT;
  v_ig_username TEXT;
  v_avatar TEXT;
  v_page_id TEXT;
  v_page_token TEXT;
  v_facebook_user_id TEXT;
  v_account_token TEXT;
  v_token_expires_at TIMESTAMPTZ;

  v_account UUID;
  v_account_exists BOOLEAN := false;
  v_account_is_active BOOLEAN;
  v_account_platform_user_id TEXT;
  v_operation TEXT;

  -- The identity-alias scope. One Instagram account. Previous kind comes
  -- from the locked capability row, not from display metadata.
  v_alias TEXT;
  v_ig_metadata_prev_id UUID;
  v_ig_metadata_account UUID;
  v_prev_metadata JSONB;
  v_next_metadata JSONB;
  v_prev_classification TEXT := NULL;
  v_new_classification TEXT;
  v_identity_mutate BOOLEAN := false;
  v_has_second_id BOOLEAN := false;
  -- A valid ig_user_id string that disagrees with the selected canonical
  -- id. This is duplicate-key repair, not an account-identity change.
  v_canonical_drift BOOLEAN := false;
  v_canonical_malformed BOOLEAN := false;
  v_second_malformed BOOLEAN := false;
  v_repair_canonical BOOLEAN := false;

  v_credential UUID;
  v_credential_revision BIGINT;
  v_credential_provider TEXT;
  v_credential_from_progression BOOLEAN := false;
  v_connection_version BIGINT;
  v_capability_generation BIGINT;
  v_live_capability_generation BIGINT;
  v_live_capability_login_kind TEXT;
  v_expected_generation BIGINT;

  v_live_fence_state TEXT;
  v_live_fence_version BIGINT;
  v_live_binding_present BOOLEAN := false;
  v_live_binding_credential UUID;
  v_live_binding_connection BIGINT;
  v_expected_binding_connection BIGINT;
  v_expected_fence BIGINT;
  v_expected_credential_revision BIGINT;
  v_live_credential_revision BIGINT;

  v_accounts UUID[] := ARRAY[]::UUID[];
  v_credentials UUID[] := ARRAY[]::UUID[];
  v_expected_members TEXT[];
  v_live_members TEXT[];
  v_progression_accounts UUID[];
  v_remaining INTEGER;
  v_receipt JSONB;
  v_receipt_row JSONB;
  v_receipt_account TEXT;
  v_receipt_platform TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MOA01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MOA01';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('attempt_id', 'selection_key') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MOA01';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload -> 'attempt_id') <> 'string' THEN
    RAISE EXCEPTION 'attempt_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  v_attempt := public.meta_oauth_attempt_uuid(p_payload ->> 'attempt_id', 'attempt_id');
  v_selection_key := public.meta_oauth_attempt_identifier(
    p_payload ->> 'selection_key', 'selection_key', 512);

  -- ---------------------------------------------------------------------
  -- The attempt lock, taken first and on its own.
  -- ---------------------------------------------------------------------
  SELECT a.status, a.flow, a.intent, a.capture, a.authority_progression,
         a.picker_deadline, a.pending_selection_id, a.intended_social_profile_id
    INTO v_status, v_flow, v_intent, v_capture, v_progression,
         v_picker, v_pending, v_profile
    FROM public.meta_oauth_attempts AS a
   WHERE a.id = v_attempt
     AND a.user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % is not owned by the given user', v_attempt
      USING ERRCODE = 'MOA02';
  END IF;

  -- The owner row is an FK parent of the attempt. Waiting for it while
  -- this transaction holds the attempt deadlocks with DELETE FROM auth.users.
  PERFORM public.meta_oauth_attempt_lock_owner(p_user_id);
  v_prior_guard := current_setting('postora.meta_oauth_attempt', true);

  IF v_flow = 'instagram_direct' THEN
    v_login_kind := 'direct';
  ELSIF v_flow = 'instagram_page_linked' THEN
    v_login_kind := 'page_linked';
    v_writes_user_grant := true;
  ELSE
    v_writes_user_grant := true;
  END IF;

  -- ---------------------------------------------------------------------
  -- The replay path. An identical committed selection returns the same
  -- nonsecret receipt with ZERO mutations. A conflicting replay refuses.
  -- ---------------------------------------------------------------------
  SELECT r.receipt INTO v_receipt_row
    FROM public.meta_oauth_attempt_receipts AS r
   WHERE r.attempt_id = v_attempt
     AND r.user_id = p_user_id
     AND r.selection_key = v_selection_key;

  IF v_receipt_row IS NOT NULL THEN
    SELECT sa.platform, sa.platform_user_id
      INTO v_receipt_platform, v_receipt_account
      FROM public.social_accounts AS sa
     WHERE sa.id = (v_receipt_row ->> 'social_account_id')::UUID
       AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the committed selection % no longer has its account; this is not an identical retry',
        v_selection_key
        USING ERRCODE = 'MOA06';
    END IF;
    IF v_receipt_platform IS DISTINCT FROM (v_receipt_row ->> 'platform')
       OR v_receipt_account IS DISTINCT FROM (v_receipt_row ->> 'platform_user_id') THEN
      RAISE EXCEPTION
        'the committed selection % conflicts with the current account identity',
        v_selection_key
        USING ERRCODE = 'MOA06';
    END IF;
    IF (v_receipt_row ->> 'companion_social_account_id') IS NOT NULL THEN
      SELECT sa.platform, sa.platform_user_id
        INTO v_receipt_platform, v_receipt_account
        FROM public.social_accounts AS sa
       WHERE sa.id = (v_receipt_row ->> 'companion_social_account_id')::UUID
         AND sa.user_id = p_user_id;
      IF NOT FOUND
         OR v_receipt_platform IS DISTINCT FROM 'instagram'
         OR v_receipt_account IS DISTINCT FROM (v_receipt_row ->> 'instagram_user_id') THEN
        RAISE EXCEPTION
          'the committed selection % conflicts with the current companion identity',
          v_selection_key
          USING ERRCODE = 'MOA06';
      END IF;
    END IF;
    -- Replay is read-only. Do not install the mutation guard: a later
    -- statement in this transaction must not inherit it.
    RETURN v_receipt_row;
  END IF;

  PERFORM set_config('postora.meta_oauth_attempt', v_attempt::TEXT, true);

  IF v_status <> 'selection_ready' THEN
    RAISE EXCEPTION
      'oauth attempt % is not ready for a selection (status=%)', v_attempt, v_status
      USING ERRCODE = 'MOA03';
  END IF;

  IF v_pending IS NULL THEN
    RAISE EXCEPTION
      'oauth attempt % has no pending selection stash', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  -- ---------------------------------------------------------------------
  -- The intended profile, the PARENT lock. NOWAIT, because waiting for the
  -- profile while holding the attempt is the inverse of the cascade a
  -- profile delete takes.
  -- ---------------------------------------------------------------------
  IF v_profile IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_lock_profile(p_user_id, v_profile);
  END IF;

  -- ---------------------------------------------------------------------
  -- The stash row. Locked FOR UPDATE, and it must carry this attempt.
  -- ---------------------------------------------------------------------
  SELECT ps.ig_candidates_json, ps.long_lived_token, ps.expires_in, ps.expires_at
    INTO v_pending_candidates, v_pending_token, v_pending_expires_in, v_pending_expires_at
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = v_pending
     AND ps.user_id = p_user_id
     AND ps.meta_oauth_attempt_id = v_attempt
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % has no pending selection stash', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  -- ---------------------------------------------------------------------
  -- The candidate. It comes from the stash, never from the caller.
  -- ---------------------------------------------------------------------
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_pending_candidates) AS e(value) LOOP
    IF public.meta_oauth_attempt_selection_key(v_flow, v_item) = v_selection_key THEN
      v_candidate := v_item;
      EXIT;
    END IF;
  END LOOP;

  IF v_candidate IS NULL THEN
    RAISE EXCEPTION
      'the selection key % is not present in the attempt stash', v_selection_key
      USING ERRCODE = 'MOA03';
  END IF;

  v_ig_user_id := v_candidate ->> 'ig_user_id';
  v_ig_username := v_candidate ->> 'ig_username';

  -- The asserted alias comes from the attempt's own stash, never from the
  -- caller. The stash was validated at the callback, and the value is read
  -- again here with the same identifier convention. A value the identifier
  -- helper would silently trim is refused, not repaired.
  v_alias := NULL;
  IF v_candidate ? 'ig_igid' THEN
    IF v_flow <> 'instagram_direct' THEN
      RAISE EXCEPTION
        'a candidate in the % flow must not carry an ig_igid alias', v_flow
        USING ERRCODE = 'MOA02';
    END IF;
    v_alias := public.meta_oauth_attempt_identifier(
      v_candidate ->> 'ig_igid', 'ig_igid', 128);
    IF v_alias IS DISTINCT FROM (v_candidate ->> 'ig_igid') THEN
      RAISE EXCEPTION 'the stored ig_igid alias is not a clean identifier'
        USING ERRCODE = 'MOA01';
    END IF;
  END IF;
  v_avatar := v_candidate ->> 'ig_profile_picture_url';
  v_page_id := v_candidate ->> 'facebook_page_id';
  v_page_token := v_candidate ->> 'page_access_token';
  v_facebook_user_id := v_candidate ->> 'facebook_user_id';

  v_candidate_kind := v_candidate ->> 'candidate_kind';
  v_page_expires := public.meta_oauth_attempt_timestamptz(
    v_candidate ->> 'page_token_expires_at', 'page_token_expires_at');
  v_grant_expires := public.meta_oauth_attempt_timestamptz(
    v_candidate ->> 'grant_token_expires_at', 'grant_token_expires_at');
  v_direct_expires := public.meta_oauth_attempt_timestamptz(
    v_candidate ->> 'direct_token_expires_at', 'direct_token_expires_at');

  IF v_flow = 'instagram_direct' THEN
    v_account_token := v_pending_token;
    v_token_expires_at := v_direct_expires;
  ELSE
    -- Page-linked Instagram and a Facebook Page both store the Page token
    -- on the operational account. The User TTL is the grant expiry above.
    v_account_token := v_page_token;
    v_token_expires_at := v_page_expires;
    IF v_flow = 'facebook_page' AND v_candidate_kind = 'page_plus_ig' THEN
      v_login_kind := 'page_linked';
    END IF;
  END IF;
  IF v_account_token IS NULL OR btrim(v_account_token) = '' THEN
    RAISE EXCEPTION
      'the attempt stash no longer holds the operational token for this selection'
      USING ERRCODE = 'MOA08';
  END IF;
  IF v_token_expires_at IS NOT NULL AND clock_timestamp() >= v_token_expires_at THEN
    RAISE EXCEPTION
      'the operational token was already expired when the selection was committed'
      USING ERRCODE = 'MOA08';
  END IF;
  IF v_writes_user_grant AND v_grant_expires IS NOT NULL
     AND clock_timestamp() >= v_grant_expires THEN
    RAISE EXCEPTION
      'the facebook user token was already expired when the selection was committed'
      USING ERRCODE = 'MOA08';
  END IF;

  -- ---------------------------------------------------------------------
  -- The complete account and credential set, taken from the immutable
  -- capture and from this attempt's own progression. Nothing else.
  -- ---------------------------------------------------------------------
  v_target_capture := v_capture -> 'target';
  v_linked_capture := v_capture -> 'linked_target';
  v_source_capture := v_capture -> 'source';
  v_grant_capture := v_capture -> 'grant';
  v_progression_accounts := public.meta_oauth_attempt_progression_accounts(v_progression);

  IF v_target_capture IS NOT NULL THEN
    v_accounts := v_accounts || ((v_target_capture ->> 'social_account_id')::UUID);
    v_parent_ids := v_parent_ids || ((v_target_capture ->> 'social_account_id')::UUID);
  END IF;
  IF v_linked_capture IS NOT NULL THEN
    v_accounts := v_accounts || ((v_linked_capture ->> 'social_account_id')::UUID);
    v_parent_ids := v_parent_ids || ((v_linked_capture ->> 'social_account_id')::UUID);
  END IF;
  IF v_source_capture IS NOT NULL THEN
    v_accounts := v_accounts || ((v_source_capture ->> 'social_account_id')::UUID);
    v_parent_ids := v_parent_ids || ((v_source_capture ->> 'social_account_id')::UUID);
  END IF;
  -- A later selection of this attempt validates the credential ITS OWN
  -- commit returned. It does not union that set with the original capture,
  -- which would hide a member added to the progressed grant.
  IF (v_progression ->> 'credential_id') IS NOT NULL THEN
    v_accounts := v_accounts || v_progression_accounts;
    v_credentials := v_credentials || ((v_progression ->> 'credential_id')::UUID);
  ELSIF v_grant_capture IS NOT NULL THEN
    FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_grant_capture -> 'members') AS e(value) LOOP
      v_accounts := v_accounts || ((v_item ->> 'social_account_id')::UUID);
    END LOOP;
    v_credentials := v_credentials || ((v_grant_capture ->> 'credential_id')::UUID);
  ELSE
    v_accounts := v_accounts || v_progression_accounts;
  END IF;

  -- Captured accounts, in id order. A busy member is MOA09 even when
  -- the holder is not a delete. The accepted helper then takes the same
  -- rows (already held), the guard and capability advisory locks, and
  -- the credentials.
  PERFORM public.meta_oauth_attempt_lock_accounts(p_user_id, v_accounts, v_parent_ids);
  PERFORM public.facebook_user_credential_lock_scope(
    ARRAY(SELECT DISTINCT x FROM unnest(v_accounts) AS u(x) WHERE x IS NOT NULL ORDER BY 1),
    ARRAY(SELECT DISTINCT x FROM unnest(v_credentials) AS u(x) WHERE x IS NOT NULL ORDER BY 1)
  );

  -- Deadline and every known absolute token expiry, after the lock waits
  -- and before the first account mutation. Later waits check again.
  v_now := clock_timestamp();
  PERFORM public.meta_oauth_attempt_assert_live_expiries(
    v_attempt, v_picker, v_pending_expires_at, v_token_expires_at,
    CASE WHEN v_writes_user_grant THEN v_grant_expires ELSE NULL END);

  -- ---------------------------------------------------------------------
  -- The account this selection applies to.
  --
  --   reconnect  -> the captured target, reactivated when it was inactive
  --   otherwise  -> create-only, and an existing natural key is a typed
  --                 conflict, never an adoption
  -- ---------------------------------------------------------------------
  IF v_intent IN ('reconnect', 'rebind') THEN
    SELECT sa.id, sa.is_active, sa.platform_user_id
      INTO v_account, v_account_is_active, v_account_platform_user_id
      FROM public.social_accounts AS sa
     WHERE sa.id = (v_target_capture ->> 'social_account_id')::UUID
       AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the captured reconnect target no longer exists' USING ERRCODE = 'MOA07';
    END IF;
    v_account_exists := true;
    -- The owner, the platform and the stable provider identity are
    -- immutable through a reconnect or an explicit rebind.
    IF v_flow = 'facebook_page' THEN
      IF v_account_platform_user_id IS DISTINCT FROM v_page_id THEN
        RAISE EXCEPTION
          'the verified facebook page does not match the captured reconnect target'
          USING ERRCODE = 'MOA07';
      END IF;
    ELSIF v_account_platform_user_id IS DISTINCT FROM v_ig_user_id THEN
      RAISE EXCEPTION
        'the verified instagram identity does not match the captured reconnect target'
        USING ERRCODE = 'MOA07';
    END IF;
    v_operation := CASE
      WHEN v_intent = 'rebind' THEN 'rebound'
      WHEN COALESCE(v_account_is_active, false) THEN 'reconnected'
      ELSE 'reactivated' END;
  ELSIF v_flow = 'facebook_page' THEN
    SELECT sa.id INTO v_account
      FROM public.social_accounts AS sa
     WHERE sa.user_id = p_user_id
       AND sa.platform = 'facebook'
       AND sa.platform_user_id = v_page_id;
    IF FOUND THEN
      RAISE EXCEPTION
        'a Facebook Page with this provider identity already exists; reconnect it explicitly'
        USING ERRCODE = 'MOA05';
    END IF;
    IF v_candidate_kind = 'page_plus_ig' THEN
      SELECT sa.id INTO v_companion
        FROM public.social_accounts AS sa
       WHERE sa.user_id = p_user_id
         AND sa.platform = 'instagram'
         AND sa.platform_user_id = v_ig_user_id;
      IF FOUND THEN
        RAISE EXCEPTION
          'an Instagram account with this provider identity already exists; reconnect it explicitly'
          USING ERRCODE = 'MOA05';
      END IF;
      v_companion := NULL;
    END IF;
    v_account_exists := false;
    v_operation := 'created';
  ELSE
    SELECT sa.id INTO v_account
      FROM public.social_accounts AS sa
     WHERE sa.user_id = p_user_id
       AND sa.platform = 'instagram'
       AND sa.platform_user_id = v_ig_user_id;
    IF FOUND THEN
      RAISE EXCEPTION
        'an Instagram account with this provider identity already exists; reconnect it explicitly'
        USING ERRCODE = 'MOA05';
    END IF;
    v_account_exists := false;
    v_operation := 'created';
  END IF;

  -- ---------------------------------------------------------------------
  -- Both explicit captured accounts, before either account write.
  -- The linked account is checked even when it was unbound: it is not a
  -- grant member, so require_members does not see it.
  -- ---------------------------------------------------------------------
  IF v_target_capture IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_require_captured_account(
      p_user_id, v_target_capture);
    v_live_binding_present := (v_target_capture ->> 'binding_present')::BOOLEAN;
    v_live_binding_credential := (v_target_capture ->> 'binding_credential_id')::UUID;
    v_expected_binding_connection :=
      (v_target_capture ->> 'binding_connection_version')::BIGINT;
    -- Reconnect refuses a different subject. Explicit rebind is the only
    -- path that may detach this target onto a new grant. The credential
    -- id is the one the capture recorded, not a binding discovered now.
    IF v_live_binding_present IS TRUE
       AND v_intent <> 'rebind'
       AND v_facebook_user_id IS NOT NULL THEN
      SELECT c.provider_user_id INTO v_credential_provider
        FROM public.facebook_user_credentials AS c
       WHERE c.id = v_live_binding_credential
         AND c.user_id = p_user_id;
      IF v_credential_provider IS DISTINCT FROM v_facebook_user_id THEN
        RAISE EXCEPTION
          'the verified facebook user id does not match the captured grant'
          USING ERRCODE = 'MOA07';
      END IF;
    END IF;
  END IF;
  IF v_linked_capture IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_require_captured_account(
      p_user_id, v_linked_capture);
    IF (v_linked_capture ->> 'platform') IS DISTINCT FROM 'instagram'
       OR (v_linked_capture ->> 'platform_user_id') IS DISTINCT FROM v_ig_user_id THEN
      RAISE EXCEPTION
        'the verified instagram identity does not match the captured linked account'
        USING ERRCODE = 'MOA07';
    END IF;
  END IF;
  IF v_source_capture IS NOT NULL THEN
    IF (v_progression ->> 'credential_id') IS NULL THEN
      -- First selection. Nothing this attempt has committed, so the
      -- original source capture, including its fence, is the authority.
      PERFORM public.meta_oauth_attempt_require_captured_account(
        p_user_id, v_source_capture);
    ELSE
      -- A later selection. The first commit of this attempt advanced the
      -- source. Versions come from that progression. Identity stays the
      -- original capture, and the capture column is not rewritten.
      SELECT e.value INTO v_progressed_member
        FROM jsonb_array_elements(
               COALESCE(v_progression -> 'accounts', '[]'::JSONB)) AS e(value)
       WHERE (e.value ->> 'social_account_id')::UUID
             = (v_source_capture ->> 'social_account_id')::UUID;
      IF NOT FOUND
         OR (v_progressed_member ->> 'connection_version') IS NULL
         OR (v_progressed_member ->> 'platform')
            IS DISTINCT FROM (v_source_capture ->> 'platform')
         OR (v_progressed_member ->> 'platform_user_id')
            IS DISTINCT FROM (v_source_capture ->> 'platform_user_id') THEN
        RAISE EXCEPTION
          'the grant source is not covered by the authority this attempt committed'
          USING ERRCODE = 'MOA07';
      END IF;
      v_source_expected := v_source_capture || jsonb_build_object(
        'binding_present', true,
        'binding_credential_id', v_progression ->> 'credential_id',
        'binding_connection_version',
          (v_progressed_member ->> 'connection_version')::BIGINT,
        'fence_state', 'present',
        'fence_connection_version',
          (v_progressed_member ->> 'connection_version')::BIGINT,
        'credential_revision', (v_progression ->> 'credential_revision')::BIGINT);
      IF (v_source_capture ->> 'capability_present')::BOOLEAN IS TRUE THEN
        IF (v_progressed_member ->> 'capability_generation') IS NULL THEN
          RAISE EXCEPTION
            'the grant source capability is not covered by the authority this attempt committed'
            USING ERRCODE = 'MOA07';
        END IF;
        v_source_expected := v_source_expected || jsonb_build_object(
          'capability_generation',
            (v_progressed_member ->> 'capability_generation')::BIGINT);
      END IF;
      PERFORM public.meta_oauth_attempt_require_captured_account(
        p_user_id, v_source_expected);
    END IF;
  END IF;

  -- Every captured or progressed member: id, connection version, fence,
  -- Instagram generation, credential revision and subject. A later
  -- selection uses only the progression this attempt itself wrote.
  IF (v_progression ->> 'credential_id') IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_require_members(
      p_user_id,
      (v_progression ->> 'credential_id')::UUID,
      (v_progression ->> 'credential_revision')::BIGINT,
      v_progression ->> 'provider_user_id',
      COALESCE(v_progression -> 'accounts', '[]'::JSONB));
  ELSIF v_grant_capture IS NOT NULL THEN
    PERFORM public.meta_oauth_attempt_require_members(
      p_user_id,
      (v_grant_capture ->> 'credential_id')::UUID,
      (v_grant_capture ->> 'credential_revision')::BIGINT,
      v_grant_capture ->> 'provider_user_id',
      COALESCE(v_grant_capture -> 'members', '[]'::JSONB));
  ELSIF jsonb_typeof(v_progression -> 'accounts') = 'array' THEN
    -- A direct attempt has no user grant. Later selections of this attempt
    -- still refuse a generation change on an account this attempt itself
    -- already committed. There is no live version to adopt.
    FOR v_item IN
      SELECT e.value
        FROM jsonb_array_elements(v_progression -> 'accounts') AS e(value)
    LOOP
      IF COALESCE(v_item ->> 'platform', 'instagram') = 'instagram'
         AND (v_item ->> 'capability_generation') IS NOT NULL THEN
        SELECT c.credential_generation
          INTO v_live_capability_generation
          FROM public.instagram_account_capabilities AS c
         WHERE c.social_account_id = (v_item ->> 'social_account_id')::UUID
           AND c.user_id = p_user_id;
        IF v_live_capability_generation IS DISTINCT FROM
           (v_item ->> 'capability_generation')::BIGINT THEN
          RAISE EXCEPTION
            'a progressed account capability generation no longer matches'
            USING ERRCODE = 'MOA07';
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_intent = 'rebind' THEN
    IF v_grant_capture IS NULL
       OR (v_grant_capture ->> 'provider_user_id') IS NULL THEN
      RAISE EXCEPTION
        'a rebind requires a captured facebook user grant; a same-subject change is a reconnect'
        USING ERRCODE = 'MOA01';
    END IF;
    IF (v_progression ->> 'credential_id') IS NULL
       AND (v_grant_capture ->> 'provider_user_id') IS NOT DISTINCT FROM v_facebook_user_id THEN
      RAISE EXCEPTION
        'a same-subject rebind is a reconnect'
        USING ERRCODE = 'MOA01';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- The credential this selection writes or binds.
  --
  --   1. The credential this attempt's own commits returned. Only the
  --      progression may supply it; a live recapture may not.
  --   2. The captured grant credential, whose token this selection
  --      replaces.
  --   3. A new credential, created by this attempt.
  -- ---------------------------------------------------------------------
  v_credential := NULL;
  v_credential_from_progression := false;

  IF v_writes_user_grant THEN
    IF (v_progression ->> 'credential_id') IS NOT NULL THEN
      v_credential := (v_progression ->> 'credential_id')::UUID;
      v_credential_from_progression := true;
    ELSIF v_grant_capture IS NOT NULL AND v_intent <> 'rebind' THEN
      -- Rebind does not adopt the captured grant. A different verified
      -- subject gets a new credential; the old grant and its unselected
      -- siblings stay untouched.
      v_credential := (v_grant_capture ->> 'credential_id')::UUID;
    END IF;

    IF v_credential IS NOT NULL THEN
      SELECT c.revision, c.provider_user_id
        INTO v_credential_revision, v_credential_provider
        FROM public.facebook_user_credentials AS c
       WHERE c.id = v_credential AND c.user_id = p_user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'the facebook user credential this attempt depends on no longer exists'
          USING ERRCODE = 'MOA07';
      END IF;
      IF v_credential_provider IS DISTINCT FROM v_facebook_user_id THEN
        RAISE EXCEPTION
          'the verified facebook user id does not match the grant this attempt captured'
          USING ERRCODE = 'MOA07';
      END IF;
      IF v_credential_from_progression THEN
        -- The progression's revision is the authority. A live change to the
        -- credential after the attempt's own commit is a refusal, not a
        -- silent adoption.
        IF v_credential_revision IS DISTINCT FROM
           (v_progression ->> 'credential_revision')::BIGINT THEN
          RAISE EXCEPTION
            'the facebook user credential changed since this attempt committed it'
            USING ERRCODE = 'MOA07';
        END IF;
      ELSIF v_credential_revision IS DISTINCT FROM
            (v_grant_capture ->> 'credential_revision')::BIGINT THEN
        RAISE EXCEPTION
          'the captured credential revision no longer matches the live credential'
          USING ERRCODE = 'MOA07';
      END IF;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- The identity-alias scope.
  --
  -- The alias belongs to ONE Instagram account: the account this
  -- selection writes. A Facebook Page account, an unselected sibling and
  -- every other row keep their metadata exactly as it is.
  --
  -- Previous kind is the locked capability login_kind, read here, before
  -- the account update and before the capability bump. The capture's
  -- generation and login_kind were already revalidated under these locks.
  -- ig_auth_type is not read. A stored alias is not a previous kind.
  -- NULL means no capability row, which is not itself a failure.
  -- ---------------------------------------------------------------------
  v_new_classification := CASE WHEN v_login_kind = 'direct'
                               THEN 'direct' ELSE 'page_linked' END;
  v_ig_metadata_prev_id := NULL;
  v_prev_metadata := NULL;
  v_prev_classification := NULL;
  v_live_capability_login_kind := NULL;

  IF v_flow IN ('instagram_direct', 'instagram_page_linked') THEN
    IF v_account_exists THEN
      v_ig_metadata_prev_id := v_account;
    END IF;
  ELSIF v_flow = 'facebook_page' AND v_candidate_kind = 'page_plus_ig' THEN
    IF v_linked_capture IS NOT NULL THEN
      v_ig_metadata_prev_id := (v_linked_capture ->> 'social_account_id')::UUID;
    END IF;
  END IF;

  IF v_ig_metadata_prev_id IS NOT NULL THEN
    SELECT sa.account_metadata
      INTO v_prev_metadata
      FROM public.social_accounts AS sa
     WHERE sa.id = v_ig_metadata_prev_id
       AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the account % disappeared while the selection was committed',
        v_ig_metadata_prev_id USING ERRCODE = 'MOA07';
    END IF;

    SELECT c.login_kind
      INTO v_live_capability_login_kind
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_ig_metadata_prev_id
       AND c.user_id = p_user_id;
    IF FOUND THEN
      v_prev_classification := v_live_capability_login_kind;
    END IF;
  END IF;

  -- Decide the identity write, and refuse, before the account row changes.
  -- Kind and platform_user_id are the authority. Metadata never selects
  -- the relationship. A no-op does not rewrite outer shape. SQL NULL and
  -- JSON null become empty objects only after a write is decided.
  v_has_second_id := false;
  v_canonical_drift := false;
  v_canonical_malformed := false;
  v_second_malformed := false;
  v_identity_mutate := false;
  v_repair_canonical := false;
  v_next_metadata := v_prev_metadata;
  IF v_prev_metadata IS NOT NULL
     AND jsonb_typeof(v_prev_metadata) = 'object' THEN
    v_has_second_id := v_prev_metadata ? 'ig_igid';
    IF v_has_second_id
       AND NOT (
         jsonb_typeof(v_prev_metadata -> 'ig_igid') = 'string'
         AND (v_prev_metadata ->> 'ig_igid') = btrim(v_prev_metadata ->> 'ig_igid')
         AND char_length(v_prev_metadata ->> 'ig_igid') BETWEEN 1 AND 128
         AND (v_prev_metadata ->> 'ig_igid') !~ '[[:cntrl:]]'
       ) THEN
      v_second_malformed := true;
    END IF;
    IF v_prev_metadata ? 'ig_user_id' THEN
      IF jsonb_typeof(v_prev_metadata -> 'ig_user_id') = 'string'
         AND (v_prev_metadata ->> 'ig_user_id') = btrim(v_prev_metadata ->> 'ig_user_id')
         AND char_length(v_prev_metadata ->> 'ig_user_id') BETWEEN 1 AND 128
         AND (v_prev_metadata ->> 'ig_user_id') !~ '[[:cntrl:]]' THEN
        IF (v_prev_metadata ->> 'ig_user_id') IS DISTINCT FROM v_ig_user_id THEN
          v_canonical_drift := true;
        END IF;
      ELSE
        v_canonical_malformed := true;
      END IF;
    END IF;
  END IF;

  IF v_alias IS NOT NULL THEN
    v_identity_mutate := true;
  ELSIF v_prev_classification IS NULL THEN
    IF v_has_second_id OR v_canonical_drift OR v_canonical_malformed THEN
      RAISE EXCEPTION
        'existing identity metadata cannot be retained without a recorded login kind'
        USING ERRCODE = 'MOA11';
    END IF;
  ELSIF v_prev_classification IS DISTINCT FROM v_new_classification THEN
    v_identity_mutate := true;
  ELSIF v_canonical_malformed OR v_second_malformed THEN
    RAISE EXCEPTION
      'stored identity metadata cannot be reconciled'
      USING ERRCODE = 'MOA11';
  ELSIF v_canonical_drift THEN
    v_identity_mutate := true;
    v_repair_canonical := true;
  END IF;

  IF v_identity_mutate THEN
    IF v_repair_canonical THEN
      -- Unchanged relationship. Rewrite only the stale canonical
      -- duplicate. A valid second id stays; omission is not deletion.
      v_next_metadata := v_prev_metadata
        || jsonb_build_object('ig_user_id', v_ig_user_id);
    ELSE
      IF v_prev_metadata IS NULL
         OR jsonb_typeof(v_prev_metadata) = 'null' THEN
        v_next_metadata := '{}'::JSONB;
      ELSIF jsonb_typeof(v_prev_metadata) = 'object' THEN
        v_next_metadata := v_prev_metadata;
      ELSE
        RAISE EXCEPTION
          'stored account metadata is not a JSON object'
          USING ERRCODE = 'MOA10';
      END IF;

      IF v_alias IS NOT NULL THEN
        v_next_metadata := v_next_metadata
          || jsonb_build_object('ig_igid', v_alias, 'ig_user_id', v_ig_user_id);
      ELSIF v_new_classification = 'direct' THEN
        -- Actual page-linked to direct conversion, with no verified
        -- replacement alias. Remove the obsolete second id.
        v_next_metadata := (v_next_metadata - 'ig_igid')
          || jsonb_build_object('ig_user_id', v_ig_user_id);
      ELSE
        v_next_metadata := (v_next_metadata - 'ig_igid')
          || jsonb_build_object('ig_user_id', v_ig_user_id);
        IF v_prev_metadata IS NOT NULL
           AND jsonb_typeof(v_prev_metadata) = 'object'
           AND jsonb_typeof(v_prev_metadata -> 'ig_igid') = 'string'
           AND (v_prev_metadata ->> 'ig_igid') = v_ig_user_id THEN
          v_next_metadata := v_next_metadata
            || jsonb_build_object('ig_igid', v_ig_user_id);
        END IF;
      END IF;
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- The account row.
  -- ---------------------------------------------------------------------
  IF v_flow = 'facebook_page' THEN
    IF v_candidate_kind = 'page_plus_ig'
       AND v_intent IN ('reconnect', 'rebind')
       AND v_linked_capture IS NULL THEN
      RAISE EXCEPTION
        'a page-plus-instagram reconnect requires the captured linked Instagram account'
        USING ERRCODE = 'MOA01';
    END IF;
    v_account := public.meta_oauth_attempt_upsert_operational_account(
      p_user_id,
      CASE WHEN v_account_exists THEN v_account ELSE NULL END,
      'facebook', v_page_id, v_candidate ->> 'facebook_page_name', NULL,
      v_account_token, v_token_expires_at, v_profile, 'facebook_page');
    IF v_candidate_kind = 'page_plus_ig' THEN
      v_companion := public.meta_oauth_attempt_upsert_operational_account(
        p_user_id,
        CASE WHEN v_linked_capture IS NULL THEN NULL
             ELSE (v_linked_capture ->> 'social_account_id')::UUID END,
        'instagram', v_ig_user_id, v_ig_username, v_avatar,
        v_page_token, v_page_expires, v_profile, 'facebook_page');
    END IF;
  ELSIF v_account_exists THEN
    UPDATE public.social_accounts AS sa
       SET platform_username = CASE WHEN v_ig_username IS NULL
                                     THEN sa.platform_username ELSE v_ig_username END,
           avatar_url = CASE WHEN v_avatar IS NULL
                             THEN sa.avatar_url ELSE v_avatar END,
           access_token = v_account_token,
           token_expires_at = v_token_expires_at,
           is_active = true,
           social_profile_id = CASE WHEN v_profile IS NULL
                                     THEN sa.social_profile_id ELSE v_profile END,
           needs_reauth = false,
           failure_count = 0,
           last_refresh_error = NULL,
           ig_auth_type = CASE WHEN v_login_kind = 'direct'
                               THEN 'business_login' ELSE 'facebook_page' END,
           updated_at = now()
     WHERE sa.id = v_account
       AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the account % disappeared while the selection was committed', v_account
        USING ERRCODE = 'MOA07';
    END IF;
  ELSE
    BEGIN
      INSERT INTO public.social_accounts (
        user_id, platform, platform_user_id, platform_username, avatar_url,
        access_token, token_expires_at, is_active, social_profile_id,
        needs_reauth, failure_count, last_refresh_error, ig_auth_type,
        connected_at, updated_at
      ) VALUES (
        p_user_id, 'instagram', v_ig_user_id, v_ig_username, v_avatar,
        v_account_token, v_token_expires_at, true, v_profile,
        false, 0, NULL,
        CASE WHEN v_login_kind = 'direct' THEN 'business_login' ELSE 'facebook_page' END,
        now(), now()
      )
      RETURNING id INTO v_account;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION
          'an Instagram account with this provider identity already exists; reconnect it explicitly'
          USING ERRCODE = 'MOA05';
    END;
  END IF;

  -- ---------------------------------------------------------------------
  -- The identity alias.
  --
  -- Two nonsecret identity keys are in scope: ig_igid and ig_user_id.
  -- Every other metadata key is preserved. The candidate object is never
  -- copied. Replay returned before the mutation guard and never reaches
  -- this block.
  --
  -- A verified alias always sets both keys inside a valid outer value.
  -- Without one, a known previous kind is cleaned up only when the kind
  -- itself changes. A stale ig_user_id on an unchanged kind is repaired
  -- in place and does not remove ig_igid. An unknown previous kind
  -- refuses when either identity key holds an unresolved assertion.
  -- No such assertion and no verified alias means no metadata write,
  -- including when the stored JSON is not an object.
  --
  -- Outer shape is checked only after a replacing write has been decided:
  --   SQL NULL and JSON null become {}.
  --   an object is merged in place.
  --   anything else is MOA10 and the transaction rolls back.
  -- A malformed identity key inside an object is MOA11, not MOA10.
  -- Neither message contains metadata or a display hint.
  -- ---------------------------------------------------------------------
  v_ig_metadata_account := NULL;
  IF v_flow IN ('instagram_direct', 'instagram_page_linked') THEN
    v_ig_metadata_account := v_account;
  ELSIF v_flow = 'facebook_page' AND v_candidate_kind = 'page_plus_ig' THEN
    v_ig_metadata_account := v_companion;
  END IF;

  IF v_identity_mutate
     AND v_ig_metadata_account IS NOT NULL
     AND v_next_metadata IS DISTINCT FROM v_prev_metadata THEN
    UPDATE public.social_accounts AS sa
       SET account_metadata = v_next_metadata,
           updated_at = now()
     WHERE sa.id = v_ig_metadata_account
       AND sa.user_id = p_user_id
       AND sa.platform = 'instagram';
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the account % disappeared while the identity alias was applied',
        v_ig_metadata_account USING ERRCODE = 'MOA07';
    END IF;
  END IF;

  -- The natural-key insert above can wait. An expiry that arrived during
  -- that wait rolls the whole transition back, including the account row.
  PERFORM public.meta_oauth_attempt_assert_live_expiries(
    v_attempt, v_picker, v_pending_expires_at, v_token_expires_at,
    CASE WHEN v_writes_user_grant THEN v_grant_expires ELSE NULL END);

  -- ---------------------------------------------------------------------
  -- The capability record. The authoritative login classification.
  -- A Facebook Page account does not get an Instagram capability row.
  -- ---------------------------------------------------------------------
  IF v_flow <> 'facebook_page' THEN
    v_capability_generation := public.meta_oauth_attempt_bump_instagram_capability(
      p_user_id, v_account, v_login_kind, v_operation);
  END IF;
  IF v_companion IS NOT NULL THEN
    v_companion_generation := public.meta_oauth_attempt_bump_instagram_capability(
      p_user_id, v_companion, 'page_linked', v_operation);
    v_capability_generation := v_companion_generation;
  END IF;

  -- ---------------------------------------------------------------------
  -- The Facebook User credential and the binding.
  -- ---------------------------------------------------------------------
  IF v_writes_user_grant THEN
    IF v_credential IS NULL THEN
      -- This attempt creates the grant. Rebind always takes this path for
      -- its first selection: the captured grant is not updated.
      INSERT INTO public.facebook_user_credentials (
        user_id, token, revision, lifecycle, token_expires_at,
        provider_user_id, provenance_source, provenance_captured_at,
        created_at, updated_at
      ) VALUES (
        p_user_id, v_pending_token, 1, 'active', v_grant_expires,
        v_facebook_user_id, 'oauth_exchange', now(), now(), now()
      )
      RETURNING id INTO v_credential;
      v_credential_revision := 1;
    ELSIF NOT v_credential_from_progression THEN
      -- The captured grant keeps its identity and gets the fresh token.
      UPDATE public.facebook_user_credentials AS c
         SET token = v_pending_token,
             revision = c.revision + 1,
             token_expires_at = v_grant_expires,
             provenance_source = 'oauth_exchange',
             provenance_captured_at = now(),
             updated_at = now()
       WHERE c.id = v_credential
         AND c.user_id = p_user_id
         AND c.revision = (v_grant_capture ->> 'credential_revision')::BIGINT
      RETURNING c.revision INTO v_credential_revision;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'the captured credential revision no longer matches the live credential'
          USING ERRCODE = 'MOA07';
      END IF;
      -- Every other member of this grant moves with the replaced User
      -- token. The accounts this selection advances itself are excluded
      -- so they are not incremented twice. Their operational tokens and
      -- health columns are not written here.
      PERFORM public.meta_oauth_attempt_invalidate_grant(
        p_user_id,
        v_credential,
        COALESCE(v_grant_capture -> 'members', '[]'::JSONB),
        ARRAY[v_account] || CASE WHEN v_companion IS NULL THEN ARRAY[]::UUID[]
                                 ELSE ARRAY[v_companion] END);
    ELSE
      v_credential_revision := (v_progression ->> 'credential_revision')::BIGINT;
    END IF;

    PERFORM public.meta_oauth_attempt_assert_live_expiries(
      v_attempt, v_picker, v_pending_expires_at, v_token_expires_at,
      CASE WHEN v_writes_user_grant THEN v_grant_expires ELSE NULL END);

    IF v_account_exists AND v_live_binding_present IS TRUE THEN
      IF v_live_binding_credential IS DISTINCT FROM v_credential THEN
        -- A REBIND to a different credential. The old binding is detached
        -- and only the old binding: the siblings of the old grant survive.
        DELETE FROM public.facebook_user_credential_bindings AS b
         WHERE b.social_account_id = v_account AND b.user_id = p_user_id;
      ELSE
        -- The same credential. The binding's connection version advances.
        v_connection_version := public.facebook_user_credential_commit_connection_version(
          p_user_id, v_account, v_expected_binding_connection);
      END IF;
    END IF;

    IF v_connection_version IS NULL THEN
      v_connection_version := public.facebook_user_credential_allocate_connection_version(
        v_account, p_user_id,
        CASE WHEN v_flow = 'facebook_page' THEN 'facebook' ELSE 'instagram' END);
      INSERT INTO public.facebook_user_credential_bindings (
        social_account_id, user_id, platform, credential_id,
        verified_facebook_user_id, verified_facebook_page_id,
        verified_instagram_user_id, evidence_source, connection_version,
        created_at, updated_at
      ) VALUES (
        v_account, p_user_id,
        CASE WHEN v_flow = 'facebook_page' THEN 'facebook' ELSE 'instagram' END,
        v_credential,
        v_facebook_user_id,
        CASE WHEN v_flow = 'facebook_page' THEN NULL ELSE v_page_id END,
        CASE WHEN v_flow = 'facebook_page' THEN NULL ELSE v_ig_user_id END,
        'oauth_exchange',
        v_connection_version, now(), now()
      );
    END IF;

    IF v_flow <> 'facebook_page' THEN
      PERFORM public.facebook_user_credential_sync_instagram_linkage(
        v_account, p_user_id, v_credential);
    END IF;

    IF v_companion IS NOT NULL THEN
      -- Detach only the binding this attempt captured on this companion.
      -- A binding that appeared after capture was already refused. There
      -- is no fallback that deletes whatever binding is live now.
      IF v_intent = 'rebind'
         AND v_linked_capture IS NOT NULL
         AND (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE THEN
        DELETE FROM public.facebook_user_credential_bindings AS b
         WHERE b.social_account_id = v_companion
           AND b.user_id = p_user_id
           AND b.credential_id = (v_linked_capture ->> 'binding_credential_id')::UUID;
      END IF;
      IF v_linked_capture IS NOT NULL
         AND (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE
         AND (v_linked_capture ->> 'binding_credential_id')::UUID = v_credential
         AND v_intent <> 'rebind' THEN
        v_companion_connection := public.facebook_user_credential_commit_connection_version(
          p_user_id, v_companion,
          (v_linked_capture ->> 'binding_connection_version')::BIGINT);
      ELSE
        v_companion_connection := public.facebook_user_credential_allocate_connection_version(
          v_companion, p_user_id, 'instagram');
        INSERT INTO public.facebook_user_credential_bindings (
          social_account_id, user_id, platform, credential_id,
          verified_facebook_user_id, verified_facebook_page_id,
          verified_instagram_user_id, evidence_source, connection_version,
          created_at, updated_at
        ) VALUES (
          v_companion, p_user_id, 'instagram', v_credential,
          v_facebook_user_id, v_page_id, v_ig_user_id, 'oauth_exchange',
          v_companion_connection, now(), now()
        );
      END IF;
      PERFORM public.facebook_user_credential_sync_instagram_linkage(
        v_companion, p_user_id, v_credential);
    END IF;
  ELSIF v_account_exists AND v_live_binding_present IS TRUE THEN
    -- A conversion from page-linked to direct. The old binding is detached
    -- and only the old binding: the siblings of the old grant survive. The
    -- delete trigger advances the surviving fence and collects an orphaned
    -- credential.
    DELETE FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = v_account AND b.user_id = p_user_id;
  END IF;

  -- ---------------------------------------------------------------------
  -- The receipt. Nonsecret, whitelisted.
  -- ---------------------------------------------------------------------
  -- After the capability update and the binding writes. Those waits are
  -- later than the account-row check. An expiry here rolls back every
  -- write in this transition, including a generation that was bumped.
  PERFORM public.meta_oauth_attempt_assert_live_expiries(
    v_attempt, v_picker, v_pending_expires_at, v_token_expires_at,
    CASE WHEN v_writes_user_grant THEN v_grant_expires ELSE NULL END);

  v_receipt := jsonb_build_object(
    'attempt_id', v_attempt,
    'selection_key', v_selection_key,
    'flow', v_flow,
    'intent', v_intent,
    'platform', CASE WHEN v_flow = 'facebook_page' THEN 'facebook' ELSE 'instagram' END,
    'platform_user_id', CASE WHEN v_flow = 'facebook_page' THEN v_page_id ELSE v_ig_user_id END,
    'instagram_user_id', v_ig_user_id,
    'facebook_page_id', v_page_id,
    'facebook_user_id', v_facebook_user_id,
    'social_account_id', v_account,
    'companion_social_account_id', v_companion,
    'username', CASE WHEN v_flow = 'facebook_page' AND v_candidate_kind = 'page_only'
                     THEN v_candidate ->> 'facebook_page_name' ELSE v_ig_username END,
    'operation', v_operation,
    'login_kind', v_login_kind,
    'credential_id', v_credential,
    'credential_revision', v_credential_revision,
    'connection_version', v_connection_version,
    'capability_generation', v_capability_generation,
    'committed_at', v_now
  );

  INSERT INTO public.meta_oauth_attempt_receipts (
    attempt_id, user_id, selection_key, platform, platform_user_id,
    instagram_user_id, facebook_page_id, facebook_user_id, social_account_id,
    companion_social_account_id,
    credential_id, credential_revision, connection_version,
    capability_generation, login_kind, receipt, committed_at
  ) VALUES (
    v_attempt, p_user_id, v_selection_key,
    CASE WHEN v_flow = 'facebook_page' THEN 'facebook' ELSE 'instagram' END,
    CASE WHEN v_flow = 'facebook_page' THEN v_page_id ELSE v_ig_user_id END,
    v_ig_user_id, v_page_id, v_facebook_user_id, v_account,
    v_companion,
    v_credential, v_credential_revision, v_connection_version,
    v_capability_generation, v_login_kind, v_receipt, v_now
  )
  ON CONFLICT (attempt_id, selection_key) DO NOTHING;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the selection % was committed concurrently', v_selection_key
      USING ERRCODE = 'MOA03';
  END IF;

  -- ---------------------------------------------------------------------
  -- The attempt-local progression. This is the only authority a later
  -- selection of THIS attempt may use.
  -- ---------------------------------------------------------------------
  UPDATE public.meta_oauth_attempts AS a
     SET authority_progression = jsonb_build_object(
           'credential_id', v_credential,
           'credential_revision', v_credential_revision,
           'provider_user_id', CASE WHEN v_writes_user_grant THEN v_facebook_user_id ELSE NULL END,
           'accounts', CASE
             WHEN v_credential IS NULL THEN (
               SELECT COALESCE(jsonb_agg(
                        jsonb_build_object(
                          'social_account_id', e.value ->> 'social_account_id',
                          'platform', COALESCE(e.value ->> 'platform', 'instagram'),
                          'platform_user_id', e.value ->> 'platform_user_id',
                          'connection_version', e.value ->> 'connection_version',
                          'capability_generation', e.value ->> 'capability_generation'
                        )
                      ), '[]'::JSONB)
                 FROM jsonb_array_elements(
                        COALESCE(a.authority_progression -> 'accounts', '[]'::JSONB)
                      ) AS e(value)
                WHERE (e.value ->> 'social_account_id')::UUID <> v_account
             ) || jsonb_build_array(jsonb_build_object(
                    'social_account_id', v_account,
                    'platform', 'instagram',
                    'platform_user_id', v_ig_user_id,
                    'connection_version', v_connection_version,
                    'capability_generation', v_capability_generation
                  ))
             ELSE (
               SELECT COALESCE(jsonb_agg(
                        jsonb_build_object(
                          'social_account_id', b.social_account_id,
                          'platform', b.platform,
                          'platform_user_id', sa.platform_user_id,
                          'connection_version', b.connection_version,
                          'capability_generation', cap.credential_generation
                        )
                        ORDER BY b.social_account_id
                      ), '[]'::JSONB)
                 FROM public.facebook_user_credential_bindings AS b
                 JOIN public.social_accounts AS sa
                   ON sa.id = b.social_account_id AND sa.user_id = b.user_id
                 LEFT JOIN public.instagram_account_capabilities AS cap
                   ON cap.social_account_id = b.social_account_id
                  AND cap.user_id = b.user_id
                WHERE b.credential_id = v_credential
                  AND b.user_id = p_user_id
             )
           END
         ),
         updated_at = now()
   WHERE a.id = v_attempt AND a.user_id = p_user_id;

  -- ---------------------------------------------------------------------
  -- The stash. The selected candidate and its token are consumed; the rest
  -- of the stash survives so the picker can select further accounts.
  -- ---------------------------------------------------------------------
  SELECT count(*) INTO v_remaining
    FROM jsonb_array_elements(v_pending_candidates) AS e(value)
   WHERE public.meta_oauth_attempt_selection_key(v_flow, e.value) <> v_selection_key;

  IF v_remaining = 0 THEN
    DELETE FROM public.oauth_pending_instagram_selections
     WHERE id = v_pending AND user_id = p_user_id AND meta_oauth_attempt_id = v_attempt;
    UPDATE public.meta_oauth_attempts AS a
       SET status = 'completed',
           pending_selection_id = NULL,
           updated_at = now()
     WHERE a.id = v_attempt AND a.user_id = p_user_id;
  ELSE
    UPDATE public.oauth_pending_instagram_selections AS ps
       SET ig_candidates_json = (
             SELECT COALESCE(jsonb_agg(e.value ORDER BY e.value ->> 'ig_user_id'), '[]'::JSONB)
               FROM jsonb_array_elements(ps.ig_candidates_json) AS e(value)
              WHERE public.meta_oauth_attempt_selection_key(v_flow, e.value) <> v_selection_key
           )
     WHERE ps.id = v_pending AND ps.user_id = p_user_id AND ps.meta_oauth_attempt_id = v_attempt;
  END IF;

  -- Restore the caller's guard. Replay returned before this was set, so
  -- an identical retry does not leave the guard behind for a later statement.
  PERFORM set_config(
    'postora.meta_oauth_attempt', COALESCE(v_prior_guard, ''), true);

  RETURN v_receipt;
END;
$function$;

COMMENT ON FUNCTION public.commit_meta_oauth_selection(UUID, JSONB) IS
  'Consumes ONE verified candidate from the attempt''s own stash and applies '
  'the whole account transition in one transaction: create or reactivate the '
  'account, write the operational token, bind or rebind the shared Facebook '
  ' User credential, advance the fences and the capability generation, reset '
  'the stale permission evidence, record the nonsecret receipt and consume '
  'the selected secret. A verified direct Instagram alias is applied inside '
  'the same transaction, and only to the two nonsecret identity keys of the '
  'one Instagram account the selection writes. An identical retry returns '
  'the same receipt with ZERO mutations; a conflicting retry refuses.';
