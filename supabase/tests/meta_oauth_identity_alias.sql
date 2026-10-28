-- ===========================================================================
-- supabase/tests/meta_oauth_identity_alias.sql
--
-- The narrow protected OAuth identity-alias prerequisite
-- (migration 20261028100000).
--
-- Instagram Login issues two identifiers for one account: the app-scoped
-- id (profile.id) that the publishing and conversation endpoints address,
-- and the distinct Instagram-scoped id (profile.user_id, the IGID) that the
-- messaging webhooks and the self-comment check resolve. The legacy direct
-- writer stored the second one as the nonsecret account_metadata key
-- "ig_igid". The captured OAuth lifecycle could not carry it.
--
-- WHAT IS ASSERTED HERE
--
--   A1  the catalog boundary: no table, no column, no function and no
--       public RPC was added, and the two replaced functions keep their
--       exact signature, volatility, SECURITY DEFINER posture, controlled
--       search_path and grants.
--   A2  the callback accepts the alias for instagram_direct only, and
--       refuses an explicit null, a wrong type, a blank value, surrounding
--       whitespace, an over-long value and a control character. It refuses
--       the field on every Facebook and Page-linked flow.
--   A3  the alias is persisted immutably in the existing protected pending
--       candidate and is never exposed in a picker or a receipt.
--   A4  a new direct connect with a verified alias installs the alias and
--       the canonical app-scoped key, and nothing else.
--   A5  an alias equal to the canonical id is accepted.
--   A6  an unchanged direct reconnect with the alias applies it and
--       synchronizes the canonical key, preserving unrelated metadata.
--   A7  an unchanged direct reconnect WITHOUT the alias asserts nothing:
--       a valid alias is preserved, none is deleted and none is
--       manufactured.
--   A8  a page-linked to direct conversion applies the newly verified
--       alias and never inherits an old one; an omitted alias removes the
--       old second id and synchronizes ig_user_id to the selected
--       canonical id. The previous kind is the protected capability row.
--   A9  a direct to page-linked conversion synchronizes the canonical key
--       and removes an obsolete alias unless that alias IS the canonical
--       identity.
--   A10 a page-plus-instagram selection confines the alias change to the
--       Instagram companion, and only when its classification changes. The
--       Facebook Page identity and the unselected siblings are untouched.
--   A11 the authority refusals: wrong owner, wrong claim, wrong target,
--       wrong provider identity, a stale generation, a stale attempt and a
--       browser-supplied alias. Each refusal leaves the whole state
--       byte-identical.
--   A12 no secret is copied into the metadata, and the alias is not an
--       authority of its own.
--   A13 a receipt replay is read-only: it applies no alias, repairs no
--       metadata and cannot resurrect an alias a later conversion removed.
--   A14 a deliberate failure after the alias write and before the receipt
--       rolls the whole transition back.
--   A15 the accepted no-alias paths are unchanged: an untouched
--       page-linked account and an untouched direct account keep their
--       metadata exactly.
--   A16 protected login_kind, not ig_auth_type, decides both conversion
--       directions. Correct, stale, null and unsupported display hints
--       produce the same metadata. An unchanged direct reconnect keeps
--       its alias when the hint is stale.
--   A17 identity-mutating paths accept SQL null and JSON null as an empty
--       object and preserve unrelated object keys. Array, string, number
--       and boolean metadata refuse MOA10 with no state change. A no-op
--       path does not inspect or rewrite a non-object.
--   A18 capability absence is not a failure. A verified alias replaces
--       both keys. No ig_igid and no alias writes nothing. An existing
--       ig_igid with no recorded kind refuses MOA11.
--   A19 a direct reconnect whose stored ig_user_id disagrees with the
--       selected canonical id repairs that duplicate and keeps a valid
--       second id. The protected kind and the platform id do not change.
--       Stale metadata is not an identity transition.
--   A20 omitted and supplied aliases are paired across a missing, equal,
--       stale or malformed canonical duplicate and a valid, missing or
--       malformed second id, for a known direct account and for a row
--       with no capability. Refusals leave the owner fingerprint
--       unchanged. A replay after the repair writes nothing.
--
-- One transaction, synthetic fixtures, ROLLBACK. No provider calls, no
-- live tokens, no network. Every token in this file is the literal string
-- 'synthetic-not-a-live-secret' or one of its labelled variants.
--
-- The multi-session concurrency controls are NOT here. They live in
-- supabase/tests/meta_oauth_identity_alias_race_fixture.sql, a manual
-- two-session rehearsal that the ordinary rollback suite never runs.
-- ===========================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
--   mia_owner    owns one profile and a set of Instagram and Facebook Page
--                accounts in every classification the alias rules must
--                distinguish.
--   mia_other    a foreign owner. Everything of his is unreachable.
--
-- Every fixture row carries a fixed updated_at, so that a write inside
-- this transaction is visible in the state fingerprint instead of hiding
-- behind now() being constant for the whole transaction.
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  u_other uuid := '0eb00002-0000-4000-8000-000000000002';
  t_old   timestamptz := '2026-10-01 00:00:00+00'::timestamptz;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_owner, 'mia-owner-' || u_owner::text || '@example.invalid'),
    (u_other, 'mia-other-' || u_other::text || '@example.invalid');

  INSERT INTO public.social_profiles (id, user_id, name)
  VALUES ('0eb10001-0000-4000-8000-000000000011', u_owner, 'MIA Owner Profile');

  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, social_profile_id, account_metadata, ig_auth_type,
    connected_at, updated_at
  ) VALUES
    -- a DIRECT account that carries the legacy alias and unrelated metadata
    ('0eb20001-0000-4000-8000-000000000021', u_owner, 'instagram',
     'mia-ig-direct-1', 'mia_direct_one', 'synthetic-not-a-live-secret', true,
     '0eb10001-0000-4000-8000-000000000011',
     '{"ig_user_id":"mia-ig-direct-1","ig_igid":"igid-direct-1","legacy":"kept"}'::jsonb,
     'business_login', t_old, t_old),
    -- a PAGE-LINKED account with unrelated metadata and no alias
    ('0eb20001-0000-4000-8000-000000000022', u_owner, 'instagram',
     'mia-ig-linked-1', 'mia_linked_one', 'synthetic-not-a-live-secret', true,
     '0eb10001-0000-4000-8000-000000000011',
     '{"ig_user_id":"mia-ig-linked-1","legacy":"kept"}'::jsonb,
     'facebook_page', t_old, t_old),
    -- a DIRECT account with NO alias at all
    ('0eb20001-0000-4000-8000-000000000023', u_owner, 'instagram',
     'mia-ig-noalias-1', 'mia_noalias_one', 'synthetic-not-a-live-secret', true,
     NULL, NULL, 'business_login', t_old, t_old),
    -- a Facebook Page account
    ('0eb20001-0000-4000-8000-000000000024', u_owner, 'facebook',
     'mia-page-1', 'mia_page_one', 'synthetic-not-a-live-secret', true,
     NULL, '{"legacy":"page"}'::jsonb, 'facebook_page', t_old, t_old),
    -- a DIRECT Instagram companion of that page, with the legacy alias
    ('0eb20001-0000-4000-8000-000000000025', u_owner, 'instagram',
     'mia-ig-companion-1', 'mia_companion_one', 'synthetic-not-a-live-secret', true,
     NULL, '{"ig_user_id":"mia-ig-companion-1","ig_igid":"igid-companion-1","legacy":"kept"}'::jsonb,
     'business_login', t_old, t_old),
    -- an unselected sibling
    ('0eb20001-0000-4000-8000-000000000026', u_owner, 'instagram',
     'mia-ig-sibling-1', 'mia_sibling_one', 'synthetic-not-a-live-secret', true,
     NULL, '{"sibling":"kept"}'::jsonb, 'facebook_page', t_old, t_old),
    -- a DIRECT account whose stored alias IS its canonical app-scoped id
    ('0eb20001-0000-4000-8000-000000000027', u_owner, 'instagram',
     'mia-ig-equal-1', 'mia_equal_one', 'synthetic-not-a-live-secret', true,
     NULL, '{"ig_igid":"mia-ig-equal-1","legacy":"kept"}'::jsonb,
     'business_login', t_old, t_old),
    -- a PAGE-LINKED account that still carries a stale alias
    ('0eb20001-0000-4000-8000-000000000028', u_owner, 'instagram',
     'mia-ig-linked-2', 'mia_linked_two', 'synthetic-not-a-live-secret', true,
     NULL, '{"ig_user_id":"obsolete-linked-2","ig_igid":"igid-stale","legacy":"kept"}'::jsonb,
     'facebook_page', t_old, t_old),
    -- a PAGE-LINKED account that is never converted, used by the
    -- accepted no-assertion path
    ('0eb20001-0000-4000-8000-00000000002a', u_owner, 'instagram',
     'mia-ig-linked-3', 'mia_linked_three', 'synthetic-not-a-live-secret', true,
     NULL, '{"ig_user_id":"mia-ig-linked-3","legacy":"kept"}'::jsonb,
     'facebook_page', t_old, t_old),
    -- a foreign owner's account
    ('0eb20002-0000-4000-8000-000000000029', u_other, 'instagram',
     'mia-ig-foreign-1', 'mia_foreign_one', 'synthetic-not-a-live-secret', true,
     NULL, NULL, 'business_login', t_old, t_old);
