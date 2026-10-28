-- ===========================================================================
-- 20261028110000_meta_page_token_reconciliation.sql
--
-- The captured Page-token reconciliation writer.
--
-- WHAT THIS MIGRATION IS
-- ----------------------
-- The accepted Page capture returns only the operational Page token, and the
-- accepted facebook_user_token success writer rotates the shared User secret.
-- Neither can reconcile a derived operational Page token: one has no Page
-- derivation at all, and the other writes the User secret, not the Page
-- token an account publishes with.
--
-- This migration adds the missing atomic half: ONE new service-only writer
-- that consumes an existing open `facebook_user_token` capture and applies a
-- Page token that the service derived from THAT capture's User grant.
--
--   public.write_meta_page_reconciliation_success(p_user_id, p_payload)
--
-- WHAT IT DELIBERATELY IS NOT
-- ---------------------------
--   * It is not a User-grant renewal. The User secret, its revision, its
--     expiry and its provenance are never written here. Renewal of the User
--     grant stays the reconnect/OAuth path.
--   * It is not a second capture store. It reuses the accepted capture
--     relation, the accepted lock discipline, the accepted captured-account
--     validator, the accepted membership validator and the accepted fence
--     writers. There is no new table, no new capture projection, no new
--     begin wrapper and no new operation enum value.
--   * It is not a claim about Meta. SQL constrains a trusted service
--     assertion; it cannot prove that Meta returned this token.
--   * It is not a complete runtime module. It is the database half of a
--     contract whose HTTP half is a later slice.
--
-- THE CONTRACT
-- ------------
--   Payload, exactly three keys:
--
--     {"capture_id": "uuid",
--      "operation": "page_reconciliation",
--      "fields": {
--        "access_token": "the derived clean Page token",
--        "facebook_page_id": "the verified Page identifier",
--        "instagram_user_id": "the captured Instagram identifier, or JSON null",
--        "token_expires_at": null}}
--
--   `fields` has exactly those four keys and all four are required.
--   `token_expires_at` must be an explicit JSON null: the derived Page token
--   has no established expiry, and an unknown expiry is not infinite
--   validity and does not inherit the User grant's expiry. An omitted
--   property is not a null.
--
--   Result, exactly these keys:
--
--     {capture_id, operation: "page_reconciliation", applied: true,
--      credential_id, credential_revision, credential_generation,
--      expiry_state: "unknown", account}
--
--   `credential_revision` is UNCHANGED: this writer never rotates the User
--   secret. `credential_generation` is the next Instagram capability
--   generation, or null for a Facebook Page, whose connection fence is the
--   authority instead.
--
-- PROTECTED IDENTITY
-- ------------------
--   The service may only assert an identity the protected binding already
--   proves:
--
--     Instagram  the submitted Instagram identifier must equal the binding's
--                verified_instagram_user_id AND the captured canonical
--                account identity; the submitted Page identifier must equal
--                the binding's verified_facebook_page_id.
--     Both       the binding's verified_facebook_user_id must equal the
--                captured provider subject AND the locked credential
--                subject.
--     Facebook   the submitted Page identifier must equal the captured
--                canonical account identity and the submitted Instagram
--                identifier must be JSON null. The binding's Page and
--                Instagram columns are legitimately null on a Facebook
--                binding, and no Instagram capability is required.
--
--   Missing evidence refuses. It is never bootstrapped from account
--   metadata, a username or a provider response.
--
--   This covers the supported lifecycle writers, which advance the relevant
--   fence when an identity relationship changes. A raw service-role write
--   that changes an identity column WITHOUT advancing that fence is outside
--   this guarantee, and this writer does not claim to detect the history of
--   such writes. It still refuses a submitted identity that disagrees with
--   the locked protected evidence.
--
-- WHAT IS WRITTEN
-- ---------------
--   Only the selected account's operational access_token, an explicit unknown
--   SQL NULL token_expires_at, and the accepted failure-evidence reset
--   (failure_count = 0, last_refresh_error = NULL) on that account.
--   needs_reauth, is_active, the refresh token, account metadata, the
--   permission state, the User grant, and every unselected sibling keep
--   their values. The selected Instagram account advances its capability
--   generation exactly once; the selected Facebook Page advances its
--   connection and binding fence exactly once. No sibling fence is bumped
--   and no companion account is written.
--
-- SQLSTATE
-- --------
--   MAR01  malformed or unsupported request payload
--   MAR02  unknown or foreign resource (not found, or not owned)
--   MAR03  ineligible account or capture for the requested operation
--   MAR04  stale capture, closed capture, or protected evidence that is
--          missing or does not agree with the submitted identity
--   MAR05  contention: retry the whole transaction
--   MAR06  operation or credential-kind mismatch
--   MAR07  a known expiry in scope has already passed
--
--   No message in this migration contains a token, and there is no catch-all
--   exception handler: a real cancellation stays a cancellation.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The helpers.
--
--    SECURITY INVOKER, reachable by the migration owner alone. They exist so
--    the two load-bearing policies of this contract -- what a clean
--    provider value looks like, and what the protected binding must prove --
--    are stated once instead of being restated inside the writer.
-- ---------------------------------------------------------------------------

