-- Committing a Facebook Page consumes both of its alternatives.
--
-- OLD: a facebook_page stash held one candidate per Page, so
-- commit_meta_oauth_selection consumed only the selected key.
--
-- NEW: the Facebook callback stashes two alternatives for a Page with a
-- linked Instagram account, page_plus_ig and page_only, so the owner is asked
-- whether the Instagram account is connected too. Committing either one now
-- also consumes the other alternative for the same Page. A connected Page
-- therefore cannot reappear in the picker, and the attempt reaches
-- "completed" once every Page is connected. The other flows keep one
-- candidate per account, so the predicate matches only the selected key
-- there.
--
-- Everything else in the function is byte-for-byte the definition from
-- 20261105100000_meta_oauth_reuse_linked_instagram.sql.

CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_consumed_by(
  p_flow TEXT,
  p_candidate JSONB,
  p_selection_key TEXT,
  p_page_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT public.meta_oauth_attempt_selection_key(p_flow, p_candidate) = p_selection_key
      OR (p_flow = 'facebook_page' AND p_candidate ->> 'facebook_page_id' = p_page_id);
$function$;

REVOKE ALL ON FUNCTION public.meta_oauth_attempt_consumed_by(TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

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
  -- The user's own existing page-linked Instagram, adopted as the
  -- companion of a new Facebook Page instead of refused.
  v_reuse_companion BOOLEAN := false;
  v_reuse_binding_credential UUID;
  v_reuse_auth_type TEXT;

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

  -- A new Facebook Page whose linked Instagram already exists for THIS
  -- user. The row joins the locked set, with its binding credential, and is
  -- captured under those locks below. The lookup is user-scoped; another
  -- user's row with the same Instagram id is never read.
  IF v_flow = 'facebook_page'
     AND v_intent NOT IN ('reconnect', 'rebind')
     AND v_candidate_kind = 'page_plus_ig'
     AND v_linked_capture IS NULL THEN
    SELECT sa.id INTO v_companion
      FROM public.social_accounts AS sa
     WHERE sa.user_id = p_user_id
       AND sa.platform = 'instagram'
       AND sa.platform_user_id = v_ig_user_id;
    IF FOUND THEN
      v_reuse_companion := true;
      v_accounts := v_accounts || v_companion;
      v_parent_ids := v_parent_ids || v_companion;
      SELECT b.credential_id INTO v_reuse_binding_credential
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.social_account_id = v_companion
         AND b.user_id = p_user_id;
      v_credentials := v_credentials || v_reuse_binding_credential;
    END IF;
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

  -- The adopted Instagram, captured under the locks just taken. From here
  -- it is the linked target: the checks, the metadata scope, the upsert
  -- and the companion binding below all read v_linked_capture.
  IF v_reuse_companion THEN
    v_linked_capture := public.meta_oauth_attempt_capture_account(
      p_user_id, v_companion);
    -- The binding moved between the unlocked read and the lock, so the
    -- locked credential set may be wrong. Retry the whole transaction.
    IF (v_linked_capture ->> 'binding_credential_id')::UUID
       IS DISTINCT FROM v_reuse_binding_credential THEN
      RAISE EXCEPTION
        'the existing Instagram account changed while the selection was committed; retry'
        USING ERRCODE = 'MOA09';
    END IF;
    SELECT sa.ig_auth_type INTO v_reuse_auth_type
      FROM public.social_accounts AS sa
     WHERE sa.id = v_companion
       AND sa.user_id = p_user_id;
    -- A direct-login account is not silently converted to page-linked.
    -- A capability row is the authority; ig_auth_type only covers an
    -- account connected before capability rows existed.
    IF (v_linked_capture ->> 'capability_login_kind') = 'direct'
       OR ((v_linked_capture ->> 'capability_present')::BOOLEAN IS NOT TRUE
           AND v_reuse_auth_type = 'business_login') THEN
      RAISE EXCEPTION
        'an Instagram account with this provider identity already exists as a direct login; reconnect it explicitly'
        USING ERRCODE = 'MOA05';
    END IF;
    -- A different Facebook user is a subject change, which only an
    -- explicit rebind may make.
    IF (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE
       AND (v_linked_capture ->> 'provider_user_id') IS DISTINCT FROM v_facebook_user_id THEN
      RAISE EXCEPTION
        'an Instagram account with this provider identity is bound to a different Facebook user; reconnect it explicitly'
        USING ERRCODE = 'MOA05';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- The account this selection applies to.
  --
  --   reconnect  -> the captured target, reactivated when it was inactive
  --   otherwise  -> create-only, and an existing natural key is a typed
  --                 conflict, never an adoption. The one exception is the
  --                 linked Instagram of a new Facebook Page, adopted above.
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
    -- The linked Instagram is not refused here: an existing row of this
    -- user was adopted and captured above. The companion id is assigned
    -- again by the account write below.
    IF v_candidate_kind = 'page_plus_ig' THEN
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
      -- is no fallback that deletes whatever binding is live now. An
      -- adopted Instagram is always rebound the same way, even on this
      -- attempt's own credential: its binding records the Page it was
      -- verified through, and the adopted account now belongs to v_page_id.
      IF v_linked_capture IS NOT NULL
         AND (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE
         AND (v_intent = 'rebind' OR v_reuse_companion) THEN
        DELETE FROM public.facebook_user_credential_bindings AS b
         WHERE b.social_account_id = v_companion
           AND b.user_id = p_user_id
           AND b.credential_id = (v_linked_capture ->> 'binding_credential_id')::UUID;
      END IF;
      IF v_linked_capture IS NOT NULL
         AND (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE
         AND (v_linked_capture ->> 'binding_credential_id')::UUID = v_credential
         AND v_intent <> 'rebind'
         AND NOT v_reuse_companion THEN
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
  -- The stash. The selected candidate and its token are consumed, and so is
  -- the other alternative for the same Facebook Page; the rest of the stash
  -- survives so the picker can select further accounts.
  -- ---------------------------------------------------------------------
  SELECT count(*) INTO v_remaining
    FROM jsonb_array_elements(v_pending_candidates) AS e(value)
   WHERE NOT public.meta_oauth_attempt_consumed_by(v_flow, e.value, v_selection_key, v_page_id);

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
              WHERE NOT public.meta_oauth_attempt_consumed_by(v_flow, e.value, v_selection_key, v_page_id)
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
  'Consumes ONE verified candidate from the attempt''s own stash (and, for a '
  'Facebook Page, its other alternative) and applies '
  'the whole account transition in one transaction: create or reactivate the '
  'account, write the operational token, bind or rebind the shared Facebook '
  ' User credential, advance the fences and the capability generation, reset '
  'the stale permission evidence, record the nonsecret receipt and consume '
  'the selected secret. A verified direct Instagram alias is applied inside '
  'the same transaction, and only to the two nonsecret identity keys of the '
  'one Instagram account the selection writes. A new Facebook Page adopts '
  'the same user''s existing page-linked Instagram as its companion, unless '
  'that account is a direct login or is bound to a different Facebook user. '
  'An identical retry returns the same receipt with ZERO mutations; a '
  'conflicting retry refuses.';