END
$fixtures$;

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------

-- The whole visible state of one owner: the accounts, the shared Facebook
-- User credentials, the bindings, the fences, the capability records, the
-- attempts with their capture and progression, the receipts, the pending
-- stashes and the outbox. A refusal must leave this string unchanged.
CREATE FUNCTION pg_temp.mia_fingerprint(p_owner UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $mia$
  SELECT concat_ws('|',
    coalesce((
      SELECT string_agg(concat_ws('~',
        sa.id::text, sa.platform, sa.platform_user_id,
        coalesce(sa.platform_username, ''), coalesce(sa.avatar_url, ''),
        md5(coalesce(sa.access_token, '')),
        coalesce(sa.refresh_token, ''),
        coalesce(sa.token_expires_at::text, ''),
        sa.is_active::text, coalesce(sa.social_profile_id::text, ''),
        coalesce(sa.account_metadata::text, 'NULL'),
        coalesce(sa.ig_auth_type, ''),
        sa.needs_reauth::text, sa.failure_count::text,
        coalesce(sa.last_refresh_error, ''),
        coalesce(sa.connected_at::text, ''),
        coalesce(sa.updated_at::text, '')
      ), ';' ORDER BY sa.id)
      FROM public.social_accounts AS sa
     WHERE sa.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        c.id::text, c.revision::text, c.lifecycle,
        coalesce(c.provider_user_id, ''), md5(coalesce(c.token, '')),
        coalesce(c.token_expires_at::text, ''),
        coalesce(c.provenance_source, ''), c.updated_at::text
      ), ';' ORDER BY c.id)
      FROM public.facebook_user_credentials AS c
     WHERE c.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        b.social_account_id::text, b.credential_id::text, b.platform,
        coalesce(b.verified_facebook_user_id, ''),
        coalesce(b.verified_facebook_page_id, ''),
        coalesce(b.verified_instagram_user_id, ''),
        b.evidence_source, b.connection_version::text, b.updated_at::text
      ), ';' ORDER BY b.social_account_id)
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        f.social_account_id::text, f.platform, f.connection_version::text
      ), ';' ORDER BY f.social_account_id)
      FROM public.facebook_user_credential_connection_fences AS f
     WHERE f.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        c.social_account_id::text, c.login_kind, c.permission_read_state,
        array_to_string(c.granted_scopes, ','), c.credential_generation::text,
        coalesce(c.generation_reason, ''), c.updated_at::text
      ), ';' ORDER BY c.social_account_id)
      FROM public.instagram_account_capabilities AS c
     WHERE c.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        a.id::text, a.flow, a.intent, a.status,
        coalesce(a.target_social_account_id::text, ''),
        coalesce(a.linked_target_social_account_id::text, ''),
        coalesce(a.source_social_account_id::text, ''),
        coalesce(a.pending_selection_id::text, ''),
        a.capture::text, coalesce(a.authority_progression::text, 'NULL'),
        a.updated_at::text
      ), ';' ORDER BY a.id)
      FROM public.meta_oauth_attempts AS a
     WHERE a.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        r.attempt_id::text, r.selection_key, r.platform, r.platform_user_id,
        coalesce(r.instagram_user_id, ''), coalesce(r.facebook_page_id, ''),
        coalesce(r.social_account_id::text, ''),
        coalesce(r.companion_social_account_id::text, ''),
        coalesce(r.login_kind, ''), r.receipt::text
      ), ';' ORDER BY r.attempt_id, r.selection_key)
      FROM public.meta_oauth_attempt_receipts AS r
     WHERE r.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        ps.id::text, coalesce(ps.meta_oauth_attempt_id::text, ''),
        ps.ig_candidates_json::text, md5(coalesce(ps.long_lived_token, '')),
        ps.expires_in::text, coalesce(ps.expires_at::text, '')
      ), ';' ORDER BY ps.id)
      FROM public.oauth_pending_instagram_selections AS ps
     WHERE ps.user_id = p_owner), ''),
    coalesce((
      SELECT string_agg(concat_ws('~',
        pf.id::text, coalesce(pf.meta_oauth_attempt_id::text, ''),
        pf.target_platform, pf.pages_json::text, pf.ig_standalone_json::text,
        md5(coalesce(pf.provider_token, '')),
        coalesce(pf.expires_at::text, '')
      ), ';' ORDER BY pf.id)
      FROM public.oauth_pending_facebook_selections AS pf
     WHERE pf.user_id = p_owner), '')
  );
$mia$;

-- Opens one attempt and completes its callback with the given candidate.
-- Returns the attempt id, the pending stash id and the selection key.
CREATE FUNCTION pg_temp.mia_open(
  p_owner UUID,
  p_flow TEXT,
  p_candidate JSONB,
  p_target UUID,
  p_linked UUID
)
RETURNS JSONB
LANGUAGE plpgsql
AS $mia$
DECLARE
  v_result JSONB;
  v_attempt UUID;
  v_payload JSONB;
  v_stash JSONB;
BEGIN
  v_payload := jsonb_build_object('flow', p_flow, 'intent', 'connect_new');
  IF p_target IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object(
      'intent', 'reconnect', 'target_social_account_id', p_target);
  END IF;
  IF p_linked IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object(
      'linked_target_social_account_id', p_linked);
  END IF;

  v_result := public.begin_meta_oauth_attempt(p_owner, v_payload);
  v_attempt := (v_result ->> 'attempt_id')::UUID;

  v_result := public.claim_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce', 'flow', p_flow));

  v_stash := jsonb_build_object(
    'candidates', jsonb_build_array(p_candidate),
    'user_token', 'synthetic-not-a-live-secret',
    'expires_in', 5184000);

  v_result := public.complete_meta_oauth_callback(p_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
    'stash', v_stash));

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'pending_selection_id', (v_result ->> 'pending_selection_id')::UUID,
    'selection_key', public.meta_oauth_attempt_selection_key(p_flow, p_candidate),
    'callback_result', v_result);
END
$mia$;

-- Attempts one callback with a raw candidate and returns the SQLSTATE it
-- raised, or 'accepted'.
CREATE FUNCTION pg_temp.mia_try_callback(
  p_owner UUID,
  p_flow TEXT,
  p_candidate JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
AS $mia$
DECLARE
  v_result JSONB;
  v_attempt UUID;
  v_state TEXT;
BEGIN
  BEGIN
    v_result := public.begin_meta_oauth_attempt(p_owner, jsonb_build_object(
      'flow', p_flow, 'intent', 'connect_new'));
    v_attempt := (v_result ->> 'attempt_id')::UUID;
    v_result := public.claim_meta_oauth_callback(p_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'nonce', v_result ->> 'nonce', 'flow', p_flow));
    PERFORM public.complete_meta_oauth_callback(p_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', v_result ->> 'claim_token',
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(p_candidate),
        'user_token', 'synthetic-not-a-live-secret',
        'expires_in', 5184000)));
    v_state := 'accepted';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RETURN v_state;
END
$mia$;

-- The direct candidate used by most controls.
CREATE FUNCTION pg_temp.mia_direct_candidate(
  p_ig TEXT,
  p_alias TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $mia$
  SELECT CASE WHEN p_alias IS NULL
              THEN jsonb_build_object('ig_user_id', p_ig)
              ELSE jsonb_build_object('ig_user_id', p_ig, 'ig_igid', p_alias) END;
$mia$;

-- Records the protected previous kind. expected_credential_generation 0 is
-- the accepted create token. Display ig_auth_type is not this call.
CREATE FUNCTION pg_temp.mia_cap(
  p_account UUID,
  p_owner UUID,
  p_kind TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $mia$
BEGIN
  PERFORM public.write_instagram_account_capability(
    p_account, p_owner,
    jsonb_build_object(
      'login_kind', p_kind,
      'permission_read_state', 'unknown',
      'expected_credential_generation', 0));
END
$mia$;

-- One Instagram account plus, when p_kind is not null, its protected kind.
CREATE FUNCTION pg_temp.mia_account(
  p_id UUID,
  p_owner UUID,
  p_platform_user_id TEXT,
  p_metadata JSONB,
  p_hint TEXT,
  p_kind TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $mia$
DECLARE
  t_old timestamptz := '2026-10-01 00:00:00+00'::timestamptz;
BEGIN
  INSERT INTO public.social_accounts (
    id, user_id, platform, platform_user_id, platform_username, access_token,
    is_active, account_metadata, ig_auth_type, connected_at, updated_at
  ) VALUES (
    p_id, p_owner, 'instagram', p_platform_user_id, p_platform_user_id,
    'synthetic-not-a-live-secret', true, p_metadata, p_hint, t_old, t_old);
  IF p_kind IS NOT NULL THEN
    PERFORM pg_temp.mia_cap(p_id, p_owner, p_kind);
  END IF;
END
$mia$;

-- The fixture rows whose later assertions need a previous kind. Accounts
-- with no second id and no conversion stay without a capability row so the
-- absence policy can be observed on them.
DO $caps$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
BEGIN
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000021', u_owner, 'direct');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000022', u_owner, 'page_linked');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000025', u_owner, 'direct');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000026', u_owner, 'page_linked');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000027', u_owner, 'direct');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-000000000028', u_owner, 'page_linked');
  PERFORM pg_temp.mia_cap('0eb20001-0000-4000-8000-00000000002a', u_owner, 'page_linked');