-- A clean operational token literal.
--
-- The literal is preserved exactly: it is stored as submitted and never
-- trimmed or rewritten. What is refused is a value that could not be a
-- token at all -- empty, longer than the accepted limit, carrying leading or
-- trailing whitespace, or carrying an ASCII control character or DEL.
--
-- "Whitespace" at the boundary is the ECMAScript String.prototype.trim set,
-- not btrim's default and not the locale class [:space:]. btrim() with no
-- second argument removes only U+0020, so NBSP and BOM at the edges would
-- otherwise be stored. The comparison below refuses a value that differs
-- from its boundary-trimmed form. The trimmed copy is never stored.
-- An interior character from this set is not edge whitespace.
--
--   U+0009..U+000D  U+0020  U+00A0  U+1680  U+2000..U+200A
--   U+2028  U+2029  U+202F  U+205F  U+3000  U+FEFF
CREATE OR REPLACE FUNCTION public.meta_page_reconciliation_require_token(
  p_value TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  c_edge CONSTANT TEXT :=
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) ||
    chr(32) || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
    chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) ||
    chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) ||
    chr(65279);
BEGIN
  IF p_value IS NULL
     OR char_length(p_value) = 0
     OR char_length(p_value) > 4096
     OR btrim(p_value, c_edge) IS DISTINCT FROM p_value
     OR p_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION
      'access_token must be a non-empty clean string of at most 4096 characters'
      USING ERRCODE = 'MAR01';
  END IF;
  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.meta_page_reconciliation_require_token(TEXT) IS
  'SECURITY INVOKER, revoked from service_role, anon and authenticated. Accepts a clean operational token literal: non-empty, at most '
  '4096 characters, no leading or trailing ECMAScript-trim whitespace '
  '(U+0009..U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, '
  'U+202F, U+205F, U+3000, U+FEFF), no ASCII control character and no DEL. '
  'Interior characters from that set stay. The literal is returned unchanged; '
  'it is never trimmed or rewritten. SQLSTATE MAR01.';

-- A clean, bounded provider identifier.
--
-- This is the accepted provider-identifier policy of the protected binding
-- relation: one to 128 characters, no surrounding whitespace, no ASCII
-- control character. The boundary set is the same explicit ECMAScript trim
-- set as the token helper: both claim "no surrounding whitespace", and
-- btrim's default would miss NBSP and BOM. It is deliberately NOT a
-- numeric-only rule and NOT a ban on other Unicode: a provider identifier
-- is an opaque string, and a character that is legal inside a literal stays
-- legal there.
CREATE OR REPLACE FUNCTION public.meta_page_reconciliation_require_identifier(
  p_value TEXT,
  p_field TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  c_edge CONSTANT TEXT :=
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) ||
    chr(32) || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
    chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) ||
    chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) ||
    chr(65279);
BEGIN
  IF p_value IS NULL
     OR char_length(p_value) NOT BETWEEN 1 AND 128
     OR btrim(p_value, c_edge) IS DISTINCT FROM p_value
     OR p_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION
      '% must be a clean provider identifier of 1 to 128 characters', p_field
      USING ERRCODE = 'MAR01';
  END IF;
  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.meta_page_reconciliation_require_identifier(TEXT, TEXT) IS
  'SECURITY INVOKER, revoked from service_role, anon and authenticated. Accepts a clean bounded provider identifier: 1 to 128 '
  'characters, no leading or trailing ECMAScript-trim whitespace '
  '(U+0009..U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, '
  'U+202F, U+205F, U+3000, U+FEFF), no ASCII control character and no DEL. '
  'Not a numeric-only rule. Interior characters from that set stay. The '
  'literal is returned unchanged. SQLSTATE MAR01.';

