-- ===========================================================================
-- Task 3a - protected Instagram capability and credential prerequisites.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   ("Task 3a establishes a service-write-only Instagram connection/capability
--   record (owner/account/token reference, trusted login kind, credential
--   generation, permission read result)").
--
-- APPLY AS supabase_admin. It owns the tables and the functions below;
-- postgres is not a superuser on this stack, and a REVOKE by a non-owner is a
-- WARNING that changes nothing (same reason as 20260906130000).
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   The protected state that the Instagram insights / competitor-tracking
--   feature needs BEFORE any of its readers or writers exist. Two relations,
--   one row each per Instagram social account, plus a small set of
--   service-only RPCs that are the only way to write them:
--
--     instagram_account_capabilities
--       owner/account binding, trusted login kind, permission-read state,
--       granted scope set, credential generation, timestamps.
--
--     instagram_account_credentials
--       the optional server-only home for a Facebook USER token (the token
--       Business Discovery may need), bound to the same account and owner.
--
-- WHY A NEW RELATION AND NOT account_metadata
--
--   social_accounts.account_metadata is browser-readable (an owner can
--   SELECT their own row) AND browser-writable (GRANT ALL to authenticated
--   plus "Users can update own social accounts").
--   patch_account_metadata merges arbitrary caller-supplied keys into it for
--   the caller's own account, and is granted to anon and authenticated as
--   well. Every key inside it is therefore UNTRUSTED as a capability
--   statement.
--
--   The plan is explicit that this must not be trusted: a legacy metadata
--   scope array is "unknown until a successful bounded service-side reread",
--   "Never backfill `ok`" from metadata, and "Client-patched metadata is not
--   proof of grants: canonical capability state is service-write-only."
--
--   A capability a browser can forge cannot be the authority for a transport
--   decision, so the authority lives in its own relation with no browser
--   grant at all.
--
-- WHAT THIS IS NOT
--
--   * Not a change to the OAuth, refresh or brand-scrape flows. Nothing in
--     this migration WRITES social_accounts, and no existing caller is
--     modified. The RPCs read social_accounts to check the owner, and the
--     new relations reference it; that is all. Pointing the OAuth writers
--     at this relation is the separate "credential-cutover" slice the plan
--     schedules after Task 3a.
--   * Not a metadata backfill. No row is created for an existing account
--     here. Every account starts at permission_read_state = 'unknown', which
--     is the state the plan requires of every legacy account.
--   * Not a browser status projection. Nothing here is readable by anon or
--     authenticated. The owner-visible projection is a later slice.
--   * Not a claim that a Facebook User token is needed. P8 made the
--     protected store conditional on a probe that has not run. The
--     credential relation exists so that when the probe says it is needed,
--     the storage is already there - and until then it stays empty.
--
-- SECURITY MODEL
--
--   * Both relations: RLS enabled, ZERO policies, privileges revoked from
--     PUBLIC, anon and authenticated. The only writer is the service role.
--   * Ownership is STRUCTURAL. The composite foreign key
--     (social_account_id, user_id, platform) ->
--     social_accounts (id, user_id, platform) uses the existing UNIQUE
--     constraint social_accounts_id_user_id_platform_key, so a row cannot
--     name an account, an owner and a platform that do not agree with each
--     other. A cross-owner write fails at the database, not at a policy.
--   * The service-role RPCs re-check the same (account, owner, platform)
--     triple in SQL before touching anything. RLS is not relied on for the
--     service role, which bypasses it.
--   * The credential value never appears in the status projection. It has
--     its own service-only read, which returns null (not an empty string)
--     when there is no credential.
--
-- PERMISSION-READ STATE MACHINE
--
--   unknown - no successful read has ever been recorded. The scope set is
--             NOT authoritative. This is every legacy account's state.
--   ok      - a successful read is recorded. The scope set IS
--             authoritative, INCLUDING when it is empty: an empty set that
--             was read successfully is a DENIAL, which is different from
--             "unknown". Only this state authorises anything.
--   failed  - a read was attempted and failed, and no successful read has
--             ever been recorded. The scope set is not authoritative.
--
--   A failed read NEVER overwrites an established successful read: when the
--   stored state is 'ok', a failed read updates only last_read_failed_at and
--   last_read_error_code and leaves the state and the scope set alone.
--
-- CREDENTIAL GENERATION
--
--   credential_generation starts at 0 and advances by exactly one in the
--   same transaction as a credential replacement, a reconnect, a revocation,
--   or bump_instagram_credential_generation.
--
--   That bump function is generation-only. It does not write a token or a
--   status, and calling it in a later HTTP request after updating
--   social_accounts is not atomic. Task 2 must apply the authoritative
--   token/status change and the generation advance in one database
--   transaction before any refresh integration. This migration does not add
--   that combined writer, and the helper alone is not it.
--
--   A permission-read write names the generation observed when the read
--   started (payload expected_credential_generation). A mismatch writes
--   nothing. The evidence timestamp is the read's start, not the arrival
--   of the response, and it must move forward inside one generation.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The capability relation.
-- ===========================================================================

CREATE TABLE public.instagram_account_capabilities (
  social_account_id     UUID NOT NULL,
  user_id               UUID NOT NULL,
  platform              TEXT NOT NULL DEFAULT 'instagram',
  -- The TRUSTED login kind. Written by the server only, from the flow that
  -- actually performed the OAuth exchange - never from client metadata and
  -- never inferred from a metadata heuristic.
  login_kind            TEXT NOT NULL,
  permission_read_state TEXT NOT NULL DEFAULT 'unknown',
  granted_scopes        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  scopes_read_at        TIMESTAMPTZ,
  last_read_failed_at   TIMESTAMPTZ,
  last_read_error_code  TEXT,
  credential_generation BIGINT NOT NULL DEFAULT 0,
  credential_updated_at TIMESTAMPTZ,
  generation_reason     TEXT,
  reconnected_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT instagram_account_capabilities_pkey
    PRIMARY KEY (social_account_id),
  CONSTRAINT instagram_account_capabilities_platform_chk
    CHECK (platform = 'instagram'),
  CONSTRAINT instagram_account_capabilities_login_kind_chk
    CHECK (login_kind IN ('direct', 'page_linked')),
  CONSTRAINT instagram_account_capabilities_permission_read_state_chk
    CHECK (permission_read_state IN ('unknown', 'ok', 'failed')),
  CONSTRAINT instagram_account_capabilities_generation_chk
    CHECK (credential_generation >= 0),
  -- An array may hold NULL elements; a scope set with one is meaningless and
  -- would compare oddly against a scope list read from the provider.
  CONSTRAINT instagram_account_capabilities_scopes_no_nulls_chk
    CHECK (array_position(granted_scopes, NULL) IS NULL),
  CONSTRAINT instagram_account_capabilities_read_error_code_len_chk
    CHECK (last_read_error_code IS NULL OR char_length(last_read_error_code) <= 100),
  CONSTRAINT instagram_account_capabilities_generation_reason_len_chk
    CHECK (generation_reason IS NULL OR char_length(generation_reason) <= 100),
  -- A stored success is proof only when it carries a real timestamp.
  -- infinity is a valid timestamptz input and is not proof. A failed state
  -- likewise cannot be stored without the time the failed read started.
  CONSTRAINT instagram_account_capabilities_scopes_read_at_finite_chk
    CHECK (scopes_read_at IS NULL OR isfinite(scopes_read_at)),
  CONSTRAINT instagram_account_capabilities_failed_at_finite_chk
    CHECK (last_read_failed_at IS NULL OR isfinite(last_read_failed_at)),
  CONSTRAINT instagram_account_capabilities_ok_read_at_chk
    CHECK (permission_read_state <> 'ok' OR scopes_read_at IS NOT NULL),
  CONSTRAINT instagram_account_capabilities_failed_read_at_chk
    CHECK (permission_read_state <> 'failed' OR last_read_failed_at IS NOT NULL),
  -- The ownership binding. social_accounts_id_user_id_platform_key is
  -- UNIQUE (id, user_id, platform) in the production baseline, so this
  -- reference is legal and is what makes a cross-owner row impossible.
  --
  -- ON UPDATE NO ACTION is deliberate, and is the default: moving an
  -- account to a different owner is refused while a capability row exists,
  -- because a credential-bearing account changing hands has to be an
  -- explicit revoke-and-regrant, not a silent cascade. Deleting the account
  -- does cascade, which is the case that must not leave a credential behind.
  CONSTRAINT instagram_account_capabilities_owner_fkey
    FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

CREATE INDEX idx_instagram_account_capabilities_user
  ON public.instagram_account_capabilities (user_id);

COMMENT ON TABLE public.instagram_account_capabilities IS
  'Service-write-only authoritative Instagram capability state per social '
  'account. Not readable by anon or authenticated. Legacy account_metadata '
  'scope arrays are NOT migrated here: every account starts unknown until a '
  'successful server-side permission read records one.';

COMMENT ON COLUMN public.instagram_account_capabilities.permission_read_state IS
  'unknown = never read successfully (scope set not authoritative); ok = a '
  'successful read is recorded (scope set authoritative, an EMPTY set is a '
  'denial); failed = a read failed and none ever succeeded.';

COMMENT ON COLUMN public.instagram_account_capabilities.credential_generation IS
  'Version of this account''s credential set. Advances by one in the same '
  'transaction as a credential replacement, a reconnect, a revocation, or a '
  'generation-only bump. The bump does not itself update social_accounts.';

COMMENT ON COLUMN public.instagram_account_capabilities.scopes_read_at IS
  'Start of the permission read that produced the stored successful result, '
  'not the time the provider response arrived. Task 2 must capture this, and '
  'the credential generation, before the provider call. Same-generation '
  'writes must be strictly newer than stored read evidence.';

COMMENT ON COLUMN public.instagram_account_capabilities.last_read_failed_at IS
  'Start of a failed permission read, not the time the failure response '
  'arrived. Same ordering rule as scopes_read_at.';

-- ===========================================================================
-- 2. The optional protected credential relation.
--
-- Only accounts that genuinely need a Facebook USER token get a row here.
-- A page-linked account whose usable token already lives in
-- social_accounts.access_token does NOT get one, and the transport must
-- treat "no protected credential" as unavailable, not as a success.
--
-- The token is stored here rather than in account_metadata because
-- account_metadata is owner-readable through the browser. It is stored in
-- the clear rather than in Vault because the DB harness baseline has no
-- supabase_vault extension, so a Vault-backed writer could not be exercised
-- by any SQL suite in this repository - and an untested credential write
-- path is worse than a tightly granted one. The relation has no browser
-- grant and no policy at all, which is strictly tighter than the
-- account_metadata.user_token placement it replaces.
-- ===========================================================================

CREATE TABLE public.instagram_account_credentials (
  social_account_id UUID NOT NULL,
  user_id           UUID NOT NULL,
  platform          TEXT NOT NULL DEFAULT 'instagram',
  credential_kind   TEXT NOT NULL,
  token             TEXT NOT NULL,
  token_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT instagram_account_credentials_pkey
    PRIMARY KEY (social_account_id),
  CONSTRAINT instagram_account_credentials_platform_chk
    CHECK (platform = 'instagram'),
  -- Only the Facebook User token is modelled. The Instagram Login and the
  -- page-token flavours keep using social_accounts.access_token, which is
  -- where they already live.
  CONSTRAINT instagram_account_credentials_kind_chk
    CHECK (credential_kind = 'facebook_user'),
  CONSTRAINT instagram_account_credentials_token_chk
    CHECK (btrim(token) <> ''),
  CONSTRAINT instagram_account_credentials_owner_fkey
    FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  -- A credential cannot exist without the capability record that owns its
  -- generation.
  CONSTRAINT instagram_account_credentials_capability_fkey
    FOREIGN KEY (social_account_id)
    REFERENCES public.instagram_account_capabilities (social_account_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.instagram_account_credentials IS
  'Service-only home for the optional Facebook User token. No browser grant, '
  'no policy. A missing row means "no protected credential", never "an empty '
  'token".';

-- ===========================================================================
-- 3. updated_at triggers (same helper the rest of the schema uses).
-- ===========================================================================

CREATE TRIGGER update_instagram_account_capabilities_updated_at
  BEFORE UPDATE ON public.instagram_account_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_instagram_account_credentials_updated_at
  BEFORE UPDATE ON public.instagram_account_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 4. RLS + grants.
--
-- House convention (20260910100000_partner_platform_tier.sql): RLS on, NO
-- policies, explicit grants that do not depend on environment-specific
-- default privileges. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated,
-- so the REVOKEs below are load-bearing, not decoration.
-- ===========================================================================

ALTER TABLE public.instagram_account_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_account_credentials ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.instagram_account_capabilities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_account_credentials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_account_capabilities FROM service_role;
REVOKE ALL ON public.instagram_account_credentials FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_account_capabilities TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_account_credentials TO service_role;

-- ===========================================================================
-- 5. The projection helper.
--
-- Builds the non-secret status document every write RPC returns. It never
-- contains a credential value; the credential has its own read below.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.instagram_account_capability_projection(
  p_social_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_present            BOOLEAN := false;
  v_login_kind         TEXT := NULL;
  v_read_state         TEXT := NULL;
  v_granted_scopes    TEXT[] := NULL;
  v_scopes_read_at     TIMESTAMPTZ := NULL;
  v_read_failed_at     TIMESTAMPTZ := NULL;
  v_read_error_code    TEXT := NULL;
  v_generation         BIGINT := NULL;
  v_credential_updated TIMESTAMPTZ := NULL;
  v_generation_reason  TEXT := NULL;
  v_reconnected_at     TIMESTAMPTZ := NULL;
  v_updated_at         TIMESTAMPTZ := NULL;
  v_has_credential     BOOLEAN := false;
BEGIN
  SELECT true, c.login_kind, c.permission_read_state, c.granted_scopes,
         c.scopes_read_at, c.last_read_failed_at, c.last_read_error_code,
         c.credential_generation, c.credential_updated_at, c.generation_reason,
         c.reconnected_at, c.updated_at
    INTO v_present, v_login_kind, v_read_state, v_granted_scopes,
         v_scopes_read_at, v_read_failed_at, v_read_error_code,
         v_generation, v_credential_updated, v_generation_reason,
         v_reconnected_at, v_updated_at
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id;

  SELECT EXISTS (SELECT 1
                   FROM public.instagram_account_credentials AS cr
                  WHERE cr.social_account_id = p_social_account_id)
    INTO v_has_credential;

  RETURN jsonb_build_object(
    'social_account_id', p_social_account_id,
    'platform', 'instagram',
    'capability_present', COALESCE(v_present, false),
    'login_kind', v_login_kind,
    'permission_read_state', COALESCE(v_read_state, 'unknown'),
    -- Only 'ok' makes the scope set authoritative. An empty scope set with
    -- this flag true is a DENIAL read successfully; with it false it is
    -- simply unknown.
    'scopes_authoritative', (COALESCE(v_read_state, 'unknown') = 'ok'),
    'granted_scopes', COALESCE(v_granted_scopes, ARRAY[]::TEXT[]),
    'scopes_read_at', v_scopes_read_at,
    'last_read_failed_at', v_read_failed_at,
    'last_read_error_code', v_read_error_code,
    'credential_generation', COALESCE(v_generation, 0),
    'credential_updated_at', v_credential_updated,
    'generation_reason', v_generation_reason,
    'reconnected_at', v_reconnected_at,
    -- Presence only. The value lives behind
    -- read_instagram_account_credential.
    'has_protected_credential', COALESCE(v_has_credential, false),
    'updated_at', v_updated_at
  );
END;
$function$;

-- ===========================================================================
-- 6. read_instagram_account_capability - the status read.
--
-- Owner-scoped: the (account, owner, platform) triple is checked against
-- social_accounts directly. The service role bypasses RLS, so this check is
-- the only thing standing between a caller-supplied owner id and another
-- user's row.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_instagram_account_capability(
  p_social_account_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owned BOOLEAN;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- ===========================================================================
-- 7. write_instagram_account_capability - the capability write.
--
-- Payload keys (nothing else is accepted):
--   login_kind                     text    'direct' | 'page_linked'
--   permission_read_state          text    'unknown' | 'ok' | 'failed'
--   expected_credential_generation number  see the contract below
--   granted_scopes                 text[]  required when state = 'ok'
--   scopes_read_at                 string  required when state = 'ok'
--   read_failed_at                 string  required when state = 'failed'
--   read_error_code                text    optional, with state = 'failed' only
--
-- The function signature is unchanged: the generation fence is a payload
-- key, not a new argument. Task 2 is the first caller.
--
-- expected_credential_generation
--   State-bearing writes (permission_read_state is present, including
--   unknown and failed) MUST supply the generation observed when the read
--   started. Creation supplies 0, because a new row is born at generation 0
--   and a read that began before the row existed observed 0.
--   Login-kind-only creation (no permission_read_state) may omit the key;
--   if it is present it must be 0. That path is a control write, not a
--   permission response.
--   Every write to an EXISTING row must supply the key, including a
--   login-kind-only control write. A missing key is a refusal (SQLSTATE
--   ICG03). It is never treated as "whatever the row says now".
--   Under the per-account advisory lock the value is compared to the live
--   credential_generation. A mismatch raises SQLSTATE ICG01 and writes
--   nothing, so an in-flight result cannot land after reconnect, replace,
--   or revoke. Callers must not substitute the generation they see when
--   the response arrives.
--
-- Evidence timestamps
--   scopes_read_at and read_failed_at are the start of the permission read
--   (an evidence version), not the time the response arrived. Task 2 must
--   capture the timestamp and the generation before calling the provider,
--   then send both with the result. A later-started read therefore has a
--   later timestamp even when its response arrives first.
--   The JSON value must be a non-empty string that casts to a finite
--   timestamptz. JSON null, numbers, booleans, empty strings, and infinity
--   raise SQLSTATE ICG04. A null timestamp is not a successful read.
--   On the same generation the evidence timestamp must be strictly newer
--   than the newest stored scopes_read_at / last_read_failed_at, and
--   strictly newer than credential_updated_at when that is set (the moment
--   the current generation began). Otherwise SQLSTATE ICG02 and no write.
--   An older grant cannot overwrite a newer denial. A result whose read
--   started before the current generation cannot restore scopes, even if a
--   caller attaches the new generation number.
--
-- A failed read never downgrades an established 'ok' on the same generation.
-- It records last_read_failed_at only when its own evidence timestamp is
-- accepted. Success keys and failure keys together are refused, as are read
-- keys on a payload that does not name a permission_read_state, so those
-- fields cannot be silently ignored.
--
-- Refusal SQLSTATEs used by the suite:
--   ICG01  supplied generation does not match the live generation
--   ICG02  evidence timestamp is stale for the live generation
--   ICG03  expected_credential_generation missing or not a valid integer
--   ICG04  evidence timestamp or read-payload shape is invalid
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.write_instagram_account_capability(
  p_social_account_id UUID,
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
  v_key                   TEXT;
  v_owned                 BOOLEAN;
  v_current_state         TEXT := NULL;
  v_current_kind          TEXT := NULL;
  v_current_generation    BIGINT := NULL;
  v_current_scopes_read_at TIMESTAMPTZ := NULL;
  v_current_failed_at     TIMESTAMPTZ := NULL;
  v_credential_updated_at TIMESTAMPTZ := NULL;
  v_state_provided        BOOLEAN := false;
  v_generation_provided   BOOLEAN := false;
  v_generation_text       TEXT;
  v_expected_generation   BIGINT := NULL;
  v_incoming_state        TEXT;
  v_effective             TEXT;
  v_login_kind            TEXT := NULL;
  v_scopes                TEXT[] := ARRAY[]::TEXT[];
  v_scopes_read_at        TIMESTAMPTZ := NULL;
  v_failed_at             TIMESTAMPTZ := NULL;
  v_error_code            TEXT := NULL;
  v_raw_timestamp         TEXT;
  v_evidence              TIMESTAMPTZ := NULL;
  v_latest_evidence       TIMESTAMPTZ := NULL;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('login_kind', 'permission_read_state',
                     'expected_credential_generation', 'granted_scopes',
                     'scopes_read_at', 'read_failed_at', 'read_error_code') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key;
    END IF;
  END LOOP;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  -- One writer per account at a time. Transaction-scoped, so no cleanup
  -- path can leak it (same pattern as save_user_ai_provider_key). The
  -- generation compare and the mutation below both run while this lock
  -- is held.
  PERFORM pg_advisory_xact_lock(
    hashtext('instagram_capability:' || p_social_account_id::text));

  SELECT c.permission_read_state, c.login_kind, c.credential_generation,
         c.scopes_read_at, c.last_read_failed_at, c.credential_updated_at
    INTO v_current_state, v_current_kind, v_current_generation,
         v_current_scopes_read_at, v_current_failed_at, v_credential_updated_at
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id;

  -- login_kind ------------------------------------------------------------
  IF p_payload ? 'login_kind' THEN
    IF jsonb_typeof(p_payload -> 'login_kind') <> 'string' THEN
      RAISE EXCEPTION 'login_kind must be a string';
    END IF;
    v_login_kind := p_payload ->> 'login_kind';
    IF v_login_kind NOT IN ('direct', 'page_linked') THEN
      RAISE EXCEPTION 'login_kind must be direct or page_linked';
    END IF;
    IF v_current_kind IS NOT NULL AND v_current_kind <> v_login_kind THEN
      RAISE EXCEPTION
        'login kind change requires record_instagram_account_reconnect';
    END IF;
  ELSE
    v_login_kind := v_current_kind;
  END IF;

  IF v_login_kind IS NULL THEN
    RAISE EXCEPTION 'login_kind is required to create a capability record';
  END IF;

  -- permission read state ------------------------------------------------
  -- An absent key means "leave the state alone", not "reset it". A caller
  -- that only writes a login kind must not silently downgrade a recorded
  -- permission read.
  v_state_provided := (p_payload ? 'permission_read_state');
  IF v_state_provided THEN
    IF jsonb_typeof(p_payload -> 'permission_read_state') <> 'string' THEN
      RAISE EXCEPTION 'permission_read_state must be a string';
    END IF;
    v_incoming_state := p_payload ->> 'permission_read_state';
    IF v_incoming_state NOT IN ('unknown', 'ok', 'failed') THEN
      RAISE EXCEPTION 'permission_read_state must be unknown, ok or failed';
    END IF;
  ELSE
    v_incoming_state := 'unknown';
  END IF;

  -- Read-result keys are meaningful only on the matching state. Leaving
  -- them on the wrong payload used to drop them on the floor.
  IF NOT v_state_provided THEN
    IF p_payload ? 'granted_scopes' OR p_payload ? 'scopes_read_at'
       OR p_payload ? 'read_failed_at' OR p_payload ? 'read_error_code' THEN
      RAISE EXCEPTION 'permission read fields require permission_read_state'
        USING ERRCODE = 'ICG04';
    END IF;
  ELSIF v_incoming_state = 'unknown' THEN
    IF p_payload ? 'granted_scopes' OR p_payload ? 'scopes_read_at'
       OR p_payload ? 'read_failed_at' OR p_payload ? 'read_error_code' THEN
      RAISE EXCEPTION 'permission_read_state unknown cannot include read result fields'
        USING ERRCODE = 'ICG04';
    END IF;
  ELSIF v_incoming_state = 'ok' THEN
    IF p_payload ? 'read_failed_at' OR p_payload ? 'read_error_code' THEN
      RAISE EXCEPTION 'a successful permission read cannot include failure fields'
        USING ERRCODE = 'ICG04';
    END IF;
  ELSIF v_incoming_state = 'failed' THEN
    IF p_payload ? 'granted_scopes' OR p_payload ? 'scopes_read_at' THEN
      RAISE EXCEPTION 'a failed permission read cannot include grant fields'
        USING ERRCODE = 'ICG04';
    END IF;
  END IF;

  IF v_state_provided AND v_incoming_state = 'ok' THEN
    IF NOT (p_payload ? 'granted_scopes') THEN
      RAISE EXCEPTION 'granted_scopes is required for a successful permission read';
    END IF;
    IF jsonb_typeof(p_payload -> 'granted_scopes') <> 'array' THEN
      RAISE EXCEPTION 'granted_scopes must be an array';
    END IF;
    IF EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_payload -> 'granted_scopes') AS e(value)
          WHERE jsonb_typeof(e.value) <> 'string'
             OR btrim(e.value #>> '{}') = ''
       ) THEN
      RAISE EXCEPTION 'granted_scopes must contain only non-empty strings';
    END IF;
    v_scopes := ARRAY(
      SELECT DISTINCT btrim(e.value #>> '{}')
        FROM jsonb_array_elements(p_payload -> 'granted_scopes') AS e(value)
       ORDER BY 1
    );
    IF NOT (p_payload ? 'scopes_read_at') THEN
      RAISE EXCEPTION 'scopes_read_at is required for a successful permission read';
    END IF;
    IF jsonb_typeof(p_payload -> 'scopes_read_at') <> 'string'
       OR btrim(p_payload ->> 'scopes_read_at') = '' THEN
      RAISE EXCEPTION 'scopes_read_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_raw_timestamp := btrim(p_payload ->> 'scopes_read_at');
    BEGIN
      v_scopes_read_at := v_raw_timestamp::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'scopes_read_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END;
    IF v_scopes_read_at IS NULL OR NOT isfinite(v_scopes_read_at) THEN
      RAISE EXCEPTION 'scopes_read_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
  ELSIF v_state_provided AND v_incoming_state = 'failed' THEN
    IF NOT (p_payload ? 'read_failed_at') THEN
      RAISE EXCEPTION 'read_failed_at is required for a failed permission read';
    END IF;
    IF jsonb_typeof(p_payload -> 'read_failed_at') <> 'string'
       OR btrim(p_payload ->> 'read_failed_at') = '' THEN
      RAISE EXCEPTION 'read_failed_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_raw_timestamp := btrim(p_payload ->> 'read_failed_at');
    BEGIN
      v_failed_at := v_raw_timestamp::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'read_failed_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END;
    IF v_failed_at IS NULL OR NOT isfinite(v_failed_at) THEN
      RAISE EXCEPTION 'read_failed_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    IF p_payload ? 'read_error_code' THEN
      IF jsonb_typeof(p_payload -> 'read_error_code') <> 'string' THEN
        RAISE EXCEPTION 'read_error_code must be a string'
          USING ERRCODE = 'ICG04';
      END IF;
      v_error_code := p_payload ->> 'read_error_code';
      IF char_length(v_error_code) > 100 THEN
        RAISE EXCEPTION 'read_error_code must be at most 100 characters';
      END IF;
    END IF;
  END IF;

  -- Generation token. Validated before any mutation. A missing key is
  -- legal only for login-kind-only creation.
  v_generation_provided := (p_payload ? 'expected_credential_generation');
  IF v_generation_provided THEN
    IF jsonb_typeof(p_payload -> 'expected_credential_generation') <> 'number' THEN
      RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
        USING ERRCODE = 'ICG03';
    END IF;
    v_generation_text := p_payload ->> 'expected_credential_generation';
    IF v_generation_text !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
        USING ERRCODE = 'ICG03';
    END IF;
    BEGIN
      v_expected_generation := v_generation_text::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
        USING ERRCODE = 'ICG03';
    END;
  END IF;

  IF v_current_state IS NULL THEN
    IF v_state_provided AND NOT v_generation_provided THEN
      RAISE EXCEPTION 'expected_credential_generation is required'
        USING ERRCODE = 'ICG03';
    END IF;
    IF v_generation_provided AND v_expected_generation <> 0 THEN
      RAISE EXCEPTION 'expected_credential_generation must be 0 when creating a capability record'
        USING ERRCODE = 'ICG03';
    END IF;
  ELSE
    IF NOT v_generation_provided THEN
      RAISE EXCEPTION 'expected_credential_generation is required'
        USING ERRCODE = 'ICG03';
    END IF;
    IF v_expected_generation <> v_current_generation THEN
      RAISE EXCEPTION 'stale credential generation: expected % live %',
        v_expected_generation, v_current_generation
        USING ERRCODE = 'ICG01';
    END IF;
  END IF;

  -- Same-generation evidence order, still inside the account lock and
  -- still before any write. Creation has no stored evidence and no
  -- generation boundary (credential_updated_at is null until the first
  -- generation advance).
  IF v_state_provided AND v_incoming_state IN ('ok', 'failed') THEN
    v_evidence := CASE
      WHEN v_incoming_state = 'ok' THEN v_scopes_read_at
      ELSE v_failed_at
    END;

    IF v_credential_updated_at IS NOT NULL
       AND v_evidence <= v_credential_updated_at THEN
      RAISE EXCEPTION
        'stale permission read: evidence timestamp predates the current credential generation'
        USING ERRCODE = 'ICG02';
    END IF;

    IF v_current_scopes_read_at IS NOT NULL THEN
      v_latest_evidence := v_current_scopes_read_at;
    END IF;
    IF v_current_failed_at IS NOT NULL
       AND (v_latest_evidence IS NULL OR v_current_failed_at > v_latest_evidence) THEN
      v_latest_evidence := v_current_failed_at;
    END IF;

    IF v_latest_evidence IS NOT NULL AND v_evidence <= v_latest_evidence THEN
      RAISE EXCEPTION
        'stale permission read: evidence timestamp is not newer than the stored read'
        USING ERRCODE = 'ICG02';
    END IF;
  END IF;

  -- An established successful read is never downgraded. A failed read
  -- still records that it failed (last_read_failed_at), it just does not
  -- take the record out of the authoritative state. A payload that says
  -- nothing about the state leaves it exactly as it was.
  IF NOT v_state_provided THEN
    v_effective := COALESCE(v_current_state, 'unknown');
  ELSIF v_current_state = 'ok' AND v_incoming_state IN ('unknown', 'failed') THEN
    v_effective := 'ok';
  ELSE
    v_effective := v_incoming_state;
  END IF;

  IF v_current_state IS NULL THEN
    INSERT INTO public.instagram_account_capabilities
      (social_account_id, user_id, platform, login_kind, permission_read_state,
       granted_scopes, scopes_read_at, last_read_failed_at, last_read_error_code)
    VALUES
      (p_social_account_id, p_user_id, 'instagram', v_login_kind, v_effective,
       CASE WHEN v_effective = 'ok' THEN v_scopes ELSE ARRAY[]::TEXT[] END,
       CASE WHEN v_effective = 'ok' THEN v_scopes_read_at ELSE NULL END,
       CASE WHEN v_effective = 'failed' THEN v_failed_at ELSE NULL END,
       CASE WHEN v_effective = 'failed' THEN v_error_code ELSE NULL END);
  ELSE
    UPDATE public.instagram_account_capabilities AS c
       SET permission_read_state = v_effective,
           granted_scopes = CASE
             WHEN v_incoming_state = 'ok' THEN v_scopes
             ELSE c.granted_scopes
           END,
           scopes_read_at = CASE
             WHEN v_incoming_state = 'ok' THEN v_scopes_read_at
             ELSE c.scopes_read_at
           END,
           last_read_failed_at = CASE
             WHEN v_incoming_state = 'ok' THEN NULL
             WHEN v_incoming_state = 'failed' THEN v_failed_at
             ELSE c.last_read_failed_at
           END,
           last_read_error_code = CASE
             WHEN v_incoming_state = 'ok' THEN NULL
             WHEN v_incoming_state = 'failed' THEN v_error_code
             ELSE c.last_read_error_code
           END,
           updated_at = now()
     WHERE c.social_account_id = p_social_account_id;
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- ===========================================================================
-- 8. replace_instagram_account_credential - credential replacement.
--
-- Writes the protected credential and advances credential_generation in the
-- same transaction. A refusal anywhere leaves the generation untouched:
-- the whole function body is one transaction, so the failed statement rolls
-- the increment back with it.
--
-- Payload keys:
--   credential_kind  text      must be 'facebook_user'
--   token            text      required, non-empty
--   token_expires_at timestamp optional
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.replace_instagram_account_credential(
  p_social_account_id UUID,
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
  v_key             TEXT;
  v_owned           BOOLEAN;
  v_capability      BOOLEAN;
  v_credential_kind TEXT;
  v_token           TEXT;
  v_expires_at      TIMESTAMPTZ := NULL;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('credential_kind', 'token', 'token_expires_at') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key;
    END IF;
  END LOOP;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  IF NOT (p_payload ? 'credential_kind') THEN
    RAISE EXCEPTION 'credential_kind is required';
  END IF;
  IF jsonb_typeof(p_payload -> 'credential_kind') <> 'string' THEN
    RAISE EXCEPTION 'credential_kind must be a string';
  END IF;
  v_credential_kind := p_payload ->> 'credential_kind';
  IF v_credential_kind <> 'facebook_user' THEN
    RAISE EXCEPTION 'credential_kind must be facebook_user';
  END IF;

  IF NOT (p_payload ? 'token') THEN
    RAISE EXCEPTION 'token is required';
  END IF;
  IF jsonb_typeof(p_payload -> 'token') <> 'string' THEN
    RAISE EXCEPTION 'token must be a string';
  END IF;
  v_token := p_payload ->> 'token';
  IF btrim(v_token) = '' THEN
    RAISE EXCEPTION 'token must not be empty';
  END IF;
  IF char_length(v_token) > 4096 THEN
    RAISE EXCEPTION 'token must be at most 4096 characters';
  END IF;

  IF p_payload ? 'token_expires_at' THEN
    BEGIN
      v_expires_at := (p_payload ->> 'token_expires_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'token_expires_at must be an ISO-8601 timestamp';
    END;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('instagram_capability:' || p_social_account_id::text));

  SELECT EXISTS (
           SELECT 1
             FROM public.instagram_account_capabilities AS c
            WHERE c.social_account_id = p_social_account_id
         ) INTO v_capability;

  IF NOT COALESCE(v_capability, false) THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;

  INSERT INTO public.instagram_account_credentials
    (social_account_id, user_id, platform, credential_kind, token,
     token_expires_at)
  VALUES
    (p_social_account_id, p_user_id, 'instagram', v_credential_kind, v_token,
     v_expires_at)
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_kind = EXCLUDED.credential_kind,
        token = EXCLUDED.token,
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at = now();

  -- The generation moves in the SAME transaction as the replacement. A
  -- worker holding generation N must not be allowed to write after this.
  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = 'credential_replaced',
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- ===========================================================================
-- 9. record_instagram_account_reconnect - reconnect.
--
-- A reconnect invalidates everything the previous connection established: the
-- protected credential is dropped, the permission read state returns to
-- 'unknown' (a new token may carry different scopes, and the plan forbids
-- carrying an old successful read across a credential change), and the
-- generation advances so in-flight work cannot write over the new state.
--
-- Payload keys:
--   login_kind text optional - the new trusted login flavour
--   reason     text optional - a short machine code, <= 100 chars
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_instagram_account_reconnect(
  p_social_account_id UUID,
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
  v_key        TEXT;
  v_owned      BOOLEAN;
  v_login_kind TEXT := NULL;
  v_reason     TEXT := 'reconnect';
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('login_kind', 'reason') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key;
    END IF;
  END LOOP;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  IF p_payload ? 'login_kind' THEN
    IF jsonb_typeof(p_payload -> 'login_kind') <> 'string' THEN
      RAISE EXCEPTION 'login_kind must be a string';
    END IF;
    v_login_kind := p_payload ->> 'login_kind';
    IF v_login_kind NOT IN ('direct', 'page_linked') THEN
      RAISE EXCEPTION 'login_kind must be direct or page_linked';
    END IF;
  END IF;

  IF p_payload ? 'reason' THEN
    IF jsonb_typeof(p_payload -> 'reason') <> 'string' THEN
      RAISE EXCEPTION 'reason must be a string';
    END IF;
    v_reason := p_payload ->> 'reason';
    IF char_length(v_reason) > 100 THEN
      RAISE EXCEPTION 'reason must be at most 100 characters';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('instagram_capability:' || p_social_account_id::text));

  IF NOT EXISTS (
       SELECT 1 FROM public.instagram_account_capabilities AS c
        WHERE c.social_account_id = p_social_account_id
     ) THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;

  DELETE FROM public.instagram_account_credentials
   WHERE social_account_id = p_social_account_id;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         permission_read_state = 'unknown',
         granted_scopes = ARRAY[]::TEXT[],
         scopes_read_at = NULL,
         last_read_failed_at = NULL,
         last_read_error_code = NULL,
         reconnected_at = now(),
         login_kind = COALESCE(v_login_kind, c.login_kind),
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- ===========================================================================
-- 10. bump_instagram_credential_generation - generation-only advance.
--
-- Changes credential_generation, credential_updated_at, and generation_reason.
-- It does not read or write social_accounts (token, expiry, needs_reauth,
-- or any other status), and it does not touch the protected credential row.
--
-- This is NOT a complete refresh. Calling it in a separate HTTP request
-- AFTER updating social_accounts is not atomic: the token can commit while
-- the generation stays behind, or the generation can advance while the
-- token update fails. That sequence is not a valid use.
--
-- Valid use requires the SAME database transaction as the authoritative
-- token or status update. Task 2 must implement that as one server-side
-- writer (one explicit transaction or one RPC). Two Supabase HTTP calls
-- cannot provide it. This helper alone does not. This migration does not
-- add the combined refresh writer; Task 2 owns that before any integration.
--
-- p_reason is a short machine code, not free text from a user.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.bump_instagram_credential_generation(
  p_social_account_id UUID,
  p_user_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owned BOOLEAN;
  v_reason TEXT := 'generation_bump';
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  IF p_reason IS NOT NULL THEN
    IF btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'p_reason must not be empty';
    END IF;
    IF char_length(p_reason) > 100 THEN
      RAISE EXCEPTION 'p_reason must be at most 100 characters';
    END IF;
    v_reason := p_reason;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('instagram_capability:' || p_social_account_id::text));

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

COMMENT ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT) IS
  'Generation-only. Does not update social_accounts or the credential value. '
  'Valid only in the SAME database transaction as the authoritative token or '
  'status update. A later HTTP call is not atomic. Task 2 must use one '
  'server-side transaction or RPC. This helper alone is not that writer.';

-- ===========================================================================
-- 11. revoke_instagram_account_credential - revocation.
--
-- The third event the plan says must advance the generation atomically
-- ("credential replacement/reconnect/revocation"). It removes the protected
-- credential and advances the version in the same transaction, so a worker
-- holding the old generation cannot write over the fact that the credential
-- is gone.
--
-- It is deliberately a separate function from
-- bump_instagram_credential_generation rather than a boolean switch on it:
-- a generation bump leaves the protected credential in place, and a
-- caller-supplied flag would make that difference optional. The bump is
-- still generation-only; it is not itself the refresh transaction.
--
-- p_reason is a short machine code, not free text from a user.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.revoke_instagram_account_credential(
  p_social_account_id UUID,
  p_user_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owned BOOLEAN;
  v_reason TEXT := 'credential_revoked';
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  IF p_reason IS NOT NULL THEN
    IF btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'p_reason must not be empty';
    END IF;
    IF char_length(p_reason) > 100 THEN
      RAISE EXCEPTION 'p_reason must be at most 100 characters';
    END IF;
    v_reason := p_reason;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('instagram_capability:' || p_social_account_id::text));

  IF NOT EXISTS (
       SELECT 1 FROM public.instagram_account_capabilities AS c
        WHERE c.social_account_id = p_social_account_id
     ) THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;

  DELETE FROM public.instagram_account_credentials
   WHERE social_account_id = p_social_account_id;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- ===========================================================================
-- 12. read_instagram_account_credential - the protected value.
--
-- Service role only, owner-scoped, and it is the ONLY function that returns
-- a credential value. A missing credential is reported as found = false
-- with nulls - never as an empty token, which would look like a usable
-- credential.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_instagram_account_credential(
  p_social_account_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owned      BOOLEAN;
  v_kind       TEXT := NULL;
  v_token      TEXT := NULL;
  v_expires_at TIMESTAMPTZ := NULL;
  v_generation BIGINT := NULL;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.social_accounts AS sa
            WHERE sa.id = p_social_account_id
              AND sa.user_id = p_user_id
              AND sa.platform = 'instagram'
         ) INTO v_owned;

  IF NOT COALESCE(v_owned, false) THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id;

  SELECT cr.credential_kind, cr.token, cr.token_expires_at
    INTO v_kind, v_token, v_expires_at
    FROM public.instagram_account_credentials AS cr
   WHERE cr.social_account_id = p_social_account_id;

  IF v_kind IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'social_account_id', p_social_account_id,
      'credential_kind', NULL,
      'token', NULL,
      'token_expires_at', NULL,
      'credential_generation', COALESCE(v_generation, 0)
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'social_account_id', p_social_account_id,
    'credential_kind', v_kind,
    'token', v_token,
    'token_expires_at', v_expires_at,
    'credential_generation', COALESCE(v_generation, 0)
  );
END;
$function$;

-- ===========================================================================
-- 13. Function grants.
--
-- Named EXPLICITLY. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated,
-- so "REVOKE ... FROM PUBLIC" alone leaves both roles holding EXECUTE (see
-- 20260831150000 for the incident). The anon key alone must not be able to
-- call any of these.
-- ===========================================================================

REVOKE EXECUTE ON FUNCTION public.instagram_account_capability_projection(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.read_instagram_account_capability(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.write_instagram_account_capability(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.replace_instagram_account_credential(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_instagram_account_reconnect(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.read_instagram_account_credential(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.instagram_account_capability_projection(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_instagram_account_capability(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_instagram_account_capability(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_instagram_account_credential(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_instagram_account_reconnect(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_instagram_account_credential(UUID, UUID) TO service_role;

COMMIT;