END
$caps$;

-- ---------------------------------------------------------------------------
-- A1. The catalog boundary. Nothing was added, and the two replaced
--     functions kept their exact public contract.
-- ---------------------------------------------------------------------------
DO $a1$
DECLARE
  n integer;
  s text;
BEGIN
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname ILIKE '%alias%';
  ASSERT n = 0, 'A1 no alias table exists';

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname ILIKE '%alias%';
  ASSERT n = 0, 'A1 no alias function exists';

  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'social_accounts'
     AND column_name ILIKE '%alias%';
  ASSERT n = 0, 'A1 no alias column was added to social_accounts';

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname LIKE 'meta_oauth_attempt_%';
  ASSERT n = 24, 'A1 the owner-only helper count is unchanged';

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('begin_meta_oauth_attempt', 'claim_meta_oauth_callback',
                       'complete_meta_oauth_callback', 'commit_meta_oauth_selection',
                       'read_meta_oauth_attempt', 'purge_expired_meta_oauth_pending');
  ASSERT n = 6, 'A1 the six service-only lifecycle RPCs are unchanged';

  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('complete_meta_oauth_callback', 'commit_meta_oauth_selection')
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_payload jsonb'
     AND p.provolatile = 'v' AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public'];
  ASSERT n = 2, 'A1 the two replaced functions keep their signature and posture';

  ASSERT NOT has_function_privilege(
    'anon', 'public.complete_meta_oauth_callback(uuid,jsonb)', 'EXECUTE'),
    'A1 anon cannot reach the callback';
  ASSERT NOT has_function_privilege(
    'authenticated', 'public.complete_meta_oauth_callback(uuid,jsonb)', 'EXECUTE'),
    'A1 authenticated cannot reach the callback';
  ASSERT has_function_privilege(
    'service_role', 'public.complete_meta_oauth_callback(uuid,jsonb)', 'EXECUTE'),
    'A1 the service role reaches the callback';
  ASSERT NOT has_function_privilege(
    'anon', 'public.commit_meta_oauth_selection(uuid,jsonb)', 'EXECUTE'),
    'A1 anon cannot reach the selection';
  ASSERT NOT has_function_privilege(
    'authenticated', 'public.commit_meta_oauth_selection(uuid,jsonb)', 'EXECUTE'),
    'A1 authenticated cannot reach the selection';
  ASSERT has_function_privilege(
    'service_role', 'public.commit_meta_oauth_selection(uuid,jsonb)', 'EXECUTE'),
    'A1 the service role reaches the selection';

  -- The alias is not a column, not a table and not a key of the maintained
  -- account contract. It lives inside the existing JSONB metadata.
  SELECT data_type INTO s
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'social_accounts'
     AND column_name = 'account_metadata';
  ASSERT s = 'jsonb', 'A1 account_metadata is still the one JSONB column';

  -- Actual execution. Catalog privilege bits are not this proof.
  -- Browser roles never enter either body. The service role does, and a
  -- selection payload that tries to supply an alias is rejected there.
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    BEGIN
      PERFORM public.complete_meta_oauth_callback(
        '0eb00001-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object(
          'attempt_id', '00000000-0000-4000-8000-000000000099',
          'claim_token', 'not-the-claim',
          'stash', jsonb_build_object(
            'candidates', jsonb_build_array(
              jsonb_build_object('ig_user_id', 'x', 'ig_igid', 'browser-override')),
            'user_token', 'synthetic-not-a-live-secret',
            'expires_in', 3600)));
      RAISE EXCEPTION 'A1 failed: anon executed the callback';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.commit_meta_oauth_selection(
        '0eb00001-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object(
          'attempt_id', '00000000-0000-4000-8000-000000000099',
          'selection_key', 'instagram_direct:ig:x',
          'ig_igid', 'browser-override'));
      RAISE EXCEPTION 'A1 failed: anon executed the selection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      PERFORM public.commit_meta_oauth_selection(
        '0eb00001-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object(
          'attempt_id', '00000000-0000-4000-8000-000000000099',
          'selection_key', 'instagram_direct:ig:x',
          'ig_igid', 'browser-override'));
      RAISE EXCEPTION 'A1 failed: authenticated executed the selection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    EXECUTE 'SET LOCAL ROLE service_role';
    BEGIN
      PERFORM public.complete_meta_oauth_callback(
        '0eb00001-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object(
          'attempt_id', '00000000-0000-4000-8000-000000000099',
          'claim_token', 'not-the-claim',
          'stash', jsonb_build_object(
            'candidates', jsonb_build_array(
              jsonb_build_object('ig_user_id', 'x')),
            'user_token', 'synthetic-not-a-live-secret',
            'expires_in', 3600)));
      RAISE EXCEPTION 'A1 failed: service role did not enter the callback';
    EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
    END;
    BEGIN
      PERFORM public.commit_meta_oauth_selection(
        '0eb00001-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object(
          'attempt_id', '00000000-0000-4000-8000-000000000099',
          'selection_key', 'instagram_direct:ig:x',
          'ig_igid', 'browser-override'));
      RAISE EXCEPTION 'A1 failed: a selection alias override was accepted';
    EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
    END;
    EXECUTE 'RESET ROLE';
  EXCEPTION
    WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RAISE;
  END;
END
$a1$;

-- ---------------------------------------------------------------------------
-- A2. The callback whitelist. The alias is accepted for the direct flow
--     only, and only as a clean identifier.
-- ---------------------------------------------------------------------------
DO $a2$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  s text;
  v_long text := repeat('a', 129);
  v_max  text := repeat('a', 128);
BEGIN
  -- The accepted direct alias.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', 'igid-a2'));
  ASSERT s = 'accepted', 'A2 a clean direct alias is accepted';

  -- An explicit null is a malformed payload, never an omission.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', NULL));
  ASSERT s = 'MOA01', 'A2 an explicit null alias is refused';

  -- A wrong type is refused, and never coerced into a string.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', 12345));
  ASSERT s = 'MOA01', 'A2 a numeric alias is refused';
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', true));
  ASSERT s = 'MOA01', 'A2 a boolean alias is refused';
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', jsonb_build_object('a', 1)));
  ASSERT s = 'MOA01', 'A2 an object alias is refused';
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', jsonb_build_array('a')));
  ASSERT s = 'MOA01', 'A2 an array alias is refused';

  -- A blank value is refused.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', ''));
  ASSERT s = 'MOA01', 'A2 an empty alias is refused';
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', '   '));
  ASSERT s = 'MOA01', 'A2 a blank alias is refused';

  -- Surrounding whitespace is refused, never silently trimmed.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', '  padded-alias  '));
  ASSERT s = 'MOA01', 'A2 a padded alias is refused';

  -- The bound is the accepted identifier convention.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', v_long));
  ASSERT s = 'MOA01', 'A2 an over-long alias is refused';
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', v_max));
  ASSERT s = 'accepted', 'A2 an alias of exactly 128 characters is accepted';

  -- A control character is refused.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_igid', 'bad' || chr(9) || 'alias'));
  ASSERT s = 'MOA01', 'A2 an alias with a control character is refused';

  -- The alias is refused on every Facebook and Page-linked flow.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_page_linked',
    jsonb_build_object(
      'ig_user_id', 'mia-ig-a2', 'ig_igid', 'gid-a2',
      'facebook_page_id', 'mia-page-a2',
      'facebook_user_id', 'mia-fb-a2',
      'page_access_token', 'synthetic-not-a-live-secret'));
  ASSERT s = 'MOA02', 'A2 a page-linked candidate must not carry the alias';

  s := pg_temp.mia_try_callback(u_owner, 'facebook_page',
    jsonb_build_object(
      'candidate_kind', 'page_only',
      'facebook_page_id', 'mia-page-a2',
      'facebook_user_id', 'mia-fb-a2',
      'ig_igid', 'gid-a2',
      'page_access_token', 'synthetic-not-a-live-secret'));
  ASSERT s = 'MOA02', 'A2 a page-only candidate must not carry the alias';

  s := pg_temp.mia_try_callback(u_owner, 'facebook_page',
    jsonb_build_object(
      'candidate_kind', 'page_plus_ig',
      'facebook_page_id', 'mia-page-a2',
      'ig_user_id', 'mia-ig-a2',
      'facebook_user_id', 'mia-fb-a2',
      'ig_igid', 'gid-a2',
      'page_access_token', 'synthetic-not-a-live-secret'));
  ASSERT s = 'MOA02', 'A2 a page-plus-instagram candidate must not carry the alias';

  -- An unknown field is still refused.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object('ig_user_id', 'mia-ig-a2', 'ig_scoped_id', 'gid-a2'));
  ASSERT s = 'MOA01', 'A2 an unknown candidate field is still refused';

  -- The existing direct restriction is untouched: a direct candidate still
  -- must not carry a Facebook grant or a page token.
  s := pg_temp.mia_try_callback(u_owner, 'instagram_direct',
    jsonb_build_object(
      'ig_user_id', 'mia-ig-a2', 'ig_igid', 'gid-a2',
      'facebook_page_id', 'mia-page-a2',
      'page_access_token', 'synthetic-not-a-live-secret'));
  ASSERT s = 'MOA02', 'A2 a direct candidate still must not carry a page token';