-- The captured Facebook User grant expiry.
--
-- Two separate questions, asked in this order:
--
--   * does the captured expiry still describe the locked grant? A grant
--     whose expiry changed after the capture is not the grant this attempt
--     captured, and an unknown expiry is never turned into a known one.
--   * is a KNOWN expiry still live? An unknown expiry is not a known expiry
--     and is not a validity proof either: it stays unknown.
--
-- The captured value is compared with the locked value, and the liveness
-- test uses the live clock, so this is called again after the writes that
-- can wait.
CREATE OR REPLACE FUNCTION public.meta_page_reconciliation_require_user_grant_expiry(
  p_captured_expiry TIMESTAMPTZ,
  p_live_expiry TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_captured_expiry IS DISTINCT FROM p_live_expiry THEN
    RAISE EXCEPTION
      'the captured Facebook User grant expiry no longer matches the live grant'
      USING ERRCODE = 'MAR04';
  END IF;

  IF p_captured_expiry IS NOT NULL
     AND clock_timestamp() >= p_captured_expiry THEN
    RAISE EXCEPTION
      'the captured Facebook User grant expiry has already passed'
      USING ERRCODE = 'MAR07';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.meta_page_reconciliation_require_user_grant_expiry(TIMESTAMPTZ, TIMESTAMPTZ) IS
  'SECURITY INVOKER, revoked from service_role, anon and authenticated. Requires the captured Facebook User grant expiry to still '
  'describe the locked grant (MAR04 when it does not) and, when that expiry '
  'is known, to still be live (MAR07 when it has passed). An unknown expiry '
  'is neither a mismatch nor a validity proof.';

-- The protected binding evidence.
--
-- This is the load-bearing comparison of the contract. The service asserts
-- an identity; the locked protected binding must already prove it. There is
-- no path here that reads account metadata, a username or a provider
-- response, and no path that fills a missing verified column.
CREATE OR REPLACE FUNCTION public.meta_page_reconciliation_require_protected_identity(
  p_user_id UUID,
  p_account UUID,
  p_platform TEXT,
  p_canonical_id TEXT,
  p_page_id TEXT,
  p_instagram_id TEXT,
  p_captured_subject TEXT,
  p_locked_subject TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_binding_present BOOLEAN := false;
  v_verified_user TEXT;
  v_verified_page TEXT;
  v_verified_instagram TEXT;
BEGIN
  SELECT b.verified_facebook_user_id, b.verified_facebook_page_id,
         b.verified_instagram_user_id
    INTO v_verified_user, v_verified_page, v_verified_instagram
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_account
     AND b.user_id = p_user_id;
  v_binding_present := FOUND;

  IF NOT v_binding_present THEN
    RAISE EXCEPTION
      'the target account % carries no protected binding', p_account
      USING ERRCODE = 'MAR04';
  END IF;

  -- Both platforms. The binding's verified Facebook User identity is the
  -- captured provider subject AND the locked credential subject. A missing
  -- verified identity is missing evidence, not an empty string to match.
  IF v_verified_user IS NULL
     OR p_captured_subject IS NULL
     OR p_locked_subject IS NULL
     OR v_verified_user IS DISTINCT FROM p_captured_subject
     OR v_verified_user IS DISTINCT FROM p_locked_subject THEN
    RAISE EXCEPTION
      'the protected binding of account % does not carry the captured Facebook User identity',
      p_account
      USING ERRCODE = 'MAR04';
  END IF;

  IF p_platform = 'instagram' THEN
    -- The Instagram account needs the full protected relationship, and both
    -- halves must be present before either is compared.
    IF v_verified_instagram IS NULL OR v_verified_page IS NULL THEN
      RAISE EXCEPTION
        'the protected binding of account % carries no verified Page or Instagram identity',
        p_account
        USING ERRCODE = 'MAR04';
    END IF;

    IF p_instagram_id IS DISTINCT FROM v_verified_instagram THEN
      RAISE EXCEPTION
        'the submitted Instagram identity does not match the protected binding of account %',
        p_account
        USING ERRCODE = 'MAR04';
    END IF;

    IF p_instagram_id IS DISTINCT FROM p_canonical_id THEN
      RAISE EXCEPTION
        'the submitted Instagram identity does not match the captured identity of account %',
        p_account
        USING ERRCODE = 'MAR04';
    END IF;

    IF p_page_id IS DISTINCT FROM v_verified_page THEN
      RAISE EXCEPTION
        'the submitted Page identity does not match the protected binding of account %',
        p_account
        USING ERRCODE = 'MAR04';
    END IF;
  ELSE
    -- A Facebook Page. Its Page identity is the captured canonical identity
    -- of the account, and it carries no Instagram identity. The binding's
    -- Page and Instagram columns are legitimately null here: the accepted
    -- OAuth creates a Facebook binding that way, and no Instagram
    -- capability is required for a Facebook Page.
    IF p_page_id IS DISTINCT FROM p_canonical_id THEN
      RAISE EXCEPTION
        'the submitted Page identity does not match the captured identity of account %',
        p_account
        USING ERRCODE = 'MAR04';
    END IF;

    IF p_instagram_id IS NOT NULL THEN
      RAISE EXCEPTION
        'the Facebook Page target % carries no Instagram identity', p_account
        USING ERRCODE = 'MAR04';
    END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.meta_page_reconciliation_require_protected_identity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'SECURITY INVOKER, revoked from service_role, anon and authenticated. Requires the locked protected binding to prove the submitted '
  'identity. Instagram: the submitted Instagram identifier must equal the '
  'binding''s verified_instagram_user_id and the captured canonical identity, '
  'and the submitted Page identifier must equal the binding''s '
  'verified_facebook_page_id. Both platforms: the binding''s '
  'verified_facebook_user_id must equal the captured provider subject and '
  'the locked credential subject. Facebook: the submitted Page identifier '
  'must equal the captured canonical identity and the submitted Instagram '
  'identifier must be null. Missing evidence refuses (MAR04) and is never '
  'bootstrapped.';

-- ---------------------------------------------------------------------------
-- 2. write_meta_page_reconciliation_success.
--
--    The atomic half of the captured Page-token reconciliation.
--
--    The lock order is the accepted one: the owner first, then the captured
--    membership plus the explicit targets in sorted order with their guard
--    and capability advisory locks, then the credential. The lock set is
--    built from the CAPTURE, never from a live re-read, so a member that
--    appeared after the capture is not pulled in and a member that left is
--    not silently dropped.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_meta_page_reconciliation_success(
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
  v_capture_id UUID;
  v_capture JSONB;
  v_fields JSONB;
  v_targets JSONB;
  v_target JSONB;
  v_account UUID;
  v_platform TEXT;
  v_canonical_id TEXT;
  v_credential JSONB;
  v_credential_id UUID;
  v_revision BIGINT;
  v_subject TEXT;
  v_captured_expiry TIMESTAMPTZ;
  v_live_expiry TIMESTAMPTZ;
  v_live_revision BIGINT;
  v_live_subject TEXT;
  v_lifecycle TEXT;
  v_binding_credential UUID;
  v_members JSONB;
  v_lock_accounts UUID[];
  v_token TEXT;
  v_page_id TEXT;
  v_instagram_id TEXT;
  v_generation BIGINT;
  v_next_generation BIGINT;
  v_state JSONB;
BEGIN
  -- --- the request, before any lock ---------------------------------------

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MAR01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MAR01';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('capture_id', 'operation', 'fields') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;

  PERFORM public.meta_account_refresh_require_json(p_payload, 'capture_id', 'string');
  v_capture_id := public.meta_account_refresh_uuid(
    p_payload ->> 'capture_id', 'capture_id');

  -- The discriminator selects THIS writer. It does not rename the stored
  -- capture and it does not change what the other writers accept.
  PERFORM public.meta_account_refresh_require_json(p_payload, 'operation', 'string');
  IF (p_payload ->> 'operation') IS DISTINCT FROM 'page_reconciliation' THEN
    RAISE EXCEPTION
      'write_meta_page_reconciliation_success reconciles a Page token; the operation must be page_reconciliation'
      USING ERRCODE = 'MAR06';
  END IF;

  v_fields := public.meta_account_refresh_require_json(p_payload, 'fields', 'object');

  -- The field whitelist is exact and every field is required. An unknown
  -- field is refused before a lock is taken, so it can never reach the
  -- account row.
  FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
    IF v_key NOT IN (
      'access_token', 'facebook_page_id', 'instagram_user_id', 'token_expires_at'
    ) THEN
      RAISE EXCEPTION 'unsupported page reconciliation field: %', v_key
        USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;
  IF NOT (v_fields ? 'access_token') THEN
    RAISE EXCEPTION 'access_token is required' USING ERRCODE = 'MAR01';
  END IF;
  IF NOT (v_fields ? 'facebook_page_id') THEN
    RAISE EXCEPTION 'facebook_page_id is required' USING ERRCODE = 'MAR01';
  END IF;
  IF NOT (v_fields ? 'instagram_user_id') THEN
    RAISE EXCEPTION 'instagram_user_id is required' USING ERRCODE = 'MAR01';
  END IF;
  IF NOT (v_fields ? 'token_expires_at') THEN
    RAISE EXCEPTION 'token_expires_at is required' USING ERRCODE = 'MAR01';
  END IF;

  -- The derived Page token has no established expiry. An explicit JSON
  -- null says so. An omitted property is not a null, and a supplied
  -- timestamp is not supported by this contract: it would be an invented
  -- lifetime.
  IF jsonb_typeof(v_fields -> 'token_expires_at') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION
      'token_expires_at must be an explicit JSON null; the reconciled Page token has no established expiry'
      USING ERRCODE = 'MAR01';
  END IF;

  IF jsonb_typeof(v_fields -> 'access_token') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION
      'access_token must be a non-empty clean string of at most 4096 characters'
      USING ERRCODE = 'MAR01';
  END IF;
  IF jsonb_typeof(v_fields -> 'facebook_page_id') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION
      'facebook_page_id must be a clean provider identifier of 1 to 128 characters'
      USING ERRCODE = 'MAR01';
  END IF;
  IF jsonb_typeof(v_fields -> 'instagram_user_id')
       NOT IN ('string', 'null') THEN
    RAISE EXCEPTION
      'instagram_user_id must be a clean provider identifier of 1 to 128 characters, or null for a Facebook Page'
      USING ERRCODE = 'MAR01';
  END IF;

  v_token := public.meta_page_reconciliation_require_token(v_fields ->> 'access_token');
  v_page_id := public.meta_page_reconciliation_require_identifier(
    v_fields ->> 'facebook_page_id', 'facebook_page_id');
  -- A JSON null is a legal value here: a Facebook Page target carries no
  -- Instagram identity. Whether null is correct is decided later, by the
  -- platform the capture describes.
  IF jsonb_typeof(v_fields -> 'instagram_user_id') = 'null' THEN
    v_instagram_id := NULL;
  ELSE
    v_instagram_id := public.meta_page_reconciliation_require_identifier(
      v_fields ->> 'instagram_user_id', 'instagram_user_id');
  END IF;

  -- --- the captured authority ---------------------------------------------

  -- The owner first. An owner delete cascades into the accounts, so waiting
  -- for it while this transaction holds those rows is the cycle.
  PERFORM public.meta_account_refresh_lock_owner(p_user_id);

  -- The capture row is a lock target and is taken NOWAIT. A busy capture is
  -- MAR05, and a capture that is not open is MAR04.
  v_capture := public.meta_account_refresh_load_capture(
    p_user_id, v_capture_id, 'facebook_user_token');

  v_targets := public.meta_account_refresh_capture_targets(v_capture);
  -- One owner-scoped explicit target per attempt. A capture that names
  -- several targets is not eligible for this single-target operation.
  IF jsonb_array_length(v_targets) <> 1 THEN
    RAISE EXCEPTION
      'a page reconciliation capture must describe exactly one explicit target'
      USING ERRCODE = 'MAR03';
  END IF;
  v_target := public.meta_account_refresh_capture_target(v_capture);
  v_account := public.meta_account_refresh_uuid(
    v_target ->> 'social_account_id', 'captured social_account_id');

  v_credential := v_capture -> 'credential';
  IF v_credential IS NULL OR jsonb_typeof(v_credential) <> 'object' THEN
    RAISE EXCEPTION 'the captured shared grant is missing' USING ERRCODE = 'MAR04';
  END IF;
  v_credential_id := public.meta_account_refresh_uuid(
    v_credential ->> 'credential_id', 'captured credential_id');
  v_revision := public.meta_account_refresh_uint(
    v_credential -> 'revision', 'captured credential revision', false);
  v_subject := v_credential ->> 'provider_user_id';
  v_captured_expiry := public.meta_account_refresh_timestamp(
    v_credential ->> 'token_expires_at', 'captured credential token_expires_at');

  v_members := v_capture -> 'members';
  IF v_members IS NULL OR jsonb_typeof(v_members) <> 'array' THEN
    RAISE EXCEPTION 'the captured shared grant membership is missing'
      USING ERRCODE = 'MAR04';
  END IF;

  -- The lock set is the captured membership plus the captured targets, in
  -- sorted order. It is never expanded from a live re-read: a member that
  -- appeared after the capture is not locked, and the comparison below
  -- refuses it.
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::UUID[])
    INTO v_lock_accounts
    FROM (
      SELECT (e.value ->> 'social_account_id')::UUID AS x
        FROM jsonb_array_elements(v_members) AS e(value)
      UNION
      SELECT (e.value ->> 'social_account_id')::UUID
        FROM jsonb_array_elements(v_targets) AS e(value)
    ) AS ids
   WHERE x IS NOT NULL;

  PERFORM public.meta_account_refresh_lock_scope(
    p_user_id, v_lock_accounts, ARRAY[v_credential_id]);

  -- The capture lifetime is checked after the locks, against the live clock.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

  -- The complete captured membership must still be the live membership, and
  -- the explicit target must still be on that captured grant.
  PERFORM public.meta_account_refresh_require_members(
    p_user_id, v_credential_id, v_members);
  PERFORM public.meta_account_refresh_require_target_on_grant(
    p_user_id, v_credential_id, v_members, v_target);

  -- The captured account must still match the live account: identity,
  -- binding, fence, capability, health and expiry.
  PERFORM public.meta_account_refresh_require_captured_account(p_user_id, v_target);

  -- The locked credential must still be the captured credential. The User
  -- secret is never written here, so this grant is only ever read.
  SELECT c.revision, c.provider_user_id, c.token_expires_at, c.lifecycle
    INTO v_live_revision, v_live_subject, v_live_expiry, v_lifecycle
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF NOT FOUND
     OR v_live_revision IS DISTINCT FROM v_revision
     OR v_live_subject IS DISTINCT FROM v_subject THEN
    RAISE EXCEPTION
      'the captured shared grant no longer matches the live credential'
      USING ERRCODE = 'MAR04';
  END IF;
  IF v_lifecycle IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'the captured Facebook User grant is not active' USING ERRCODE = 'MAR03';
  END IF;

  -- The captured User expiry must still describe the locked grant, and a
  -- known expiry must still be live.
  PERFORM public.meta_page_reconciliation_require_user_grant_expiry(
    v_captured_expiry, v_live_expiry);

  -- The target must still be an eligible account of that grant: active, a
  -- page-linked Instagram or a Facebook Page, and still bound to the
  -- captured credential.
  v_binding_credential := public.meta_account_refresh_require_eligibility(
    p_user_id, v_account, 'facebook_user_token');
  IF v_binding_credential IS DISTINCT FROM v_credential_id THEN
    RAISE EXCEPTION
      'the target account is no longer bound to the captured grant'
      USING ERRCODE = 'MAR04';
  END IF;

  -- The submitted identity must be the one the locked protected binding
  -- already proves.
  v_platform := v_target ->> 'platform';
  v_canonical_id := v_target ->> 'platform_user_id';
  PERFORM public.meta_page_reconciliation_require_protected_identity(
    p_user_id, v_account, v_platform, v_canonical_id,
    v_page_id, v_instagram_id, v_subject, v_live_subject);

  -- --- the write ----------------------------------------------------------

  -- Only the selected account's operational token and its explicit unknown
  -- expiry. The accepted writer preserves the refresh token, needs_reauth,
  -- is_active, account metadata and the permission state, because none of
  -- them is in this field set.
  PERFORM public.meta_account_refresh_apply_account_fields(
    p_user_id, v_account,
    jsonb_build_object('access_token', v_token, 'token_expires_at', NULL));

  -- The accepted failure-evidence reset, on the selected account only.
  -- needs_reauth is untouched: only the OAuth lifecycle may clear it.
  PERFORM public.meta_account_refresh_clear_failure_evidence(p_user_id, v_account);

  -- The applicable fence advances exactly once. An Instagram account's
  -- authority is its capability generation; a Facebook Page's authority is
  -- its connection and binding fence, and its reported generation stays
  -- null.
  IF v_platform = 'instagram' THEN
    v_generation := public.meta_account_refresh_uint(
      v_target -> 'capability_generation', 'capability_generation', true);
    v_next_generation := public.meta_account_refresh_advance_generation(
      p_user_id, v_account, v_generation, 'credential_refreshed');
  ELSE
    BEGIN
      PERFORM public.facebook_user_credential_commit_connection_version(
        p_user_id, v_account,
        (v_target ->> 'binding_connection_version')::BIGINT);
    EXCEPTION
      WHEN SQLSTATE 'FUC01' THEN
        RAISE EXCEPTION
          'the captured Facebook Page connection fence no longer matches'
          USING ERRCODE = 'MAR04';
    END;
    v_next_generation := NULL;
  END IF;

  -- --- after the writes that can wait --------------------------------------

  -- The capture deadline and the known captured User expiry are rechecked
  -- against the live clock. A refusal here rolls the token, the expiry, the
  -- failure evidence, the fence and this capture back together.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);
  PERFORM public.meta_page_reconciliation_require_user_grant_expiry(
    v_captured_expiry, v_live_expiry);

  -- The capture is consumed once. A closed capture is never writable again.
  UPDATE public.meta_account_refresh_captures AS c
     SET status = 'completed'
   WHERE c.id = v_capture_id AND c.user_id = p_user_id;

  v_state := public.meta_account_refresh_account_state(p_user_id, v_account);

  RETURN jsonb_build_object(
    'capture_id', v_capture_id,
    'operation', 'page_reconciliation',
    'applied', true,
    'credential_id', v_credential_id,
    -- UNCHANGED: this writer never rotates the User secret.
    'credential_revision', v_revision,
    'credential_generation', v_next_generation,
    'expiry_state', 'unknown',
    'account', v_state);
END;
$function$;

COMMENT ON FUNCTION public.write_meta_page_reconciliation_success(UUID, JSONB) IS
  'Service-only. Reconciles one captured operational Page token from an open '
  'facebook_user_token capture of the SAME owner, using the captured User '
  'grant unchanged. The derived Page token and an explicit unknown expiry '
  '(SQL NULL) are written to the selected account only; the accepted '
  'failure-evidence reset is applied to that account only; the selected '
  'Instagram account advances its capability generation exactly once and the '
  'selected Facebook Page advances its connection and binding fence exactly '
  'once. The User secret, its revision, its expiry and its provenance are '
  'never written, needs_reauth is never cleared, and no sibling is touched. '
  'The submitted identity must equal the locked protected binding evidence. '
  'Payload: {"capture_id":"...","operation":"page_reconciliation","fields":'
  '{"access_token":"...","facebook_page_id":"...","instagram_user_id":"...|'
  'null","token_expires_at":null}}. Result: {capture_id, operation, applied, '
  'credential_id, credential_revision, credential_generation, expiry_state, '
  'account}. SQLSTATE MAR01..MAR07.';

-- ---------------------------------------------------------------------------
-- 3. Privileges.
--
--     The stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--     anon, authenticated, so every REVOKE below is load-bearing. The new
--     RPC is revoked from PUBLIC, anon and authenticated and granted to
--     service_role. The privileged postgres role keeps EXECUTE through the
--     same default privileges as the accepted refresh RPCs; that is not a
--     browser grant and is not revoked here. The helpers are SECURITY INVOKER,
--     revoked from service_role as well as PUBLIC, anon and authenticated,
--     and granted to the migration owner, exactly like the accepted
--     prerequisite internals. service_role must not call them directly.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.write_meta_page_reconciliation_success(UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.write_meta_page_reconciliation_success(UUID, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.meta_page_reconciliation_require_token(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.meta_page_reconciliation_require_token(TEXT)
  TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.meta_page_reconciliation_require_identifier(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.meta_page_reconciliation_require_identifier(TEXT, TEXT)
  TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.meta_page_reconciliation_require_user_grant_expiry(TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.meta_page_reconciliation_require_user_grant_expiry(TIMESTAMPTZ, TIMESTAMPTZ)
  TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.meta_page_reconciliation_require_protected_identity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.meta_page_reconciliation_require_protected_identity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- 4. Assert the boundary this migration claims, before it commits.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
DECLARE
  f_sig regprocedure;
  v_helper RECORD;
  v_prosecdef BOOLEAN;
  v_provolatile TEXT;
  v_proconfig TEXT[];
BEGIN
  -- The new RPC is service-only, SECURITY DEFINER and volatile, with a
  -- controlled search_path.
  f_sig := 'public.write_meta_page_reconciliation_success(uuid,jsonb)'::regprocedure;
  ASSERT has_function_privilege('service_role', f_sig, 'EXECUTE'),
    'service_role may execute the page reconciliation writer';
  ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
    'anon may not execute the page reconciliation writer';
  ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
    'authenticated may not execute the page reconciliation writer';

  SELECT p.prosecdef, p.provolatile, p.proconfig
    INTO v_prosecdef, v_provolatile, v_proconfig
    FROM pg_proc AS p
   WHERE p.oid = f_sig;
  ASSERT v_prosecdef, 'the page reconciliation writer is SECURITY DEFINER';
  ASSERT v_provolatile = 'v', 'the page reconciliation writer is volatile';
  ASSERT v_proconfig @> ARRAY['search_path=public'],
    'the page reconciliation writer has a controlled search_path';

  -- The helpers stay SECURITY INVOKER. service_role, anon and authenticated
  -- cannot execute them. postgres keeps its default EXECUTE.
  FOR v_helper IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef AS prosecdef
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'meta\_page\_reconciliation\_%'
  LOOP
    ASSERT NOT v_helper.prosecdef,
      format('%s is SECURITY INVOKER', v_helper.sig);
    ASSERT NOT has_function_privilege('anon', v_helper.sig, 'EXECUTE'),
      format('anon may not execute %s', v_helper.sig);
    ASSERT NOT has_function_privilege('authenticated', v_helper.sig, 'EXECUTE'),
      format('authenticated may not execute %s', v_helper.sig);
    ASSERT NOT has_function_privilege('service_role', v_helper.sig, 'EXECUTE'),
      format('service_role may not execute %s directly', v_helper.sig);
  END LOOP;

  -- No new relation, and no new secret-bearing column anywhere.
  ASSERT NOT EXISTS (
    SELECT 1
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND c.relname LIKE 'meta\_page\_reconciliation\_%'
  ), 'no page reconciliation relation exists';

  -- The accepted lifecycle RPCs keep their exact service-only surface.
  FOREACH f_sig IN ARRAY ARRAY[
    'public.begin_meta_account_refresh(uuid,jsonb)',
    'public.write_direct_instagram_account(uuid,jsonb)',
    'public.write_meta_account_refresh_success(uuid,jsonb)',
    'public.record_meta_refresh_failure(uuid,jsonb)'
  ]::regprocedure[] LOOP
    ASSERT has_function_privilege('service_role', f_sig, 'EXECUTE'),
      format('service_role may execute %s', f_sig);
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('anon may not execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('authenticated may not execute %s', f_sig);
  END LOOP;

  -- The capture relation is unchanged: service-only, RLS, no browser policy,
  -- and no secret column.
  ASSERT (SELECT c.relrowsecurity
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = 'meta_account_refresh_captures'),
    'RLS is still enabled on public.meta_account_refresh_captures';

  ASSERT NOT EXISTS (
    SELECT 1
      FROM pg_policy AS p
      JOIN pg_class AS c ON c.oid = p.polrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'meta_account_refresh_captures'
  ), 'no browser policy exists on public.meta_account_refresh_captures';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meta_account_refresh_captures'
       AND column_name IN (
         'token', 'access_token', 'refresh_token', 'secret', 'provider_response'
       )
  ), 'the capture relation still holds no secret column';

  RAISE NOTICE
    'meta page token reconciliation: verified. The new writer is granted to '
    'service_role, SECURITY DEFINER with a controlled search_path; postgres '
    'keeps the same default EXECUTE as the accepted RPCs. The helpers are '
    'SECURITY INVOKER and revoked from service_role. No relation was added. '
    'The accepted lifecycle RPCs and the capture relation are unchanged.';
END
$assert_boundary$;

COMMIT;