END
$a2$;

-- ---------------------------------------------------------------------------
-- A3. The alias is persisted immutably in the protected pending candidate
--     and is never exposed in a picker or a receipt.
-- ---------------------------------------------------------------------------
DO $a3$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_open JSONB;
  v_pending UUID;
  v_attempt UUID;
  v_stored JSONB;
  v_picker JSONB;
  v_count integer;
BEGIN
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a3', 'gid-a3'), NULL, NULL);
  v_attempt := (v_open ->> 'attempt_id')::UUID;
  v_pending := (v_open ->> 'pending_selection_id')::UUID;

  SELECT ps.ig_candidates_json INTO v_stored
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = v_pending AND ps.user_id = u_owner;
  ASSERT jsonb_array_length(v_stored) = 1,
    'A3 the protected stash holds the one candidate';
  ASSERT (v_stored -> 0 ->> 'ig_igid') = 'gid-a3',
    'A3 the protected stash carries the alias';
  ASSERT (v_stored -> 0 ->> 'ig_user_id') = 'mia-ig-a3',
    'A3 the protected stash carries the canonical id';

  -- The picker projection never carries the alias.
  v_picker := public.read_meta_oauth_attempt(u_owner, v_pending);
  ASSERT v_picker::TEXT NOT LIKE '%gid-a3%',
    'A3 the picker projection does not expose the alias';
  ASSERT (v_picker -> 'candidates' -> 0 ->> 'ig_igid') IS NULL,
    'A3 the picker candidate carries no alias key';

  -- The completion response never carries the alias.
  ASSERT (v_open -> 'callback_result')::TEXT NOT LIKE '%gid-a3%',
    'A3 the completion response does not expose the alias';

  -- The alias is immutable with its candidate: a second completion refuses.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_attempt, 'claim_token', 'x',
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(
          pg_temp.mia_direct_candidate('mia-ig-a3', 'gid-other')),
        'user_token', 'synthetic-not-a-live-secret')));
    RAISE EXCEPTION 'A3 failed: a replay replaced the stash';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;

  -- The stash still holds the original alias.
  SELECT ps.ig_candidates_json INTO v_stored
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = v_pending AND ps.user_id = u_owner;
  ASSERT (v_stored -> 0 ->> 'ig_igid') = 'gid-a3',
    'A3 the stored alias is immutable';

  -- The candidate is consumed by the selection, and the stash is gone.
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_attempt, 'selection_key', v_open ->> 'selection_key'));
  SELECT count(*) INTO v_count
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = v_pending;
  ASSERT v_count = 0, 'A3 the consumed stash is gone';
END
$a3$;

-- ---------------------------------------------------------------------------
-- A4. A new direct connect with a verified alias installs the alias and
--     the canonical app-scoped key, and nothing else.
-- ---------------------------------------------------------------------------
DO $a4$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_open JSONB;
  v_receipt JSONB;
  v_account UUID;
  v_meta JSONB;
  v_keys TEXT[];
  s text;
BEGIN
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a4', 'gid-a4'), NULL, NULL);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  v_account := (v_receipt ->> 'social_account_id')::UUID;

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_account;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-a4',
    'A4 the verified alias is installed';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-a4',
    'A4 the canonical app-scoped key is installed';

  -- Only the two identity keys are added. No provider response, no
  -- permission state, no token.
  SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(v_meta) AS k;
  ASSERT v_keys = ARRAY['ig_igid','ig_user_id']::TEXT[],
    'A4 only the two identity keys are stored';

  -- The canonical app-scoped identity is not replaced.
  SELECT sa.platform_user_id INTO s
    FROM public.social_accounts AS sa WHERE sa.id = v_account;
  ASSERT s = 'mia-ig-a4',
    'A4 the canonical app-scoped platform identity is unchanged';
  ASSERT (v_receipt ->> 'platform_user_id') = 'mia-ig-a4',
    'A4 the receipt keeps the canonical app-scoped identity';
  ASSERT (v_receipt ->> 'instagram_user_id') = 'mia-ig-a4',
    'A4 the receipt keeps the canonical instagram identity';
END
$a4$;

-- ---------------------------------------------------------------------------
-- A5. An alias equal to the canonical id is accepted: distinct ids are
--     supported, not required.
-- ---------------------------------------------------------------------------
DO $a5$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_open JSONB;
  v_receipt JSONB;
  v_meta JSONB;
BEGIN
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a5', 'mia-ig-a5'), NULL, NULL);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa
   WHERE sa.id = (v_receipt ->> 'social_account_id')::UUID;
  ASSERT (v_meta ->> 'ig_igid') = 'mia-ig-a5',
    'A5 an alias equal to the canonical id is stored';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-a5',
    'A5 the canonical key is stored';
END
$a5$;

-- ---------------------------------------------------------------------------
-- A6. An unchanged direct reconnect with the alias applies it, synchronizes
--     the canonical key and preserves the unrelated metadata.
-- ---------------------------------------------------------------------------
DO $a6$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_target uuid := '0eb20001-0000-4000-8000-000000000021';
  v_open JSONB;
  v_receipt JSONB;
  v_meta JSONB;
  s text;
BEGIN
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-direct-1', 'gid-a6'), v_target, NULL);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  ASSERT (v_receipt ->> 'operation') = 'reconnected',
    'A6 the reconnect is an explicit reconnect operation';

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_target;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-a6',
    'A6 the verified alias replaces the previous one';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-direct-1',
    'A6 the canonical key is synchronized';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A6 the unrelated metadata is preserved';

  -- The canonical app-scoped identity is untouched.
  SELECT sa.platform_user_id INTO s
    FROM public.social_accounts AS sa WHERE sa.id = v_target;
  ASSERT s = 'mia-ig-direct-1',
    'A6 the canonical platform identity is unchanged';
END
$a6$;

-- ---------------------------------------------------------------------------
-- A7. An unchanged direct reconnect WITHOUT the alias asserts nothing. A
--     valid alias is preserved, none is deleted and none is manufactured.
-- ---------------------------------------------------------------------------
DO $a7$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_target uuid := '0eb20001-0000-4000-8000-000000000021';
  v_plain  uuid := '0eb20001-0000-4000-8000-000000000023';
  v_open JSONB;
  v_meta JSONB;
BEGIN
  -- The account that already carries a valid alias keeps it.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-direct-1', NULL), v_target, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_target;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-a6',
    'A7 an omitted alias preserves the existing alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-direct-1',
    'A7 an omitted alias preserves the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A7 an omitted alias preserves the unrelated metadata';

  -- The account that never had an alias does not get one manufactured.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-noalias-1', NULL), v_plain, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_plain;
  ASSERT v_meta IS NULL,
    'A7 an omitted alias manufactures no metadata at all';
END
$a7$;

-- ---------------------------------------------------------------------------
-- A8. A page-linked to direct conversion. The newly verified alias is
--     applied and an old alias is never inherited. An omitted alias
--     removes the unproven old alias instead of resurrecting it.
-- ---------------------------------------------------------------------------
DO $a8$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_linked uuid := '0eb20001-0000-4000-8000-000000000022';
  v_stale  uuid := '0eb20001-0000-4000-8000-000000000028';
  v_open JSONB;
  v_meta JSONB;
  v_keys TEXT[];
BEGIN
  -- With the alias: the new alias is applied, the unrelated metadata stays.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-linked-1', 'gid-a8'), v_linked, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_linked;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-a8',
    'A8 the conversion applies the newly verified alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-linked-1',
    'A8 the conversion synchronizes the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A8 the conversion preserves the unrelated metadata';

  -- Without the alias: the unproven old alias is removed, not resurrected.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-linked-2', NULL), v_stale, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_stale;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A8 an omitted alias removes the unproven old alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-linked-2',
    'A8 an omitted alias synchronizes the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A8 the removal preserves the unrelated metadata';
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_meta) AS k;
  ASSERT v_keys = ARRAY['ig_user_id','legacy']::TEXT[],
    'A8 the removal leaves the canonical key and the unrelated metadata';
END
$a8$;

-- ---------------------------------------------------------------------------
-- A9. A direct to page-linked conversion synchronizes the canonical key
--     and removes an obsolete alias unless that alias IS the canonical
--     identity.
-- ---------------------------------------------------------------------------
DO $a9$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_direct uuid := '0eb20001-0000-4000-8000-000000000021';
  v_equal  uuid := '0eb20001-0000-4000-8000-000000000027';
  v_open JSONB;
  v_meta JSONB;
  v_candidate JSONB;
BEGIN
  v_candidate := jsonb_build_object(
    'ig_user_id', 'mia-ig-direct-1',
    'ig_username', 'mia_direct_one',
    'facebook_page_id', 'mia-page-a9',
    'facebook_user_id', 'mia-fb-user-a9',
    'page_access_token', 'synthetic-not-a-live-secret');

  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    v_candidate, v_direct, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_direct;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A9 the conversion removes the obsolete alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-direct-1',
    'A9 the conversion synchronizes the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A9 the conversion preserves the unrelated metadata';

  -- The alias that IS the canonical identity survives the conversion.
  v_candidate := jsonb_build_object(
    'ig_user_id', 'mia-ig-equal-1',
    'ig_username', 'mia_equal_one',
    'facebook_page_id', 'mia-page-a9b',
    'facebook_user_id', 'mia-fb-user-a9b',
    'page_access_token', 'synthetic-not-a-live-secret');
  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    v_candidate, v_equal, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_equal;
  ASSERT (v_meta ->> 'ig_igid') = 'mia-ig-equal-1',
    'A9 an alias equal to the canonical identity survives the conversion';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-equal-1',
    'A9 the conversion synchronizes the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A9 the conversion preserves the unrelated metadata';
END
$a9$;

-- ---------------------------------------------------------------------------
-- A10. A page-plus-instagram selection confines the alias change to the
--      Instagram companion, and only when its classification changes.
--      The Facebook Page identity and the unselected siblings are untouched.
-- ---------------------------------------------------------------------------
DO $a10$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_page uuid := '0eb20001-0000-4000-8000-000000000024';
  v_comp uuid := '0eb20001-0000-4000-8000-000000000025';
  v_sib  uuid := '0eb20001-0000-4000-8000-000000000026';
  v_open JSONB;
  v_receipt JSONB;
  v_meta JSONB;
  v_sibling_before JSONB;
  v_candidate JSONB;
BEGIN
  SELECT sa.account_metadata INTO v_sibling_before
    FROM public.social_accounts AS sa WHERE sa.id = v_sib;

  v_candidate := jsonb_build_object(
    'candidate_kind', 'page_plus_ig',
    'facebook_page_id', 'mia-page-1',
    'facebook_page_name', 'MIA Page One',
    'ig_user_id', 'mia-ig-companion-1',
    'ig_username', 'mia_companion_one',
    'facebook_user_id', 'mia-fb-user-a10',
    'page_access_token', 'synthetic-not-a-live-secret');

  v_open := pg_temp.mia_open(u_owner, 'facebook_page',
    v_candidate, v_page, v_comp);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  ASSERT (v_receipt ->> 'companion_social_account_id') = v_comp::TEXT,
    'A10 the receipt names the Instagram companion';

  -- The companion changed its classification, so its alias is corrected.
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_comp;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A10 the converted companion loses the obsolete alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-companion-1',
    'A10 the converted companion synchronizes the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A10 the converted companion preserves the unrelated metadata';

  -- The Facebook Page identity is untouched.
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_page;
  ASSERT v_meta = '{"legacy":"page"}'::jsonb,
    'A10 the Facebook Page metadata is untouched';

  -- The unselected sibling is untouched.
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_sib;
  ASSERT v_meta IS NOT DISTINCT FROM v_sibling_before,
    'A10 the unselected sibling metadata is untouched';
END
$a10$;

-- ---------------------------------------------------------------------------
-- A11. The authority refusals. Each one leaves the whole state unchanged.
-- ---------------------------------------------------------------------------
DO $a11$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  u_other uuid := '0eb00002-0000-4000-8000-000000000002';
  v_target uuid := '0eb20001-0000-4000-8000-000000000021';
  v_open JSONB;
  v_before TEXT;
  v_after TEXT;
BEGIN
  -- A browser-supplied alias at selection is refused outright.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a11', 'gid-a11'), NULL, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key',
      'ig_igid', 'gid-a11'));
    RAISE EXCEPTION 'A11 failed: a browser-supplied alias was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA01' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a browser-supplied alias changes nothing';

  -- A foreign owner cannot commit the selection.
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_other, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A11 failed: a foreign owner committed the selection';
  EXCEPTION WHEN SQLSTATE 'MOA02' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a foreign owner changes nothing';

  -- A wrong claim token never reaches the stash.
  BEGIN
    PERFORM public.complete_meta_oauth_callback(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id', 'claim_token', repeat('c', 64),
      'stash', jsonb_build_object(
        'candidates', jsonb_build_array(
          pg_temp.mia_direct_candidate('mia-ig-a11', 'gid-a11')),
        'user_token', 'synthetic-not-a-live-secret')));
    RAISE EXCEPTION 'A11 failed: a wrong claim token was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a wrong claim token changes nothing';

  -- A verified identity that does not match the captured target refuses.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-somebody-else', 'gid-a11'),
    v_target, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A11 failed: a mismatched provider identity was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a mismatched provider identity changes nothing';

  -- A capability generation that moved after the capture refuses.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-direct-1', 'gid-a11'), v_target, NULL);
  UPDATE public.instagram_account_capabilities
     SET credential_generation = credential_generation + 1
   WHERE social_account_id = v_target AND user_id = u_owner;
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A11 failed: a stale capability generation was accepted';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a stale capability generation changes nothing';

  -- A stale attempt refuses before any mutation.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a11b', 'gid-a11b'), NULL, NULL);
  UPDATE public.meta_oauth_attempts
     SET status = 'authorized'
   WHERE id = (v_open ->> 'attempt_id')::UUID;
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A11 failed: a stale attempt committed a selection';
  EXCEPTION WHEN SQLSTATE 'MOA03' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A11 a stale attempt changes nothing';
END
$a11$;

-- ---------------------------------------------------------------------------
-- A12. No secret is copied into the metadata, and the alias is not an
--      authority of its own.
-- ---------------------------------------------------------------------------
DO $a12$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_open JSONB;
  v_receipt JSONB;
  v_meta JSONB;
BEGIN
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a12', 'gid-a12'), NULL, NULL);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa
   WHERE sa.id = (v_receipt ->> 'social_account_id')::UUID;
  ASSERT v_meta::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'A12 the metadata carries no token';
  ASSERT v_meta::TEXT NOT LIKE '%secret%',
    'A12 the metadata carries no provider secret';
  ASSERT v_receipt::TEXT NOT LIKE '%synthetic-not-a-live-secret%',
    'A12 the receipt carries no token';

  -- The alias is not a selection key: the key still identifies the
  -- canonical app-scoped identity only.
  ASSERT (v_open ->> 'selection_key') = 'instagram_direct:ig:mia-ig-a12',
    'A12 the selection key is the canonical identity, not the alias';
  ASSERT (v_open ->> 'selection_key') NOT LIKE '%gid-a12%',
    'A12 the selection key never carries the alias';
END
$a12$;

-- ---------------------------------------------------------------------------
-- A13. A receipt replay is read-only. It applies no alias, repairs no
--      metadata and cannot resurrect an alias a later conversion removed.
-- ---------------------------------------------------------------------------
DO $a13$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_target uuid := '0eb20001-0000-4000-8000-000000000021';
  v_open JSONB;
  v_receipt JSONB;
  v_replay JSONB;
  v_meta JSONB;
  v_before TEXT;
BEGIN
  -- A direct connect with an alias, then an identical replay.
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a13', 'gid-a13'), NULL, NULL);
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));

  v_before := pg_temp.mia_fingerprint(u_owner);
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  ASSERT v_replay = v_receipt,
    'A13 an identical replay returns the accepted receipt';
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A13 an identical replay changes nothing';

  -- A later conversion removes the alias. The old receipt must not
  -- resurrect it.
  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    jsonb_build_object(
      'ig_user_id', 'mia-ig-a13',
      'facebook_page_id', 'mia-page-a13',
      'facebook_user_id', 'mia-fb-user-a13',
      'page_access_token', 'synthetic-not-a-live-secret'),
    (SELECT sa.id FROM public.social_accounts AS sa
      WHERE sa.user_id = u_owner AND sa.platform_user_id = 'mia-ig-a13'), NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa
   WHERE sa.user_id = u_owner AND sa.platform_user_id = 'mia-ig-a13';
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A13 the later conversion removed the alias';

  v_before := pg_temp.mia_fingerprint(u_owner);
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A13 the replay after the conversion changes nothing';
  ASSERT v_replay IS NOT NULL,
    'A13 the replay after the conversion still returns a receipt';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa
   WHERE sa.user_id = u_owner AND sa.platform_user_id = 'mia-ig-a13';
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A13 the replay did not resurrect the removed alias';
END
$a13$;

-- ---------------------------------------------------------------------------
-- A14. A deliberate failure after the alias write and before the receipt
--      rolls the whole transition back: no account, no alias, no receipt,
--      no pending consumption, no capability record.
--
--      The failure is injected by a test-owned trigger that refuses exactly
--      the alias write. It is created and dropped inside this suite's
--      transaction. No production object is touched.
-- ---------------------------------------------------------------------------
DO $a14$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_open JSONB;
  v_before TEXT;
  v_after TEXT;
  v_count integer;
BEGIN
  EXECUTE $trig$
    CREATE OR REPLACE FUNCTION public.mia_alias_fail_fn()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'test-owned alias write failure'
        USING ERRCODE = 'MOA07';
    END;
    $fn$;
  $trig$;
  EXECUTE $trig$
    CREATE TRIGGER mia_alias_fail
    BEFORE UPDATE ON public.social_accounts
    FOR EACH ROW
    WHEN (NEW.account_metadata IS DISTINCT FROM OLD.account_metadata
          AND NEW.account_metadata ? 'ig_igid')
    EXECUTE FUNCTION public.mia_alias_fail_fn();
  $trig$;

  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a14', 'gid-a14'), NULL, NULL);

  -- The fingerprint is taken AFTER the attempt and its protected stash
  -- exist, so the assertion is about the failed SELECTION alone.
  v_before := pg_temp.mia_fingerprint(u_owner);

  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A14 failed: the injected failure was ignored';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;

  EXECUTE 'DROP TRIGGER mia_alias_fail ON public.social_accounts';
  EXECUTE 'DROP FUNCTION public.mia_alias_fail_fn()';

  -- The account, the alias, the receipt, the capability record and the
  -- pending consumption are all gone.
  SELECT count(*) INTO v_count FROM public.social_accounts
   WHERE user_id = u_owner AND platform_user_id = 'mia-ig-a14';
  ASSERT v_count = 0, 'A14 the failed selection created no account';
  SELECT count(*) INTO v_count FROM public.meta_oauth_attempt_receipts
   WHERE attempt_id = (v_open ->> 'attempt_id')::UUID;
  ASSERT v_count = 0, 'A14 the failed selection wrote no receipt';
  SELECT count(*) INTO v_count FROM public.instagram_account_capabilities
   WHERE user_id = u_owner
     AND social_account_id IN (
       SELECT id FROM public.social_accounts
        WHERE user_id = u_owner AND platform_user_id = 'mia-ig-a14');
  ASSERT v_count = 0, 'A14 the failed selection wrote no capability record';

  -- The pending stash survives the failed selection: only the successful
  -- commit consumes it.
  SELECT count(*) INTO v_count FROM public.oauth_pending_instagram_selections
   WHERE id = (v_open ->> 'pending_selection_id')::UUID;
  ASSERT v_count = 1, 'A14 the failed selection did not consume the stash';

  -- Nothing at all changed for the owner.
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A14 the failed selection rolled the whole transition back';
END
$a14$;

-- ---------------------------------------------------------------------------
-- A15. The accepted no-alias paths are unchanged: an untouched
--      page-linked account keeps its metadata exactly, and so does an
--      untouched sibling.
-- ---------------------------------------------------------------------------
DO $a15$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_linked uuid := '0eb20001-0000-4000-8000-00000000002a';
  v_sib    uuid := '0eb20001-0000-4000-8000-000000000026';
  v_open JSONB;
  v_meta JSONB;
  v_before JSONB;
BEGIN
  SELECT sa.account_metadata INTO v_before
    FROM public.social_accounts AS sa WHERE sa.id = v_linked;

  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    jsonb_build_object(
      'ig_user_id', 'mia-ig-linked-3',
      'ig_username', 'mia_linked_three',
      'facebook_page_id', 'mia-page-a15',
      'facebook_user_id', 'mia-fb-user-a15',
      'page_access_token', 'synthetic-not-a-live-secret'),
    v_linked, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_linked;
  ASSERT v_meta IS NOT DISTINCT FROM v_before,
    'A15 an unchanged page-linked account keeps its metadata exactly';

  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_sib;
  ASSERT v_meta = '{"sibling":"kept"}'::jsonb,
    'A15 an unselected sibling keeps its metadata exactly';

  -- The sibling's protected kind is not a display column, and this
  -- selection does not rewrite it.
  ASSERT (
    SELECT c.login_kind || ':' || c.credential_generation::text
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_sib) = 'page_linked:0',
    'A15 the unselected sibling capability is untouched';
END
$a15$;

-- ---------------------------------------------------------------------------
-- A16. Display hints do not choose the previous kind. Both conversion
--      directions, including a stale, null or unsupported hint, follow the
--      locked capability row. An unchanged direct identity keeps its alias.
-- ---------------------------------------------------------------------------
DO $a16$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_case JSONB;
  v_id UUID;
  v_ig TEXT;
  v_open JSONB;
  v_meta JSONB;
  v_hint TEXT;
  v_n INTEGER := 0;
  v_page_id UUID := '0eb20001-0000-4000-8000-000000000070';
  v_comp UUID := '0eb20001-0000-4000-8000-000000000071';
  v_sib UUID := '0eb20001-0000-4000-8000-000000000072';
  v_sib_meta JSONB;
  v_sib_cap TEXT;
BEGIN
  FOR v_case IN
    SELECT e.value
      FROM jsonb_array_elements(
        '[
          {"hint":"business_login"},
          {"hint":"facebook_page"},
          {"hint":"not-a-login-kind"},
          {"hint":null}
        ]'::jsonb) AS e(value)
  LOOP
    v_n := v_n + 1;
    v_hint := v_case ->> 'hint';
    v_id := ('0eb20001-0000-4000-8000-0000000001'
             || lpad(v_n::text, 2, '0'))::uuid;
    v_ig := 'mia-ig-d2p-' || v_n::text;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, v_ig,
      jsonb_build_object(
        'ig_user_id', v_ig,
        'ig_igid', 'legacy-alias-value',
        'legacy', 'kept'),
      v_hint, 'direct');
    ASSERT (
      SELECT c.login_kind
        FROM public.instagram_account_capabilities AS c
       WHERE c.social_account_id = v_id) = 'direct',
      'A16 the protected kind is direct before the conversion';
    v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
      jsonb_build_object(
        'ig_user_id', v_ig,
        'facebook_page_id', 'mia-page-d2p-' || v_n::text,
        'facebook_user_id', 'mia-fb-d2p-' || v_n::text,
        'page_access_token', 'synthetic-not-a-live-secret'),
      v_id, NULL);
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    SELECT sa.account_metadata INTO v_meta
      FROM public.social_accounts AS sa WHERE sa.id = v_id;
    ASSERT (v_meta - 'ig_user_id') = '{"legacy":"kept"}'::jsonb,
      'A16 every display hint produces the same direct-to-page metadata';
    ASSERT NOT (v_meta ? 'ig_igid'),
      'A16 a direct-to-page conversion removes the obsolete alias';
    ASSERT (v_meta ->> 'ig_user_id') = v_ig,
      'A16 a direct-to-page conversion keeps the selected canonical key';
    ASSERT (v_meta ->> 'legacy') = 'kept',
      'A16 a direct-to-page conversion preserves unrelated metadata';
    ASSERT (
      SELECT sa.platform_user_id
        FROM public.social_accounts AS sa WHERE sa.id = v_id) = v_ig,
      'A16 the canonical platform identity is unchanged';
  END LOOP;

  v_n := 0;
  FOR v_case IN
    SELECT e.value
      FROM jsonb_array_elements(
        '[
          {"hint":"facebook_page"},
          {"hint":"business_login"},
          {"hint":"not-a-login-kind"},
          {"hint":null}
        ]'::jsonb) AS e(value)
  LOOP
    v_n := v_n + 1;
    v_hint := v_case ->> 'hint';
    v_id := ('0eb20001-0000-4000-8000-0000000002'
             || lpad(v_n::text, 2, '0'))::uuid;
    v_ig := 'mia-ig-p2d-' || v_n::text;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, v_ig,
      jsonb_build_object(
        'ig_user_id', 'obsolete-scoped',
        'ig_igid', 'legacy-alias-value',
        'legacy', 'kept'),
      v_hint, 'page_linked');
    v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
      pg_temp.mia_direct_candidate(v_ig, NULL), v_id, NULL);
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    SELECT sa.account_metadata INTO v_meta
      FROM public.social_accounts AS sa WHERE sa.id = v_id;
    ASSERT (v_meta - 'ig_user_id') = '{"legacy":"kept"}'::jsonb,
      'A16 every display hint produces the same page-to-direct metadata';
    ASSERT NOT (v_meta ? 'ig_igid'),
      'A16 a page-to-direct conversion removes the old alias';
    ASSERT (v_meta ->> 'ig_user_id') = v_ig,
      'A16 a page-to-direct conversion replaces the obsolete canonical key';
    ASSERT (v_meta ->> 'legacy') = 'kept',
      'A16 a page-to-direct conversion preserves unrelated metadata';
  END LOOP;

  -- Stale display says page-linked. The protected kind is direct and the
  -- canonical metadata already matches, so omission must not delete.
  v_id := '0eb20001-0000-4000-8000-000000000061';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-keep-1',
    '{"ig_user_id":"mia-ig-keep-1","ig_igid":"igid-keep","legacy":"kept"}'::jsonb,
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-keep-1', NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = '{"ig_user_id":"mia-ig-keep-1","ig_igid":"igid-keep","legacy":"kept"}'::jsonb,
    'A16 a stale page hint does not delete an unchanged direct alias';

  -- Page plus Instagram. The companion's protected kind is direct and its
  -- display hint is stale. Only that companion changes.
  PERFORM pg_temp.mia_account(
    v_page_id, u_owner, 'mia-page-a16',
    '{"legacy":"page"}'::jsonb, 'facebook_page', NULL);
  UPDATE public.social_accounts
     SET platform = 'facebook'
   WHERE id = v_page_id;
  PERFORM pg_temp.mia_account(
    v_comp, u_owner, 'mia-ig-comp-a16',
    '{"ig_user_id":"mia-ig-comp-a16","ig_igid":"legacy-alias-value","legacy":"kept"}'::jsonb,
    'facebook_page', 'direct');
  PERFORM pg_temp.mia_account(
    v_sib, u_owner, 'mia-ig-sib-a16',
    '{"sibling":"kept"}'::jsonb, 'business_login', 'page_linked');
  SELECT sa.account_metadata INTO v_sib_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_sib;
  SELECT c.login_kind || ':' || c.credential_generation::text INTO v_sib_cap
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_sib;

  v_open := pg_temp.mia_open(u_owner, 'facebook_page',
    jsonb_build_object(
      'candidate_kind', 'page_plus_ig',
      'facebook_page_id', 'mia-page-a16',
      'facebook_page_name', 'MIA A16',
      'ig_user_id', 'mia-ig-comp-a16',
      'facebook_user_id', 'mia-fb-a16',
      'page_access_token', 'synthetic-not-a-live-secret'),
    v_page_id, v_comp);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_comp;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A16 the companion loses the obsolete alias despite the stale hint';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-comp-a16',
    'A16 the companion canonical key follows the selection';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A16 the companion keeps unrelated metadata';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_page_id;
  ASSERT v_meta = '{"legacy":"page"}'::jsonb,
    'A16 the Facebook Page metadata is untouched';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_sib;
  ASSERT v_meta IS NOT DISTINCT FROM v_sib_meta,
    'A16 the unselected sibling metadata is untouched';
  ASSERT (
    SELECT c.login_kind || ':' || c.credential_generation::text
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_sib) = v_sib_cap,
    'A16 the unselected sibling capability is untouched';
END
$a16$;

-- ---------------------------------------------------------------------------
-- A17. Shape is enforced only when identity keys are about to change.
-- ---------------------------------------------------------------------------
DO $a17$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_id UUID;
  v_open JSONB;
  v_meta JSONB;
  v_before TEXT;
  v_after TEXT;
  v_shape JSONB;
  v_n INTEGER := 0;
BEGIN
  v_id := '0eb20001-0000-4000-8000-000000000081';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-null-sql', NULL, 'facebook_page', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-null-sql', 'gid-null-sql'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = '{"ig_igid":"gid-null-sql","ig_user_id":"mia-ig-null-sql"}'::jsonb,
    'A17 SQL null metadata becomes the two identity keys';

  v_id := '0eb20001-0000-4000-8000-000000000082';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-null-json', 'null'::jsonb, NULL, NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-null-json', 'gid-null-json'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = '{"ig_igid":"gid-null-json","ig_user_id":"mia-ig-null-json"}'::jsonb,
    'A17 JSON null metadata becomes the two identity keys';

  v_id := '0eb20001-0000-4000-8000-000000000083';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-object',
    '{"legacy":"kept","nested":{"a":1}}'::jsonb, 'business_login', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-object', 'gid-object'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-object',
    'A17 an object receives the verified alias';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-object',
    'A17 an object receives the canonical key';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A17 an object keeps unrelated keys';
  ASSERT v_meta -> 'nested' = '{"a":1}'::jsonb,
    'A17 an object keeps unrelated nested values';

  FOR v_shape IN
    SELECT e.value
      FROM jsonb_array_elements('[[], "bad", 12, true]'::jsonb) AS e(value)
  LOOP
    v_n := v_n + 1;
    v_id := ('0eb20001-0000-4000-8000-00000000008' || (v_n + 4)::text)::uuid;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, 'mia-ig-bad-' || v_n::text, v_shape, 'facebook_page', 'direct');
    v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
      pg_temp.mia_direct_candidate('mia-ig-bad-' || v_n::text, 'gid-bad'),
      v_id, NULL);
    v_before := pg_temp.mia_fingerprint(u_owner);
    BEGIN
      PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
        'attempt_id', v_open ->> 'attempt_id',
        'selection_key', v_open ->> 'selection_key'));
      RAISE EXCEPTION 'A17 failed: a non-object metadata shape was accepted';
    EXCEPTION WHEN SQLSTATE 'MOA10' THEN NULL;
    END;
    v_after := pg_temp.mia_fingerprint(u_owner);
    ASSERT v_after = v_before,
      'A17 a non-object metadata shape changes nothing';
    SELECT sa.account_metadata INTO v_meta
      FROM public.social_accounts AS sa WHERE sa.id = v_id;
    ASSERT v_meta = v_shape,
      'A17 a refused shape is left exactly as it was stored';
  END LOOP;

  -- No identity mutation, so the array is not validated and not wrapped.
  v_id := '0eb20001-0000-4000-8000-000000000084';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-noop-array', '[]'::jsonb, 'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-noop-array', NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = '[]'::jsonb,
    'A17 an unchanged direct reconnect does not rewrite array metadata';
END
$a17$;

-- ---------------------------------------------------------------------------
-- A18. Capability absence. A verified alias needs no previous kind. An
--      omitted alias needs one only when an ig_igid key would otherwise
--      be retained or deleted.
-- ---------------------------------------------------------------------------
DO $a18$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_id UUID;
  v_open JSONB;
  v_meta JSONB;
  v_before TEXT;
  v_after TEXT;
BEGIN
  v_id := '0eb20001-0000-4000-8000-000000000091';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-absent-alias',
    '{"ig_user_id":"obsolete-scoped","ig_igid":"old-alias","legacy":"kept"}'::jsonb,
    'facebook_page', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-absent-alias', 'gid-absent'),
    v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_igid') = 'gid-absent',
    'A18 a verified alias replaces the second id without a previous kind';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-absent-alias',
    'A18 a verified alias synchronizes the canonical key without a previous kind';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A18 a verified alias preserves unrelated metadata';
  ASSERT (
    SELECT c.login_kind
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_id) = 'direct',
    'A18 the selection records the new direct kind';

  v_id := '0eb20001-0000-4000-8000-000000000092';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-absent-plain',
    '{"legacy":"kept"}'::jsonb, 'business_login', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-absent-plain', NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = '{"legacy":"kept"}'::jsonb,
    'A18 no alias and no second id leaves unrelated metadata alone';

  v_id := '0eb20001-0000-4000-8000-000000000093';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-absent-refuse',
    '{"ig_igid":"old-alias","legacy":"kept"}'::jsonb,
    'business_login', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-absent-refuse', NULL), v_id, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A18 failed: an ambiguous legacy alias was retained or deleted';
  EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
  END;
  v_after := pg_temp.mia_fingerprint(u_owner);
  ASSERT v_after = v_before,
    'A18 an ambiguous legacy alias changes nothing';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_igid') = 'old-alias',
    'A18 the refusal does not delete the stored alias';
END
$a18$;

-- ---------------------------------------------------------------------------
-- A19. Same protected kind, stored canonical metadata disagrees with the
--      selected app-scoped id. The platform identity did not change, so
--      this repairs the duplicate and keeps the valid second id.
-- ---------------------------------------------------------------------------
DO $a19$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_id UUID := '0eb20001-0000-4000-8000-000000000094';
  v_open JSONB;
  v_meta JSONB;
  v_kind TEXT;
BEGIN
  PERFORM pg_temp.mia_account(
    v_id, u_owner, 'mia-ig-drift-1',
    '{"ig_user_id":"obsolete-scoped","ig_igid":"legacy-alias-value","legacy":"kept"}'::jsonb,
    'facebook_page', 'direct');
  SELECT c.login_kind INTO v_kind
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_id;
  ASSERT v_kind = 'direct',
    'A19 the protected kind stays the authority';
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-drift-1', NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_igid') = 'legacy-alias-value',
    'A19 a stale canonical duplicate keeps the valid second id';
  ASSERT (v_meta ->> 'ig_user_id') = 'mia-ig-drift-1',
    'A19 a stale canonical duplicate is repaired to the selected id';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A19 canonical metadata drift preserves unrelated metadata';
  ASSERT (
    SELECT sa.platform_user_id
      FROM public.social_accounts AS sa WHERE sa.id = v_id) = 'mia-ig-drift-1',
    'A19 the platform identity fence is unchanged';
  ASSERT (
    SELECT c.login_kind
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_id) = 'direct',
    'A19 the protected kind does not change';
END
$a19$;

-- ---------------------------------------------------------------------------
-- A20. Duplicate metadata is not an identity transition. Omitted and
--      supplied aliases are paired for a known direct account and for a
--      capability-absent account. Malformed identity keys inside an
--      object refuse MOA11. Malformed outer metadata stays MOA10.
-- ---------------------------------------------------------------------------
DO $a20$
DECLARE
  u_owner uuid := '0eb00001-0000-4000-8000-000000000001';
  v_id UUID;
  v_open JSONB;
  v_meta JSONB;
  v_before TEXT;
  v_after TEXT;
  v_bad JSONB;
  v_n INTEGER := 300;
  v_receipt JSONB;
  v_replay JSONB;
  v_platform TEXT;
  v_repair_attempt TEXT;
  v_repair_key TEXT;
BEGIN
  -- Known direct, canonical key missing, valid second id preserved.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-missing';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_igid', 'kept-second', 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object('ig_igid', 'kept-second', 'legacy', 'kept'),
    'A20 a missing canonical duplicate preserves the valid second id';

  -- Known direct, canonical duplicate already equal.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-equal';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', v_platform, 'ig_igid', 'kept-second', 'legacy', 'kept'),
    'not-a-login-kind', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object(
      'ig_user_id', v_platform, 'ig_igid', 'kept-second', 'legacy', 'kept'),
    'A20 an equal canonical duplicate preserves the valid second id';

  -- Known direct, stale duplicate, supplied verified alias replaces both keys.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-alias';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', 'old-second', 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, 'verified-new-id'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object(
      'ig_user_id', v_platform, 'ig_igid', 'verified-new-id', 'legacy', 'kept'),
    'A20 a verified alias replaces both keys on a known direct account';

  -- Known direct, malformed identity keys, omitted alias refuses.
  FOREACH v_bad IN ARRAY ARRAY[
    'null'::jsonb, '12'::jsonb, 'true'::jsonb, '{"nested":true}'::jsonb,
    '["x"]'::jsonb, '""'::jsonb, '" "'::jsonb, '" padded"'::jsonb,
    to_jsonb(repeat('x', 129)), to_jsonb(chr(10))
  ] LOOP
    v_n := v_n + 1;
    v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
    v_platform := 'mia-ig-a20-bad-' || v_n::text;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, v_platform,
      jsonb_build_object('ig_user_id', v_bad, 'ig_igid', 'kept-second', 'legacy', 'kept'),
      'business_login', 'direct');
    v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
      pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
    v_before := pg_temp.mia_fingerprint(u_owner);
    BEGIN
      PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
        'attempt_id', v_open ->> 'attempt_id',
        'selection_key', v_open ->> 'selection_key'));
      RAISE EXCEPTION 'A20 failed: a malformed canonical duplicate was coerced';
    EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
    END;
    v_after := pg_temp.mia_fingerprint(u_owner);
    ASSERT v_after = v_before,
      'A20 a malformed canonical duplicate changes nothing';

    v_n := v_n + 1;
    v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
    v_platform := 'mia-ig-a20-sec-' || v_n::text;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, v_platform,
      jsonb_build_object('ig_user_id', v_platform, 'ig_igid', v_bad, 'legacy', 'kept'),
      NULL, 'direct');
    v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
      pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
    v_before := pg_temp.mia_fingerprint(u_owner);
    BEGIN
      PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
        'attempt_id', v_open ->> 'attempt_id',
        'selection_key', v_open ->> 'selection_key'));
      RAISE EXCEPTION 'A20 failed: a malformed second id was coerced';
    EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
    END;
    ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
      'A20 a malformed second id changes nothing';
  END LOOP;

  -- Stale canonical duplicate plus a malformed second id is not a repair.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-both';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', '12'::jsonb, 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A20 failed: a stale duplicate repaired a malformed second id';
  EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
  END;
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 a stale duplicate with a malformed second id changes nothing';

  -- Verified alias replaces malformed identity keys inside an object.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-fix';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', '12'::jsonb, 'ig_igid', 'null'::jsonb, 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, 'verified-fixed-id'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object(
      'ig_user_id', v_platform, 'ig_igid', 'verified-fixed-id', 'legacy', 'kept'),
    'A20 a verified alias replaces malformed identity keys inside an object';

  -- Capability absent, stale ig_user_id, no second id: refuse, do not keep it.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-absent-stale';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'legacy', 'kept'),
    'business_login', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A20 failed: a capability-absent stale canonical id was retained';
  EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
  END;
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 a capability-absent stale canonical id changes nothing';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_user_id') = 'foreign-old-id',
    'A20 the refusal leaves the unresolved canonical duplicate in place';

  -- Capability absent, equal canonical duplicate, no second id: no-op.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-absent-equal';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', v_platform, 'legacy', 'kept'),
    NULL, NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object('ig_user_id', v_platform, 'legacy', 'kept'),
    'A20 an equal canonical duplicate without a second id stays unchanged';

  -- Capability absent, malformed canonical key, no second id.
  FOREACH v_bad IN ARRAY ARRAY[
    'null'::jsonb, '12'::jsonb, 'true'::jsonb, '{"nested":true}'::jsonb,
    '["x"]'::jsonb, '""'::jsonb, '" padded"'::jsonb
  ] LOOP
    v_n := v_n + 1;
    v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
    v_platform := 'mia-ig-a20-abs-' || v_n::text;
    PERFORM pg_temp.mia_account(
      v_id, u_owner, v_platform,
      jsonb_build_object('ig_user_id', v_bad, 'legacy', 'kept'),
      'facebook_page', NULL);
    v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
      pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
    v_before := pg_temp.mia_fingerprint(u_owner);
    BEGIN
      PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
        'attempt_id', v_open ->> 'attempt_id',
        'selection_key', v_open ->> 'selection_key'));
      RAISE EXCEPTION 'A20 failed: capability-absent malformed identity was retained';
    EXCEPTION WHEN SQLSTATE 'MOA11' THEN NULL;
    END;
    ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
      'A20 capability-absent malformed identity changes nothing';
  END LOOP;

  -- Capability absent, verified alias still replaces malformed inner keys.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-absent-alias';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', 'true'::jsonb, 'legacy', 'kept'),
    'business_login', NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, 'verified-absent-id'), v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT v_meta = jsonb_build_object(
      'ig_user_id', v_platform, 'ig_igid', 'verified-absent-id', 'legacy', 'kept'),
    'A20 a verified alias replaces unresolved keys when no kind is recorded';

  -- A verified alias does not normalize a malformed outer value.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-outer';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform, '[]'::jsonb, NULL, NULL);
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, 'verified-outer-id'), v_id, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A20 failed: malformed outer metadata was normalized';
  EXCEPTION WHEN SQLSTATE 'MOA10' THEN NULL;
  END;
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 malformed outer metadata changes nothing';

  -- Unchanged page-linked relationship repairs a stale duplicate and keeps
  -- a valid second id. Kind change remains the conversion path.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-page';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', 'kept-page-second', 'legacy', 'kept'),
    'business_login', 'page_linked');
  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    jsonb_build_object(
      'ig_user_id', v_platform,
      'ig_username', 'mia_a20_page',
      'facebook_page_id', 'mia-page-a20',
      'facebook_user_id', 'mia-fb-user-a20',
      'page_access_token', 'synthetic-not-a-live-secret'),
    v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_user_id') = v_platform,
    'A20 an unchanged page-linked account repairs the canonical duplicate';
  ASSERT (v_meta ->> 'ig_igid') = 'kept-page-second',
    'A20 an unchanged page-linked account keeps the valid second id';
  ASSERT (v_meta ->> 'legacy') = 'kept',
    'A20 an unchanged page-linked repair preserves unrelated metadata';

  -- Repair, then a read-only replay, then a real conversion. The old
  -- receipt must not restore the second id the conversion removed.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-replay';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', 'verified-preserved-id', 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate(v_platform, NULL), v_id, NULL);
  v_repair_attempt := v_open ->> 'attempt_id';
  v_repair_key := v_open ->> 'selection_key';
  v_receipt := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT (v_meta ->> 'ig_igid') = 'verified-preserved-id',
    'A20 the repair keeps the verified second id';
  ASSERT (v_meta ->> 'ig_user_id') = v_platform,
    'A20 the repair stores the authoritative canonical id';
  v_before := pg_temp.mia_fingerprint(u_owner);
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  ASSERT v_replay = v_receipt,
    'A20 a replay after the repair returns the same receipt';
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 a replay after the repair changes nothing';

  v_open := pg_temp.mia_open(u_owner, 'instagram_page_linked',
    jsonb_build_object(
      'ig_user_id', v_platform,
      'facebook_page_id', 'mia-page-a20b',
      'facebook_user_id', 'mia-fb-user-a20b',
      'page_access_token', 'synthetic-not-a-live-secret'),
    v_id, NULL);
  PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_open ->> 'attempt_id',
    'selection_key', v_open ->> 'selection_key'));
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A20 a later conversion removes the second id';
  v_before := pg_temp.mia_fingerprint(u_owner);
  v_replay := public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
    'attempt_id', v_repair_attempt,
    'selection_key', v_repair_key));
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 replaying the repair does not restore the removed second id';
  SELECT sa.account_metadata INTO v_meta
    FROM public.social_accounts AS sa WHERE sa.id = v_id;
  ASSERT NOT (v_meta ? 'ig_igid'),
    'A20 the removed second id stays removed';

  -- A different provider identity still refuses before any metadata repair.
  v_n := v_n + 1;
  v_id := ('0eb20001-0000-4000-8000-' || lpad(v_n::text, 12, '0'))::uuid;
  v_platform := 'mia-ig-a20-fence';
  PERFORM pg_temp.mia_account(
    v_id, u_owner, v_platform,
    jsonb_build_object('ig_user_id', 'foreign-old-id', 'ig_igid', 'kept-second', 'legacy', 'kept'),
    'facebook_page', 'direct');
  v_open := pg_temp.mia_open(u_owner, 'instagram_direct',
    pg_temp.mia_direct_candidate('mia-ig-a20-other', NULL), v_id, NULL);
  v_before := pg_temp.mia_fingerprint(u_owner);
  BEGIN
    PERFORM public.commit_meta_oauth_selection(u_owner, jsonb_build_object(
      'attempt_id', v_open ->> 'attempt_id',
      'selection_key', v_open ->> 'selection_key'));
    RAISE EXCEPTION 'A20 failed: a changed provider identity was repaired as metadata';
  EXCEPTION WHEN SQLSTATE 'MOA07' THEN NULL;
  END;
  ASSERT pg_temp.mia_fingerprint(u_owner) = v_before,
    'A20 a changed provider identity changes nothing';
END
$a20$;

ROLLBACK;

\echo '=== meta_oauth_identity_alias: ALL CHECKS PASSED ==='
