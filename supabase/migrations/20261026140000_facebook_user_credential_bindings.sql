-- ===========================================================================
-- Facebook User credential authority and owner/account bindings.
--
-- Ordered AFTER 20261026120000_instagram_capability_prerequisites.sql.
-- Additive. That migration is not rewritten. Apply as supabase_admin.
--
-- WHY THIS EXISTS
--
--   instagram_account_credentials accepted only platform = instagram and
--   credential_kind = facebook_user. Both facebook-oauth User-token writes
--   target Facebook account metadata, and ad-analytics, facebook-places-search
--   and threads-location-search read that User token from the selected
--   Facebook or Instagram row. An Instagram-only secret cannot be the
--   authority for a Facebook-only connection or for one verified grant shared
--   by a Page and its page-linked Instagram account.
--
--   facebook_user_credentials is the only protected store for a Facebook
--   User token. facebook_user_credential_bindings associates that secret
--   with owned Facebook and Instagram social_accounts. Composite foreign
--   keys require the same owner on the account and on the credential.
--   Eligible platforms are facebook and instagram, structurally.
--
--   A page-linked Instagram relationship is NOT a foreign key to browser
--   metadata. The bind writer requires a service-written capability with
--   login_kind = page_linked plus an explicit verified-provider-identity
--   object in the payload. It never reads account_metadata and it never
--   treats platform_user_id as proof. SQL does not call Meta. This slice
--   does not invent live provider proof.
--
-- WHAT IS NOT IN THIS SLICE
--
--   No OAuth, refresh, or consumer TypeScript. No credential-mode column
--   and no claim that legacy mode is implemented. No Page-token or
--   messaging migration: social_accounts.access_token stays the Page /
--   account token. No snapshot or history changes. Direct Instagram Login
--   tokens stay in social_accounts.access_token and are not copied here.
--
-- TRANSITION OF instagram_account_credentials
--
--   Rows whose capability login_kind is page_linked and whose kind is
--   facebook_user are copied into one new credential and one Instagram
--   binding each. Tokens are not merged, including when the text matches.
--   The old token, expiry, and kind columns are then dropped. The old
--   table remains a secret-free compatibility linkage (credential_id only)
--   so the already-committed capability suite still has that relation.
--   It is not an authority. has_protected_credential and the credential
--   read resolve the binding.
--
--   If any old row is not a page-linked facebook_user secret, this
--   migration aborts and leaves that secret where it is. It does not
--   delete it and it does not relabel a direct-login row as a Facebook
--   User grant. An empty old table is a successful no-op.
--
-- FENCING
--
--   Lock order for every writer: social_accounts FOR UPDATE by id, then
--   the instagram_capability advisory lock the Task 3a writers already
--   take, then the credential row and its advisory lock. Replacement of
--   a secret bumps credential.revision by one and bumps credential_generation
--   on every bound Instagram capability. Disconnect (unbind, and the
--   account-scoped compatibility revoke/reconnect) removes one binding.
--   A shared secret is deleted only when its last binding is gone.
--   Grant revocation removes every binding and the secret, and bumps
--   every dependent Instagram generation. Reassigning an account or a
--   credential to another owner is refused by ON UPDATE NO ACTION.
--
--   Stale expected_revision / expected_capability_generation raises
--   SQLSTATE FUC01 and writes nothing. Callers capture those versions
--   before the provider call. A later response must not be attached to
--   whatever generation is current when it arrives.
--
--   Secret replacement and grant revocation compare the captured account
--   set to the bindings held under the lock. Every bound account must be
--   named. Every bound Instagram account must carry the capability
--   generation captured before the provider call. An omitted account is
--   refused. The function does not read the live generation and attach
--   the old response to it. Reconnect and attach change that set, so a
--   payload captured earlier no longer matches. There is no second
--   revoke that means "delete whatever is current" without those
--   versions. One-account disconnect stays on unbind.
--
--   bump_instagram_credential_generation still does not update
--   social_accounts. Task 2a must call the functions below, which apply
--   the narrow account token/expiry/health fields in the same database
--   function. Two HTTP RPCs are not one transaction.
--
-- TIMESTAMPS
--
--   Externally supplied evidence uses facebook_user_credential_parse_zoned_timestamp.
--   Accepted form, after trim:
--     YYYY-MM-DDTHH:MM:SS[.1-6 digits](Z|+HH:MM|-HH:MM|+HHMM|-HHMM)
--   Examples that pass: 2026-10-26T09:00:00Z, 2026-10-26T09:00:00+00:00,
--   2026-10-26T09:00:00+0000, fractional seconds up to microseconds.
--   Rejected: now, today, date-only, space separator, zone-less
--   2026-10-26T09:00:00, infinity. The permission writer uses this rule
--   and still reports SQLSTATE ICG04 with the existing
--   "finite ISO-8601 timestamp" message. Same-generation ordering is
--   unchanged. permission_read_state cannot move ok/failed back to
--   unknown (SQLSTATE ICG05); record_instagram_account_reconnect is the
--   reset.
--
-- COMPATIBILITY RPCS
--
--   These functions are not a production compatibility promise. Nothing
--   deployed calls them yet. They keep the Task 3a argument lists where
--   the fence fits in the existing payload, and they store the secret
--   only in facebook_user_credentials.
--
--   replace rejects login_kind direct (FUC02). A direct Instagram token
--   stays in social_accounts.access_token. replace requires
--   expected_credential_generation on every call (ICG03 when missing or
--   not an integer, ICG01 when stale). When the credential is already
--   bound to any other account, replace also requires
--   expected_bound_accounts, the complete bound set captured before the
--   provider call. A shared replacement that names only one account is
--   refused. Absent token_expires_at on that RPC still stores NULL,
--   matching the previous ON CONFLICT update. The new write RPC does not
--   clear an omitted expiry.
--
--   record_instagram_account_reconnect keeps its signature and requires
--   expected_credential_generation in the payload. It is one account's
--   reconnect, including a change of login_kind, and it removes only
--   that account's binding.
--
--   bump_instagram_credential_generation and
--   revoke_instagram_account_credential no longer exist as
--   (uuid, uuid, text). Those forms could move generation with no
--   captured version. The replacements add the captured generation as a
--   required bigint. Account revoke still removes one binding. It is not
--   grant revocation.
--
-- TASK 2a ENTRY POINTS (service_role only, one call = one transaction)
--
--   bind_facebook_user_credential(p_user_id, p_payload)
--     Create: expected_absent=true, token, provenance_source
--       oauth_exchange|token_refresh, provenance_captured_at,
--       social_account_id, verified_provider_identity, optional account,
--       and for Instagram expected_capability_generation.
--     Attach: credential_id, expected_revision, social_account_id,
--       provenance_source, verified_provider_identity, optional account,
--       and for Instagram expected_capability_generation.
--   write_facebook_user_credential(p_user_id, p_payload)
--     credential_id, expected_revision, optional token + provenance_*,
--     optional token_expires_at, accounts[].
--     A present token requires accounts to be the complete bound set,
--     with expected_capability_generation on every Instagram entry.
--     That call replaces the shared secret and fences every bound
--     Instagram capability. A call with no token updates only the listed
--     accounts' access_token / token_expires_at / needs_reauth /
--     failure_count / last_refresh_error / last_refresh_attempt_at and
--     fences only those Instagram rows.
--   unbind_facebook_user_credential(p_user_id, p_payload)
--     social_account_id, expected_revision, optional account, and for
--     Instagram expected_capability_generation. One binding. The secret
--     remains while another binding exists.
--   revoke_facebook_user_credential(p_user_id, p_payload)
--     credential_id, expected_revision, optional reason, and accounts[]
--     naming every currently bound account. Instagram entries carry
--     expected_capability_generation. Deletes every binding and the
--     secret only when that captured set still matches. Health fields
--     in those entries update in the same transaction. Not a one-account
--     disconnect and not a current-state revoke.
--   describe_facebook_user_credential(p_user_id, p_credential_id)
--     Versions, provenance, bindings. No token and no access_token.
--   read_facebook_user_credential(p_user_id, p_credential_id)
--   read_facebook_user_account_credential(p_user_id, p_social_account_id)
--     The only new reads that return the User token. Owner-scoped.
--     A missing owned account binding is found=false and token=null.
--     An unknown credential id for that owner raises; it is not an
--     empty success.
--
-- REFUSAL SQLSTATES
--   FUC01  stale revision, stale capability generation, or a captured
--          dependent set that is not the bound set under the lock
--   FUC02  direct Instagram, missing page-linked capability, or missing
--          verified provider identity
--   FUC03  expected-absent failed, or a credential would be stored with
--          no binding
--   FUC04  payload shape. A bad external timestamp is ICG04, not FUC04.
--   FUC06  migration refused rather than drop or relabel a secret
--   ICG01  compatibility generation fence
--   ICG02  permission-evidence ordering (unchanged)
--   ICG04  permission timestamp / read shape (unchanged message)
--   ICG05  ok/failed cannot return to unknown until reconnect
--
-- Results and exceptions do not include token text. There is no browser
-- grant and no RLS policy on the new relations.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers. Not part of the Task 2a RPC surface.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.facebook_user_credential_parse_zoned_timestamp(
  p_raw TEXT,
  p_field TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_text TEXT;
  v_parsed TIMESTAMPTZ;
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN
    RAISE EXCEPTION '% must be a finite ISO-8601 timestamp', p_field
      USING ERRCODE = 'ICG04';
  END IF;

  v_text := btrim(p_raw);
  -- Unambiguous zoned ISO-8601. Postgres would otherwise accept 'now',
  -- DateStyle dates, and zone-less strings under the session TimeZone.
  IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2}|[+-][0-9]{4})$' THEN
    RAISE EXCEPTION '% must be a finite ISO-8601 timestamp', p_field
      USING ERRCODE = 'ICG04';
  END IF;

  BEGIN
    v_parsed := v_text::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '% must be a finite ISO-8601 timestamp', p_field
      USING ERRCODE = 'ICG04';
  END;

  IF v_parsed IS NULL OR NOT isfinite(v_parsed) THEN
    RAISE EXCEPTION '% must be a finite ISO-8601 timestamp', p_field
      USING ERRCODE = 'ICG04';
  END IF;

  RETURN v_parsed;
END;
$function$;

COMMENT ON FUNCTION public.facebook_user_credential_parse_zoned_timestamp(TEXT, TEXT) IS
  'Accepts YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM|+HHMM|-HHMM) only. '
  'Rejects now, today, zone-less timestamps, and infinity. SQLSTATE ICG04.';

CREATE OR REPLACE FUNCTION public.facebook_user_credential_lock_scope(
  p_account_ids UUID[],
  p_credential_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_account UUID;
  v_credential UUID;
BEGIN
  -- Accounts first, credentials second, each set in id order. The
  -- instagram_capability advisory lock is the same one Task 3a takes, so
  -- the two writers cannot pass each other.
  FOR v_account IN
    SELECT DISTINCT x
      FROM unnest(COALESCE(p_account_ids, ARRAY[]::UUID[])) AS u(x)
     WHERE x IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM 1
      FROM public.social_accounts AS sa
     WHERE sa.id = v_account
       FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('social_account_guard:' || v_account::text));
    PERFORM pg_advisory_xact_lock(hashtext('instagram_capability:' || v_account::text));
  END LOOP;

  FOR v_credential IN
    SELECT DISTINCT x
      FROM unnest(COALESCE(p_credential_ids, ARRAY[]::UUID[])) AS u(x)
     WHERE x IS NOT NULL
     ORDER BY 1
  LOOP
    PERFORM 1
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential
       FOR UPDATE;
    PERFORM pg_advisory_xact_lock(
      hashtext('facebook_user_credential:' || v_credential::text));
  END LOOP;
END;
$function$;

-- The credential table is created just below. The lock helper's plpgsql
-- body is parsed on first call, after that table exists.

-- ---------------------------------------------------------------------------
-- 1. Credential authority. One row, one secret. Not one row per account.
-- ---------------------------------------------------------------------------

CREATE TABLE public.facebook_user_credentials (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL,
  token                   TEXT NOT NULL,
  revision                BIGINT NOT NULL DEFAULT 1,
  lifecycle               TEXT NOT NULL DEFAULT 'active',
  token_expires_at        TIMESTAMPTZ,
  provider_user_id        TEXT,
  provenance_source       TEXT NOT NULL,
  provenance_captured_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT facebook_user_credentials_owner_key
    UNIQUE (id, user_id),
  CONSTRAINT facebook_user_credentials_user_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT facebook_user_credentials_token_chk
    CHECK (btrim(token) <> '' AND char_length(token) <= 4096),
  CONSTRAINT facebook_user_credentials_revision_chk
    CHECK (revision >= 1),
  -- A stored row holds a live secret. Revocation deletes the row when
  -- no binding remains; there is no token-bearing 'revoked' residue.
  CONSTRAINT facebook_user_credentials_lifecycle_chk
    CHECK (lifecycle = 'active'),
  CONSTRAINT facebook_user_credentials_expiry_finite_chk
    CHECK (token_expires_at IS NULL OR isfinite(token_expires_at)),
  CONSTRAINT facebook_user_credentials_provider_user_chk
    CHECK (
      provider_user_id IS NULL
      OR (
        char_length(provider_user_id) BETWEEN 1 AND 128
        AND btrim(provider_user_id) = provider_user_id
      )
    ),
  CONSTRAINT facebook_user_credentials_provenance_chk
    CHECK (provenance_source IN (
      'oauth_exchange',
      'token_refresh',
      'migrated_instagram_account_credential',
      'compatibility_task3a'
    )),
  CONSTRAINT facebook_user_credentials_provenance_at_finite_chk
    CHECK (provenance_captured_at IS NULL OR isfinite(provenance_captured_at)),
  -- token_refresh may record a new secret before a Facebook user id is known
  -- (a migrated row). oauth_exchange still requires that id. This check is
  -- created here, not altered after the data copy: a deferred binding
  -- trigger is pending until commit, and PostgreSQL refuses ALTER TABLE
  -- on a relation that has pending trigger events.
  CONSTRAINT facebook_user_credentials_provenance_pair_chk
    CHECK (
      (
        provenance_source = 'oauth_exchange'
        AND provenance_captured_at IS NOT NULL
        AND provider_user_id IS NOT NULL
      )
      OR (
        provenance_source = 'token_refresh'
        AND provenance_captured_at IS NOT NULL
      )
      OR provenance_source IN (
        'migrated_instagram_account_credential',
        'compatibility_task3a'
      )
    )
);

CREATE INDEX idx_facebook_user_credentials_user
  ON public.facebook_user_credentials (user_id);

COMMENT ON TABLE public.facebook_user_credentials IS
  'Service-only Facebook User token authority. One secret may be bound to '
  'several owned Facebook and page-linked Instagram accounts. No browser '
  'grant. Not deduplicated by owner or username.';

COMMENT ON COLUMN public.facebook_user_credentials.token IS
  'Facebook User token. Returned only by the service-only read functions. '
  'Never project it and never log it.';

COMMENT ON COLUMN public.facebook_user_credentials.revision IS
  'Increments by one in the same transaction as a User-token replacement. '
  'A page-token, health, or single-account detach does not advance it and '
  'does not rotate the shared secret. Callers send the revision they '
  'captured before the provider call.';

CREATE TRIGGER update_facebook_user_credentials_updated_at
  BEFORE UPDATE ON public.facebook_user_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2. Bindings. Owner must match both the account and the credential.
-- ---------------------------------------------------------------------------

CREATE TABLE public.facebook_user_credential_bindings (
  social_account_id          UUID NOT NULL,
  user_id                    UUID NOT NULL,
  platform                   TEXT NOT NULL,
  credential_id              UUID NOT NULL,
  verified_facebook_user_id  TEXT,
  verified_facebook_page_id  TEXT,
  verified_instagram_user_id TEXT,
  evidence_source            TEXT NOT NULL,
  -- Per-account fence. Not the shared User-token revision, and not a
  -- browser metadata column. Exact-match only. The surviving fence row
  -- records the high water so a deleted binding cannot be rebound at a
  -- version a caller already captured.
  connection_version         BIGINT NOT NULL DEFAULT 1,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT facebook_user_credential_bindings_pkey
    PRIMARY KEY (social_account_id),
  CONSTRAINT facebook_user_credential_bindings_platform_chk
    CHECK (platform IN ('facebook', 'instagram')),
  CONSTRAINT facebook_user_credential_bindings_account_fkey
    FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT facebook_user_credential_bindings_credential_fkey
    FOREIGN KEY (credential_id, user_id)
    REFERENCES public.facebook_user_credentials (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT facebook_user_credential_bindings_fb_user_len_chk
    CHECK (
      verified_facebook_user_id IS NULL
      OR (
        char_length(verified_facebook_user_id) BETWEEN 1 AND 128
        AND btrim(verified_facebook_user_id) = verified_facebook_user_id
      )
    ),
  CONSTRAINT facebook_user_credential_bindings_page_len_chk
    CHECK (
      verified_facebook_page_id IS NULL
      OR (
        char_length(verified_facebook_page_id) BETWEEN 1 AND 128
        AND btrim(verified_facebook_page_id) = verified_facebook_page_id
      )
    ),
  CONSTRAINT facebook_user_credential_bindings_ig_len_chk
    CHECK (
      verified_instagram_user_id IS NULL
      OR (
        char_length(verified_instagram_user_id) BETWEEN 1 AND 128
        AND btrim(verified_instagram_user_id) = verified_instagram_user_id
      )
    ),
  -- Migration and the Task 3a compatibility RPC record no provider
  -- identity. New oauth/refresh binds must carry the identity the
  -- service writer verified. Browser metadata is not a source.
  CONSTRAINT facebook_user_credential_bindings_connection_version_chk
    CHECK (connection_version >= 1),
  CONSTRAINT facebook_user_credential_bindings_evidence_chk
    CHECK (
      (
        evidence_source = 'migrated_instagram_account_credential'
        AND platform = 'instagram'
        AND verified_facebook_user_id IS NULL
        AND verified_facebook_page_id IS NULL
        AND verified_instagram_user_id IS NULL
      )
      OR (
        evidence_source = 'compatibility_task3a'
        AND platform = 'instagram'
        AND verified_facebook_user_id IS NULL
        AND verified_facebook_page_id IS NULL
        AND verified_instagram_user_id IS NULL
      )
      OR (
        evidence_source IN ('oauth_exchange', 'token_refresh')
        AND platform = 'facebook'
        AND verified_facebook_user_id IS NOT NULL
        AND verified_facebook_page_id IS NULL
        AND verified_instagram_user_id IS NULL
      )
      OR (
        evidence_source IN ('oauth_exchange', 'token_refresh')
        AND platform = 'instagram'
        AND verified_facebook_user_id IS NOT NULL
        AND verified_facebook_page_id IS NOT NULL
        AND verified_instagram_user_id IS NOT NULL
      )
    )
);

CREATE INDEX idx_facebook_user_credential_bindings_credential
  ON public.facebook_user_credential_bindings (credential_id);

CREATE INDEX idx_facebook_user_credential_bindings_user
  ON public.facebook_user_credential_bindings (user_id);

-- High-water mark for connection_version. Unbind deletes the binding row
-- and must not make the next bind of the same credential look like the
-- version the caller already captured. Account deletion cascades this row.
-- It holds no secret.
CREATE TABLE public.facebook_user_credential_connection_fences (
  social_account_id   UUID PRIMARY KEY,
  user_id             UUID NOT NULL,
  platform            TEXT NOT NULL,
  connection_version  BIGINT NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT facebook_user_credential_connection_fences_platform_chk
    CHECK (platform IN ('facebook', 'instagram')),
  CONSTRAINT facebook_user_credential_connection_fences_version_chk
    CHECK (connection_version >= 1),
  CONSTRAINT facebook_user_credential_connection_fences_account_fkey
    FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

COMMENT ON TABLE public.facebook_user_credential_connection_fences IS
  'Service-only per-account connection high-water. Survives unbind so a '
  'rebind cannot recycle a captured connection version. Not browser '
  'metadata and not a second credential.';

CREATE TRIGGER update_facebook_user_credential_connection_fences_updated_at
  BEFORE UPDATE ON public.facebook_user_credential_connection_fences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.facebook_user_credential_bindings IS
  'Owner-scoped association from a Facebook or Instagram social account '
  'to one Facebook User credential. Page-link proof is the capability '
  'login_kind plus the verified identity stored here, never account_metadata.';

COMMENT ON COLUMN public.facebook_user_credential_bindings.connection_version IS
  'Exact-match fence for this binding. Facebook page-token and health '
  'writes advance it by one and leave the shared User-token revision '
  'unchanged. Instagram capability generation remains that account''s '
  'credential fence. Unbind compares this value, then the delete trigger '
  'advances the surviving high-water row.';

CREATE TRIGGER update_facebook_user_credential_bindings_updated_at
  BEFORE UPDATE ON public.facebook_user_credential_bindings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A committed secret must have a binding. Deferred so create-then-bind
-- in one transaction is legal, and a create that commits alone is not.
CREATE OR REPLACE FUNCTION public.facebook_user_credentials_require_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.credential_id = NEW.id
       AND b.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'facebook user credential cannot be stored without an account binding'
      USING ERRCODE = 'FUC03';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER facebook_user_credentials_binding_required
  AFTER INSERT OR UPDATE ON public.facebook_user_credentials
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.facebook_user_credentials_require_binding();

-- Last binding removal deletes the secret. Account delete cascades here
-- and then this trigger collects an orphan. The advisory lock is taken
-- after the account row lock the cascading delete already holds.
CREATE OR REPLACE FUNCTION public.facebook_user_credential_binding_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  DELETE FROM public.instagram_account_credentials
   WHERE social_account_id = OLD.social_account_id;

  -- Burn the captured connection version even though the binding row is
  -- gone. A later bind of the same credential allocates the next value.
  UPDATE public.facebook_user_credential_connection_fences AS f
     SET connection_version = f.connection_version + 1
   WHERE f.social_account_id = OLD.social_account_id
     AND f.user_id = OLD.user_id;

  PERFORM pg_advisory_xact_lock(
    hashtext('facebook_user_credential:' || OLD.credential_id::text));

  DELETE FROM public.facebook_user_credentials AS c
   WHERE c.id = OLD.credential_id
     AND c.user_id = OLD.user_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.facebook_user_credential_bindings AS b
        WHERE b.credential_id = OLD.credential_id
     );

  RETURN OLD;
END;
$function$;

CREATE TRIGGER facebook_user_credential_bindings_purge_secret
  AFTER DELETE ON public.facebook_user_credential_bindings
  FOR EACH ROW
  EXECUTE FUNCTION public.facebook_user_credential_binding_deleted();

ALTER TABLE public.facebook_user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facebook_user_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facebook_user_credential_connection_fences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.facebook_user_credentials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.facebook_user_credential_bindings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.facebook_user_credential_connection_fences FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.facebook_user_credentials FROM service_role;
REVOKE ALL ON public.facebook_user_credential_bindings FROM service_role;
REVOKE ALL ON public.facebook_user_credential_connection_fences FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.facebook_user_credentials TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.facebook_user_credential_bindings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.facebook_user_credential_connection_fences TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Move existing Instagram-only Facebook User secrets. Abort rather
--    than drop or relabel anything that is not a page-linked facebook_user
--    row. Do not read social_accounts.access_token.
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  r RECORD;
  v_credential_id UUID;
  v_old_count BIGINT;
  v_new_count BIGINT;
BEGIN
  IF to_regclass('public.instagram_account_credentials') IS NULL THEN
    RAISE EXCEPTION
      'instagram_account_credentials is missing; apply 20261026120000 first';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.instagram_account_credentials AS cr
      LEFT JOIN public.instagram_account_capabilities AS cap
        ON cap.social_account_id = cr.social_account_id
     WHERE cap.social_account_id IS NULL
        OR cap.login_kind IS DISTINCT FROM 'page_linked'
        OR cr.credential_kind IS DISTINCT FROM 'facebook_user'
        OR cr.platform IS DISTINCT FROM 'instagram'
  ) THEN
    RAISE EXCEPTION
      'facebook user credential migration refused: instagram_account_credentials contains a row that is not a page-linked facebook_user secret. The row was left in place.'
      USING ERRCODE = 'FUC06';
  END IF;

  FOR r IN
    SELECT cr.social_account_id, cr.user_id, cr.token, cr.token_expires_at,
           cr.created_at, cr.updated_at
      FROM public.instagram_account_credentials AS cr
     ORDER BY cr.social_account_id
  LOOP
    INSERT INTO public.facebook_user_credentials (
      user_id, token, revision, lifecycle, token_expires_at,
      provider_user_id, provenance_source, provenance_captured_at,
      created_at, updated_at
    ) VALUES (
      r.user_id, r.token, 1, 'active', r.token_expires_at,
      NULL, 'migrated_instagram_account_credential', NULL,
      r.created_at, r.updated_at
    )
    RETURNING id INTO v_credential_id;

    INSERT INTO public.facebook_user_credential_connection_fences (
      social_account_id, user_id, platform, connection_version,
      created_at, updated_at
    ) VALUES (
      r.social_account_id, r.user_id, 'instagram', 1,
      r.created_at, r.updated_at
    );

    INSERT INTO public.facebook_user_credential_bindings (
      social_account_id, user_id, platform, credential_id,
      verified_facebook_user_id, verified_facebook_page_id,
      verified_instagram_user_id, evidence_source, connection_version,
      created_at, updated_at
    ) VALUES (
      r.social_account_id, r.user_id, 'instagram', v_credential_id,
      NULL, NULL, NULL, 'migrated_instagram_account_credential', 1,
      r.created_at, r.updated_at
    );
  END LOOP;

  SELECT count(*) INTO v_old_count FROM public.instagram_account_credentials;
  SELECT count(*) INTO v_new_count
    FROM public.facebook_user_credential_bindings
   WHERE evidence_source = 'migrated_instagram_account_credential';

  IF v_old_count IS DISTINCT FROM v_new_count THEN
    RAISE EXCEPTION 'facebook user credential migration count mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.instagram_account_credentials AS cr
      JOIN public.facebook_user_credential_bindings AS b
        ON b.social_account_id = cr.social_account_id
      JOIN public.facebook_user_credentials AS c
        ON c.id = b.credential_id
       AND c.user_id = b.user_id
     WHERE c.token IS DISTINCT FROM cr.token
        OR c.user_id IS DISTINCT FROM cr.user_id
        OR c.token_expires_at IS DISTINCT FROM cr.token_expires_at
        OR c.provenance_source IS DISTINCT FROM 'migrated_instagram_account_credential'
  ) THEN
    RAISE EXCEPTION 'facebook user credential migration did not preserve the secret';
  END IF;
END;
$do$;

ALTER TABLE public.instagram_account_credentials
  ADD COLUMN credential_id UUID;

UPDATE public.instagram_account_credentials AS cr
   SET credential_id = b.credential_id
  FROM public.facebook_user_credential_bindings AS b
 WHERE b.social_account_id = cr.social_account_id
   AND b.user_id = cr.user_id;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.instagram_account_credentials
     WHERE credential_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'facebook user credential migration left a linkage without a credential';
  END IF;
END;
$do$;

-- Compatibility RPCs below must stop referencing the secret columns
-- before those columns are dropped.
-- The function bodies are created after the column drop further down
-- only if they do not need the column. read/replace are replaced first
-- while the column still exists, then the column is dropped. Plpgsql
-- is validated at call time, so the replacements can be created after
-- the drop as well. Drop dependencies by replacing the two functions
-- that name the token column before the drop.

-- Placeholder replacements are the real bodies; they do not read the
-- old token column. Created before DROP so the dependency is gone.

-- ---------------------------------------------------------------------------
-- 4. Secret-free projection and the Task 3a RPC bodies.
-- ---------------------------------------------------------------------------

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
  v_granted_scopes     TEXT[] := NULL;
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

  -- Authority is the binding, not the secret-free linkage table.
  SELECT EXISTS (
           SELECT 1
             FROM public.facebook_user_credential_bindings AS b
            WHERE b.social_account_id = p_social_account_id
              AND b.platform = 'instagram'
         )
    INTO v_has_credential;

  RETURN jsonb_build_object(
    'social_account_id', p_social_account_id,
    'platform', 'instagram',
    'capability_present', COALESCE(v_present, false),
    'login_kind', v_login_kind,
    'permission_read_state', COALESCE(v_read_state, 'unknown'),
    'scopes_authoritative', (COALESCE(v_read_state, 'unknown') = 'ok'),
    'granted_scopes', COALESCE(v_granted_scopes, ARRAY[]::TEXT[]),
    'scopes_read_at', v_scopes_read_at,
    'last_read_failed_at', v_read_failed_at,
    'last_read_error_code', v_read_error_code,
    'credential_generation', COALESCE(v_generation, 0),
    'credential_updated_at', v_credential_updated,
    'generation_reason', v_generation_reason,
    'reconnected_at', v_reconnected_at,
    'has_protected_credential', COALESCE(v_has_credential, false),
    'updated_at', v_updated_at
  );
END;
$function$;

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
  v_owned BOOLEAN;
  v_kind TEXT := NULL;
  v_token TEXT := NULL;
  v_expires_at TIMESTAMPTZ := NULL;
  v_generation BIGINT := NULL;
  v_credential_id UUID := NULL;
  v_connection BIGINT := NULL;
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
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;

  SELECT 'facebook_user', cred.token, cred.token_expires_at, cred.id, b.connection_version
    INTO v_kind, v_token, v_expires_at, v_credential_id, v_connection
    FROM public.facebook_user_credential_bindings AS b
    JOIN public.facebook_user_credentials AS cred
      ON cred.id = b.credential_id
     AND cred.user_id = b.user_id
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id
     AND b.platform = 'instagram';

  IF v_kind IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'social_account_id', p_social_account_id,
      'credential_id', NULL,
      'credential_kind', NULL,
      'token', NULL,
      'token_expires_at', NULL,
      'credential_generation', COALESCE(v_generation, 0),
      'connection_version', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'social_account_id', p_social_account_id,
    'credential_id', v_credential_id,
    'credential_kind', v_kind,
    'token', v_token,
    'token_expires_at', v_expires_at,
    'credential_generation', COALESCE(v_generation, 0),
    'connection_version', v_connection
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Internal parsers and account-field writer. Not a Task 2a entry point.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.facebook_user_credential_parse_uint(
  p_value JSONB,
  p_field TEXT,
  p_allow_zero BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_text TEXT;
  v_num BIGINT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'number' THEN
    RAISE EXCEPTION '% must be a non-negative integer', p_field
      USING ERRCODE = 'FUC04';
  END IF;
  v_text := p_value #>> '{}';
  IF v_text !~ '^[0-9]+$' THEN
    RAISE EXCEPTION '% must be a non-negative integer', p_field
      USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_num := v_text::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '% must be a non-negative integer', p_field
      USING ERRCODE = 'FUC04';
  END;
  IF NOT p_allow_zero AND v_num < 1 THEN
    RAISE EXCEPTION '% must be a positive integer', p_field
      USING ERRCODE = 'FUC04';
  END IF;
  RETURN v_num;
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_owned_platform(
  p_user_id UUID,
  p_social_account_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_platform TEXT;
BEGIN
  SELECT sa.platform INTO v_platform
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id
     AND sa.platform IN ('facebook', 'instagram');

  IF v_platform IS NULL THEN
    RAISE EXCEPTION
      'account % is not an eligible Facebook or Instagram account owned by the given user',
      p_social_account_id;
  END IF;
  RETURN v_platform;
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_apply_account_fields(
  p_user_id UUID,
  p_social_account_id UUID,
  p_fields JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_key TEXT;
  v_set_access BOOLEAN := false;
  v_access TEXT := NULL;
  v_set_expiry BOOLEAN := false;
  v_expiry TIMESTAMPTZ := NULL;
  v_set_reauth BOOLEAN := false;
  v_reauth BOOLEAN := NULL;
  v_set_failures BOOLEAN := false;
  v_failures INTEGER := NULL;
  v_set_error BOOLEAN := false;
  v_error TEXT := NULL;
  v_set_attempt BOOLEAN := false;
  v_attempt TIMESTAMPTZ := NULL;
BEGIN
  IF p_fields IS NULL OR p_fields = '{}'::JSONB THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'account fields must be a JSON object'
      USING ERRCODE = 'FUC04';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF v_key NOT IN (
      'access_token', 'token_expires_at', 'needs_reauth', 'failure_count',
      'last_refresh_error', 'last_refresh_attempt_at'
    ) THEN
      RAISE EXCEPTION 'unsupported account field: %', v_key
        USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;

  IF p_fields ? 'access_token' THEN
    IF jsonb_typeof(p_fields -> 'access_token') <> 'string'
       OR btrim(p_fields ->> 'access_token') = ''
       OR char_length(p_fields ->> 'access_token') > 4096 THEN
      RAISE EXCEPTION 'access_token must be a non-empty string of at most 4096 characters'
        USING ERRCODE = 'FUC04';
    END IF;
    v_set_access := true;
    v_access := p_fields ->> 'access_token';
  END IF;

  IF p_fields ? 'token_expires_at' THEN
    v_set_expiry := true;
    IF jsonb_typeof(p_fields -> 'token_expires_at') = 'null' THEN
      v_expiry := NULL;
    ELSIF jsonb_typeof(p_fields -> 'token_expires_at') <> 'string' THEN
      RAISE EXCEPTION 'token_expires_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    ELSE
      v_expiry := public.facebook_user_credential_parse_zoned_timestamp(
        p_fields ->> 'token_expires_at', 'token_expires_at');
    END IF;
  END IF;

  IF p_fields ? 'needs_reauth' THEN
    IF jsonb_typeof(p_fields -> 'needs_reauth') <> 'boolean' THEN
      RAISE EXCEPTION 'needs_reauth must be a boolean'
        USING ERRCODE = 'FUC04';
    END IF;
    v_set_reauth := true;
    v_reauth := (p_fields ->> 'needs_reauth')::BOOLEAN;
  END IF;

  IF p_fields ? 'failure_count' THEN
    IF jsonb_typeof(p_fields -> 'failure_count') = 'null' THEN
      RAISE EXCEPTION 'failure_count must be a non-negative integer'
        USING ERRCODE = 'FUC04';
    END IF;
    v_set_failures := true;
    v_failures := public.facebook_user_credential_parse_uint(
      p_fields -> 'failure_count', 'failure_count', true)::INTEGER;
  END IF;

  IF p_fields ? 'last_refresh_error' THEN
    v_set_error := true;
    IF jsonb_typeof(p_fields -> 'last_refresh_error') = 'null' THEN
      v_error := NULL;
    ELSIF jsonb_typeof(p_fields -> 'last_refresh_error') <> 'string'
          OR btrim(p_fields ->> 'last_refresh_error') = ''
          OR char_length(p_fields ->> 'last_refresh_error') > 500 THEN
      RAISE EXCEPTION 'last_refresh_error must be a non-empty string of at most 500 characters or null'
        USING ERRCODE = 'FUC04';
    ELSE
      v_error := p_fields ->> 'last_refresh_error';
    END IF;
  END IF;

  IF p_fields ? 'last_refresh_attempt_at' THEN
    v_set_attempt := true;
    IF jsonb_typeof(p_fields -> 'last_refresh_attempt_at') = 'null' THEN
      v_attempt := NULL;
    ELSIF jsonb_typeof(p_fields -> 'last_refresh_attempt_at') <> 'string' THEN
      RAISE EXCEPTION 'last_refresh_attempt_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    ELSE
      v_attempt := public.facebook_user_credential_parse_zoned_timestamp(
        p_fields ->> 'last_refresh_attempt_at', 'last_refresh_attempt_at');
    END IF;
  END IF;

  UPDATE public.social_accounts AS sa
     SET access_token = CASE WHEN v_set_access THEN v_access ELSE sa.access_token END,
         token_expires_at = CASE WHEN v_set_expiry THEN v_expiry ELSE sa.token_expires_at END,
         needs_reauth = CASE WHEN v_set_reauth THEN v_reauth ELSE sa.needs_reauth END,
         failure_count = CASE WHEN v_set_failures THEN v_failures ELSE sa.failure_count END,
         last_refresh_error = CASE WHEN v_set_error THEN v_error ELSE sa.last_refresh_error END,
         last_refresh_attempt_at = CASE WHEN v_set_attempt THEN v_attempt ELSE sa.last_refresh_attempt_at END,
         updated_at = now()
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'account % is not an eligible Facebook or Instagram account owned by the given user',
      p_social_account_id;
  END IF;
END;
$function$;

-- First bind inserts version 1. A later bind of the same account takes
-- the next high-water value. Never copies a caller-supplied version.
CREATE OR REPLACE FUNCTION public.facebook_user_credential_allocate_connection_version(
  p_social_account_id UUID,
  p_user_id UUID,
  p_platform TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_version BIGINT;
BEGIN
  INSERT INTO public.facebook_user_credential_connection_fences (
    social_account_id, user_id, platform, connection_version
  ) VALUES (
    p_social_account_id, p_user_id, p_platform, 1
  )
  ON CONFLICT (social_account_id) DO UPDATE
    SET connection_version =
          public.facebook_user_credential_connection_fences.connection_version + 1,
        platform = EXCLUDED.platform
  WHERE public.facebook_user_credential_connection_fences.user_id = EXCLUDED.user_id
    AND public.facebook_user_credential_connection_fences.platform = EXCLUDED.platform
  RETURNING connection_version INTO v_version;

  IF v_version IS NULL THEN
    RAISE EXCEPTION 'connection fence does not belong to the given account'
      USING ERRCODE = 'FUC03';
  END IF;
  RETURN v_version;
END;
$function$;

-- Compare-and-swap. A mismatch writes nothing in this statement, and the
-- caller has not been told to keep going with the live version.
CREATE OR REPLACE FUNCTION public.facebook_user_credential_commit_connection_version(
  p_user_id UUID,
  p_social_account_id UUID,
  p_expected BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_next BIGINT;
BEGIN
  UPDATE public.facebook_user_credential_bindings AS b
     SET connection_version = b.connection_version + 1
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id
     AND b.connection_version = p_expected
   RETURNING b.connection_version INTO v_next;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale connection version' USING ERRCODE = 'FUC01';
  END IF;

  UPDATE public.facebook_user_credential_connection_fences AS f
     SET connection_version = f.connection_version + 1
   WHERE f.social_account_id = p_social_account_id
     AND f.user_id = p_user_id
     AND f.connection_version = p_expected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale connection version' USING ERRCODE = 'FUC01';
  END IF;
  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_status(
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_revision BIGINT;
  v_lifecycle TEXT;
  v_expires TIMESTAMPTZ;
  v_provider TEXT;
  v_source TEXT;
  v_captured TIMESTAMPTZ;
  v_bindings JSONB;
BEGIN
  SELECT c.revision, c.lifecycle, c.token_expires_at, c.provider_user_id,
         c.provenance_source, c.provenance_captured_at
    INTO v_revision, v_lifecycle, v_expires, v_provider, v_source, v_captured
    FROM public.facebook_user_credentials AS c
   WHERE c.id = p_credential_id
     AND c.user_id = p_user_id;

  IF v_revision IS NULL THEN
    RAISE EXCEPTION 'facebook user credential is not owned by the given user';
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'social_account_id', b.social_account_id,
             'platform', b.platform,
             'capability_generation', cap.credential_generation,
             'connection_version', b.connection_version,
             'evidence_source', b.evidence_source,
             'verified_facebook_user_id', b.verified_facebook_user_id,
             'verified_facebook_page_id', b.verified_facebook_page_id,
             'verified_instagram_user_id', b.verified_instagram_user_id
           )
           ORDER BY b.social_account_id
         ), '[]'::JSONB)
    INTO v_bindings
    FROM public.facebook_user_credential_bindings AS b
    LEFT JOIN public.instagram_account_capabilities AS cap
      ON cap.social_account_id = b.social_account_id
     AND cap.user_id = b.user_id
   WHERE b.credential_id = p_credential_id
     AND b.user_id = p_user_id;

  RETURN jsonb_build_object(
    'found', true,
    'deleted', false,
    'credential_id', p_credential_id,
    'revision', v_revision,
    'lifecycle', v_lifecycle,
    'token_expires_at', v_expires,
    'provider_user_id', v_provider,
    'provenance_source', v_source,
    'provenance_captured_at', v_captured,
    'binding_count', jsonb_array_length(v_bindings),
    'bindings', v_bindings
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_bound_accounts(
  p_credential_id UUID
)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(array_agg(b.social_account_id ORDER BY b.social_account_id), ARRAY[]::UUID[])
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.credential_id = p_credential_id;
$function$;

-- Compare a caller-captured account list to the bindings held under the
-- lock. Does not read a live Instagram generation and continue. Does not
-- write. Missing Instagram generations and a set that gained or lost an
-- account are refusals.
CREATE OR REPLACE FUNCTION public.facebook_user_credential_require_bound_set(
  p_user_id UUID,
  p_credential_id UUID,
  p_accounts JSONB
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_item JSONB;
  v_account UUID;
  v_platform TEXT;
  v_seen UUID[] := ARRAY[]::UUID[];
  v_sorted UUID[];
  v_live UUID[];
  v_expected BIGINT;
  v_live_generation BIGINT;
BEGIN
  IF p_accounts IS NULL OR jsonb_typeof(p_accounts) <> 'array' THEN
    RAISE EXCEPTION 'complete dependent account set is required'
      USING ERRCODE = 'FUC04';
  END IF;

  v_live := public.facebook_user_credential_bound_accounts(p_credential_id);

  FOR v_item IN
    SELECT e.value FROM jsonb_array_elements(p_accounts) AS e(value)
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR jsonb_typeof(v_item -> 'social_account_id') <> 'string' THEN
      RAISE EXCEPTION 'accounts entries must name a social_account_id'
        USING ERRCODE = 'FUC04';
    END IF;
    BEGIN
      v_account := (v_item ->> 'social_account_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'social_account_id must be a uuid string'
        USING ERRCODE = 'FUC04';
    END;
    IF v_account = ANY (v_seen) THEN
      RAISE EXCEPTION 'duplicate account in accounts' USING ERRCODE = 'FUC04';
    END IF;
    v_seen := v_seen || v_account;
    IF NOT v_account = ANY (v_live) THEN
      RAISE EXCEPTION 'credential binding set does not match the captured dependent accounts'
        USING ERRCODE = 'FUC01';
    END IF;
    v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);
    IF v_platform = 'instagram' THEN
      IF NOT (v_item ? 'expected_capability_generation') THEN
        RAISE EXCEPTION 'expected_capability_generation is required'
          USING ERRCODE = 'FUC04';
      END IF;
      v_expected := public.facebook_user_credential_parse_uint(
        v_item -> 'expected_capability_generation',
        'expected_capability_generation', true);
      SELECT c.credential_generation INTO v_live_generation
        FROM public.instagram_account_capabilities AS c
       WHERE c.social_account_id = v_account
         AND c.user_id = p_user_id;
      IF v_live_generation IS NULL THEN
        RAISE EXCEPTION 'instagram binding has no capability record'
          USING ERRCODE = 'FUC02';
      END IF;
      IF v_live_generation IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
      END IF;
    ELSIF v_item ? 'expected_capability_generation' THEN
      RAISE EXCEPTION 'facebook accounts have no capability generation'
        USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(s.account_id ORDER BY s.account_id), ARRAY[]::UUID[])
    INTO v_sorted
    FROM unnest(v_seen) AS s(account_id);
  IF v_sorted IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION 'credential binding set does not match the captured dependent accounts'
      USING ERRCODE = 'FUC01';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_sync_instagram_linkage(
  p_social_account_id UUID,
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.instagram_account_credentials (
    social_account_id, user_id, platform, credential_id
  ) VALUES (
    p_social_account_id, p_user_id, 'instagram', p_credential_id
  )
  ON CONFLICT (social_account_id) DO UPDATE
    SET credential_id = EXCLUDED.credential_id,
        updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.facebook_user_credential_guard_instagram_linkage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = NEW.social_account_id
       AND b.user_id = NEW.user_id
       AND b.platform = 'instagram'
       AND b.credential_id = NEW.credential_id
  ) THEN
    RAISE EXCEPTION 'instagram credential linkage must match the facebook user binding'
      USING ERRCODE = 'FUC03';
  END IF;
  RETURN NEW;
END;
$function$;

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

  -- Parent row before the capability advisory lock. The initial INSERT
  -- takes FOR KEY SHARE on this account through the owner foreign key.
  -- lock_scope takes FOR UPDATE and only then the same advisory lock.
  -- Advisory-then-parent deadlocks with that order on capability creation.
  -- Updates keep the same order so this function does not invert it.
  PERFORM 1
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id
     AND sa.platform = 'instagram'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account % is not owned by the given user',
      p_social_account_id;
  END IF;

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
    IF jsonb_typeof(p_payload -> 'scopes_read_at') <> 'string' THEN
      RAISE EXCEPTION 'scopes_read_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_scopes_read_at := public.facebook_user_credential_parse_zoned_timestamp(
      p_payload ->> 'scopes_read_at', 'scopes_read_at');
  ELSIF v_state_provided AND v_incoming_state = 'failed' THEN
    IF NOT (p_payload ? 'read_failed_at') THEN
      RAISE EXCEPTION 'read_failed_at is required for a failed permission read';
    END IF;
    IF jsonb_typeof(p_payload -> 'read_failed_at') <> 'string' THEN
      RAISE EXCEPTION 'read_failed_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_failed_at := public.facebook_user_credential_parse_zoned_timestamp(
      p_payload ->> 'read_failed_at', 'read_failed_at');
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

  IF v_state_provided
     AND v_current_state IN ('ok', 'failed')
     AND v_incoming_state = 'unknown' THEN
    RAISE EXCEPTION 'permission evidence cannot return to unknown until reconnect'
      USING ERRCODE = 'ICG05';
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

COMMENT ON FUNCTION public.write_instagram_account_capability(UUID, UUID, JSONB) IS
  'Same payload as Task 3a. Evidence timestamps must be unambiguous zoned ISO-8601 '
  '(YYYY-MM-DDTHH:MM:SS[.fraction]Z or a numeric offset, including +0000). '
  'ok or failed cannot return to unknown until record_instagram_account_reconnect (ICG05).';


-- Task 3a compatibility writers. Secret lives only in
-- facebook_user_credentials. replace and reconnect keep their signatures.
-- expected_credential_generation is required. Direct login is refused by
-- replace. A shared replace requires the captured bound set. The unfenced
-- 3-argument bump and account-revoke forms are dropped below.
-- ---------------------------------------------------------------------------

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
  v_key TEXT;
  v_owned BOOLEAN;
  v_capability BOOLEAN;
  v_generation BIGINT;
  v_expected BIGINT;
  v_generation_text TEXT;
  v_login_kind TEXT;
  v_credential_kind TEXT;
  v_token TEXT;
  v_expires_at TIMESTAMPTZ := NULL;
  v_credential_id UUID := NULL;
  v_discovered UUID := NULL;
  v_connection BIGINT := NULL;
  v_before UUID[];
  v_after UUID[];
  v_shared BOOLEAN := false;
  v_item JSONB;
  v_bumped BIGINT;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN (
      'credential_kind', 'token', 'token_expires_at',
      'expected_credential_generation', 'expected_bound_accounts'
    ) THEN
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

  IF NOT (p_payload ? 'credential_kind')
     OR jsonb_typeof(p_payload -> 'credential_kind') <> 'string'
     OR (p_payload ->> 'credential_kind') <> 'facebook_user' THEN
    RAISE EXCEPTION 'credential_kind must be facebook_user';
  END IF;
  v_credential_kind := p_payload ->> 'credential_kind';

  IF NOT (p_payload ? 'token') OR jsonb_typeof(p_payload -> 'token') <> 'string' THEN
    RAISE EXCEPTION 'token must be a string';
  END IF;
  v_token := p_payload ->> 'token';
  IF btrim(v_token) = '' THEN
    RAISE EXCEPTION 'token must not be empty';
  END IF;
  IF char_length(v_token) > 4096 THEN
    RAISE EXCEPTION 'token must be at most 4096 characters';
  END IF;

  -- Absent token_expires_at stores NULL, including on replacement. That
  -- matches the previous ON CONFLICT update and is not the new write RPC.
  IF p_payload ? 'token_expires_at' AND jsonb_typeof(p_payload -> 'token_expires_at') <> 'null' THEN
    IF jsonb_typeof(p_payload -> 'token_expires_at') <> 'string' THEN
      RAISE EXCEPTION 'token_expires_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_expires_at := public.facebook_user_credential_parse_zoned_timestamp(
      p_payload ->> 'token_expires_at', 'token_expires_at');
  END IF;

  IF NOT (p_payload ? 'expected_credential_generation') THEN
    RAISE EXCEPTION 'expected_credential_generation is required'
      USING ERRCODE = 'ICG03';
  END IF;
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
    v_expected := v_generation_text::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
      USING ERRCODE = 'ICG03';
  END;

  -- Discover the complete candidate set with no locks held. The single
  -- lock_scope below is the only account acquisition. A set that changed
  -- under that lock raises a typed retry. It is not locked in a second pass.
  SELECT b.credential_id INTO v_discovered
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_discovered IS NULL THEN
    v_before := ARRAY[p_social_account_id];
    PERFORM public.facebook_user_credential_lock_scope(v_before, ARRAY[]::UUID[]);
  ELSE
    SELECT COALESCE(array_agg(s.account_id ORDER BY s.account_id), ARRAY[]::UUID[])
      INTO v_before
      FROM (
        SELECT u.account_id
          FROM unnest(public.facebook_user_credential_bound_accounts(v_discovered)) AS u(account_id)
        UNION
        SELECT p_social_account_id
      ) AS s;
    PERFORM public.facebook_user_credential_lock_scope(v_before, ARRAY[v_discovered]);
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM public.instagram_account_capabilities AS c
            WHERE c.social_account_id = p_social_account_id
              AND c.user_id = p_user_id
         ) INTO v_capability;
  IF NOT COALESCE(v_capability, false) THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;

  SELECT c.login_kind, c.credential_generation
    INTO v_login_kind, v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;
  IF v_login_kind = 'direct' THEN
    RAISE EXCEPTION 'direct Instagram login cannot bind a Facebook user credential'
      USING ERRCODE = 'FUC02';
  END IF;
  IF v_login_kind IS DISTINCT FROM 'page_linked' THEN
    RAISE EXCEPTION 'page-linked capability evidence is required to bind an Instagram account'
      USING ERRCODE = 'FUC02';
  END IF;
  IF v_expected IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      v_expected, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  SELECT b.credential_id INTO v_credential_id
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_discovered IS NULL THEN
    IF v_credential_id IS NOT NULL THEN
      RAISE EXCEPTION 'credential bindings changed; retry'
        USING ERRCODE = 'FUC01';
    END IF;
    IF p_payload ? 'expected_bound_accounts' THEN
      RAISE EXCEPTION 'expected_bound_accounts applies only to an existing shared credential'
        USING ERRCODE = 'FUC04';
    END IF;

    INSERT INTO public.facebook_user_credentials (
      user_id, token, revision, lifecycle, token_expires_at,
      provider_user_id, provenance_source, provenance_captured_at
    ) VALUES (
      p_user_id, v_token, 1, 'active', v_expires_at,
      NULL, 'compatibility_task3a', NULL
    )
    RETURNING id INTO v_credential_id;

    -- The new credential id did not exist at discovery. Lock it after the
    -- account this transaction already holds. Do not add other accounts.
    PERFORM public.facebook_user_credential_lock_scope(
      ARRAY[p_social_account_id], ARRAY[v_credential_id]);
    IF EXISTS (
      SELECT 1
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.social_account_id = p_social_account_id
    ) THEN
      RAISE EXCEPTION 'credential bindings changed; retry'
        USING ERRCODE = 'FUC01';
    END IF;

    v_connection := public.facebook_user_credential_allocate_connection_version(
      p_social_account_id, p_user_id, 'instagram');
    INSERT INTO public.facebook_user_credential_bindings (
      social_account_id, user_id, platform, credential_id,
      verified_facebook_user_id, verified_facebook_page_id,
      verified_instagram_user_id, evidence_source, connection_version
    ) VALUES (
      p_social_account_id, p_user_id, 'instagram', v_credential_id,
      NULL, NULL, NULL, 'compatibility_task3a', v_connection
    );
  ELSE
    IF v_credential_id IS DISTINCT FROM v_discovered THEN
      RAISE EXCEPTION 'credential bindings changed; retry'
        USING ERRCODE = 'FUC01';
    END IF;
    v_after := public.facebook_user_credential_bound_accounts(v_credential_id);
    IF v_before IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION 'credential bindings changed; retry'
        USING ERRCODE = 'FUC01';
    END IF;

    v_shared := v_after IS DISTINCT FROM ARRAY[p_social_account_id]::UUID[];
    IF v_shared AND NOT (p_payload ? 'expected_bound_accounts') THEN
      RAISE EXCEPTION 'shared credential replacement requires the complete expected bound account set'
        USING ERRCODE = 'FUC04';
    END IF;
    IF p_payload ? 'expected_bound_accounts' THEN
      IF jsonb_typeof(p_payload -> 'expected_bound_accounts') <> 'array' THEN
        RAISE EXCEPTION 'expected_bound_accounts must be an array'
          USING ERRCODE = 'FUC04';
      END IF;
      FOR v_item IN
        SELECT e.value
          FROM jsonb_array_elements(p_payload -> 'expected_bound_accounts') AS e(value)
      LOOP
        IF jsonb_typeof(v_item) <> 'object' THEN
          RAISE EXCEPTION 'expected_bound_accounts entries must be objects'
            USING ERRCODE = 'FUC04';
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
          IF v_key NOT IN ('social_account_id', 'expected_capability_generation') THEN
            RAISE EXCEPTION 'unsupported bound-account field: %', v_key
              USING ERRCODE = 'FUC04';
          END IF;
        END LOOP;
      END LOOP;
      PERFORM public.facebook_user_credential_require_bound_set(
        p_user_id, v_credential_id, p_payload -> 'expected_bound_accounts');
    END IF;

    UPDATE public.facebook_user_credentials AS c
       SET token = v_token,
           token_expires_at = v_expires_at,
           revision = c.revision + 1,
           updated_at = now()
     WHERE c.id = v_credential_id
       AND c.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  PERFORM public.facebook_user_credential_sync_instagram_linkage(
    p_social_account_id, p_user_id, v_credential_id);

  IF v_shared THEN
    UPDATE public.instagram_account_capabilities AS c
       SET credential_generation = c.credential_generation + 1,
           credential_updated_at = now(),
           generation_reason = 'credential_replaced',
           updated_at = now()
      FROM public.facebook_user_credential_bindings AS b
      JOIN jsonb_array_elements(p_payload -> 'expected_bound_accounts') AS e(value)
        ON (e.value ->> 'social_account_id')::UUID = b.social_account_id
     WHERE b.credential_id = v_credential_id
       AND b.platform = 'instagram'
       AND c.social_account_id = b.social_account_id
       AND c.user_id = b.user_id
       AND c.credential_generation = (e.value ->> 'expected_capability_generation')::BIGINT;
    GET DIAGNOSTICS v_bumped = ROW_COUNT;
    IF v_bumped IS DISTINCT FROM (
      SELECT count(*)::BIGINT
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = v_credential_id
         AND b.platform = 'instagram'
    ) THEN
      RAISE EXCEPTION 'stale credential generation: expected % live %',
        v_expected, v_generation
        USING ERRCODE = 'ICG01';
    END IF;
  ELSE
    UPDATE public.instagram_account_capabilities AS c
       SET credential_generation = c.credential_generation + 1,
           credential_updated_at = now(),
           generation_reason = 'credential_replaced',
           updated_at = now()
     WHERE c.social_account_id = p_social_account_id
       AND c.user_id = p_user_id
       AND c.credential_generation = v_expected;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stale credential generation: expected % live %',
        v_expected, v_generation
        USING ERRCODE = 'ICG01';
    END IF;
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

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
  v_key TEXT;
  v_owned BOOLEAN;
  v_login_kind TEXT := NULL;
  v_reason TEXT := 'reconnect';
  v_credential_id UUID := NULL;
  v_generation BIGINT;
  v_expected BIGINT;
  v_generation_text TEXT;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('login_kind', 'reason', 'expected_credential_generation') THEN
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

  IF NOT (p_payload ? 'expected_credential_generation') THEN
    RAISE EXCEPTION 'expected_credential_generation is required'
      USING ERRCODE = 'ICG03';
  END IF;
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
    v_expected := v_generation_text::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
      USING ERRCODE = 'ICG03';
  END;

  PERFORM public.facebook_user_credential_lock_scope(
    ARRAY[p_social_account_id], ARRAY[]::UUID[]);

  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;
  IF v_generation IS NULL THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;
  IF v_expected IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      v_expected, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  SELECT b.credential_id INTO v_credential_id
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_credential_id IS NOT NULL THEN
    PERFORM public.facebook_user_credential_lock_scope(
      ARRAY[p_social_account_id], ARRAY[v_credential_id]);
    DELETE FROM public.facebook_user_credential_bindings
     WHERE social_account_id = p_social_account_id
       AND user_id = p_user_id;
  END IF;

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
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id
     AND c.credential_generation = v_expected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      v_expected, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

-- The 3-argument forms move generation without a captured version.
-- Drop them so a service caller cannot keep using the unfenced signature.
DROP FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT);
DROP FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT);

CREATE FUNCTION public.revoke_instagram_account_credential(
  p_social_account_id UUID,
  p_user_id UUID,
  p_reason TEXT,
  p_expected_generation BIGINT
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
  v_credential_id UUID := NULL;
  v_generation BIGINT;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 0 THEN
    RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
      USING ERRCODE = 'ICG03';
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

  PERFORM public.facebook_user_credential_lock_scope(
    ARRAY[p_social_account_id], ARRAY[]::UUID[]);

  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;
  IF v_generation IS NULL THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;
  IF p_expected_generation IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      p_expected_generation, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  SELECT b.credential_id INTO v_credential_id
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_credential_id IS NOT NULL THEN
    PERFORM public.facebook_user_credential_lock_scope(
      ARRAY[p_social_account_id], ARRAY[v_credential_id]);
    -- Account-scoped. A shared secret used by another account stays.
    -- Grant-wide revocation is revoke_facebook_user_credential.
    DELETE FROM public.facebook_user_credential_bindings
     WHERE social_account_id = p_social_account_id
       AND user_id = p_user_id;
  END IF;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id
     AND c.credential_generation = p_expected_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      p_expected_generation, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

CREATE FUNCTION public.bump_instagram_credential_generation(
  p_social_account_id UUID,
  p_user_id UUID,
  p_reason TEXT,
  p_expected_generation BIGINT
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
  v_generation BIGINT;
BEGIN
  IF p_social_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_social_account_id and p_user_id are required';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 0 THEN
    RAISE EXCEPTION 'expected_credential_generation must be a non-negative integer'
      USING ERRCODE = 'ICG03';
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

  PERFORM public.facebook_user_credential_lock_scope(
    ARRAY[p_social_account_id], ARRAY[]::UUID[]);

  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;
  IF v_generation IS NULL THEN
    RAISE EXCEPTION
      'no capability record for account %; write the capability first',
      p_social_account_id;
  END IF;
  IF p_expected_generation IS DISTINCT FROM v_generation THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      p_expected_generation, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id
     AND c.credential_generation = p_expected_generation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale credential generation: expected % live %',
      p_expected_generation, v_generation
      USING ERRCODE = 'ICG01';
  END IF;

  RETURN public.instagram_account_capability_projection(p_social_account_id);
END;
$function$;

COMMENT ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT, BIGINT) IS
  'Generation-only compare-and-swap. p_expected_generation is the version '
  'captured before the call. A missing or stale version writes nothing. Does '
  'not update social_accounts or the Facebook User secret. Not the atomic '
  'token writer. Connect, refresh, and revoke must call '
  'bind_facebook_user_credential, write_facebook_user_credential, '
  'unbind_facebook_user_credential, or revoke_facebook_user_credential so the '
  'account token/expiry/health fields and the credential fence commit in one '
  'function.';

COMMENT ON FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT, BIGINT) IS
  'Remove one Instagram account binding and advance that account generation '
  'when p_expected_generation still matches. Does not revoke a shared grant '
  'and does not change sibling accounts. A stale generation writes nothing.';

REVOKE ALL ON FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_instagram_account_credential(UUID, UUID, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_instagram_credential_generation(UUID, UUID, TEXT, BIGINT) TO service_role;

-- ---------------------------------------------------------------------------
-- Drop the old secret columns now that no function body reads them.
-- ---------------------------------------------------------------------------

ALTER TABLE public.instagram_account_credentials
  DROP COLUMN token,
  DROP COLUMN token_expires_at,
  DROP COLUMN credential_kind;

ALTER TABLE public.instagram_account_credentials
  ALTER COLUMN credential_id SET NOT NULL;

ALTER TABLE public.instagram_account_credentials
  ADD CONSTRAINT instagram_account_credentials_credential_fkey
  FOREIGN KEY (credential_id, user_id)
  REFERENCES public.facebook_user_credentials (id, user_id)
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

DROP TRIGGER IF EXISTS facebook_user_credential_guard_instagram_linkage
  ON public.instagram_account_credentials;
CREATE TRIGGER facebook_user_credential_guard_instagram_linkage
  BEFORE INSERT OR UPDATE ON public.instagram_account_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.facebook_user_credential_guard_instagram_linkage();

COMMENT ON TABLE public.instagram_account_credentials IS
  'Secret-free compatibility linkage from an Instagram account to '
  'facebook_user_credentials. Not an authority and not a second copy of '
  'the Facebook User token. Presence is facebook_user_credential_bindings.';

-- ---------------------------------------------------------------------------
-- Task 2a writers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bind_facebook_user_credential(
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
  v_creating BOOLEAN;
  v_account UUID;
  v_platform TEXT;
  v_credential_id UUID;
  v_expected_revision BIGINT;
  v_live_revision BIGINT;
  v_expected_generation BIGINT := NULL;
  v_live_generation BIGINT;
  v_login_kind TEXT;
  v_source TEXT;
  v_captured TIMESTAMPTZ := NULL;
  v_token TEXT := NULL;
  v_expires TIMESTAMPTZ := NULL;
  v_set_expiry BOOLEAN := false;
  v_identity JSONB;
  v_fb_user TEXT;
  v_page TEXT := NULL;
  v_ig TEXT := NULL;
  v_provider TEXT;
  v_account_fields JSONB := NULL;
  v_connection BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'FUC04';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'FUC04';
  END IF;

  v_creating := p_payload ? 'expected_absent';
  IF v_creating AND p_payload ? 'credential_id' THEN
    RAISE EXCEPTION 'create and attach are separate payloads'
      USING ERRCODE = 'FUC04';
  END IF;
  IF NOT v_creating AND NOT (p_payload ? 'credential_id') THEN
    RAISE EXCEPTION 'expected_absent or credential_id is required'
      USING ERRCODE = 'FUC04';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_creating AND v_key NOT IN (
      'expected_absent', 'token', 'token_expires_at', 'provenance_source',
      'provenance_captured_at', 'social_account_id',
      'expected_capability_generation', 'verified_provider_identity', 'account'
    ) THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'FUC04';
    END IF;
    IF NOT v_creating AND v_key NOT IN (
      'credential_id', 'expected_revision', 'social_account_id',
      'expected_capability_generation', 'provenance_source',
      'verified_provider_identity', 'account'
    ) THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;

  IF v_creating AND (p_payload -> 'expected_absent') IS DISTINCT FROM 'true'::JSONB THEN
    RAISE EXCEPTION 'expected_absent must be true when creating a credential'
      USING ERRCODE = 'FUC03';
  END IF;

  IF jsonb_typeof(p_payload -> 'social_account_id') <> 'string' THEN
    RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_account := (p_payload ->> 'social_account_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
  END;

  v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);

  IF NOT (p_payload ? 'provenance_source')
     OR jsonb_typeof(p_payload -> 'provenance_source') <> 'string'
     OR (p_payload ->> 'provenance_source') NOT IN ('oauth_exchange', 'token_refresh') THEN
    RAISE EXCEPTION 'provenance_source must be oauth_exchange or token_refresh'
      USING ERRCODE = 'FUC04';
  END IF;
  v_source := p_payload ->> 'provenance_source';

  IF jsonb_typeof(p_payload -> 'verified_provider_identity') <> 'object' THEN
    RAISE EXCEPTION 'verified provider identity evidence is required'
      USING ERRCODE = 'FUC02';
  END IF;
  v_identity := p_payload -> 'verified_provider_identity';
  FOR v_key IN SELECT jsonb_object_keys(v_identity) LOOP
    IF v_platform = 'facebook' AND v_key <> 'facebook_user_id' THEN
      RAISE EXCEPTION 'facebook evidence accepts only facebook_user_id'
        USING ERRCODE = 'FUC02';
    END IF;
    IF v_platform = 'instagram'
       AND v_key NOT IN ('facebook_user_id', 'facebook_page_id', 'instagram_user_id') THEN
      RAISE EXCEPTION 'unsupported verified identity field: %', v_key
        USING ERRCODE = 'FUC02';
    END IF;
  END LOOP;

  IF jsonb_typeof(v_identity -> 'facebook_user_id') <> 'string' THEN
    RAISE EXCEPTION 'verified provider identity evidence is required'
      USING ERRCODE = 'FUC02';
  END IF;
  v_fb_user := v_identity ->> 'facebook_user_id';
  IF char_length(v_fb_user) < 1 OR char_length(v_fb_user) > 128
     OR btrim(v_fb_user) <> v_fb_user THEN
    RAISE EXCEPTION 'facebook_user_id must be a provider id of at most 128 characters'
      USING ERRCODE = 'FUC04';
  END IF;

  IF v_platform = 'instagram' THEN
    IF jsonb_typeof(v_identity -> 'facebook_page_id') <> 'string'
       OR jsonb_typeof(v_identity -> 'instagram_user_id') <> 'string' THEN
      RAISE EXCEPTION 'verified provider identity evidence is required'
        USING ERRCODE = 'FUC02';
    END IF;
    v_page := v_identity ->> 'facebook_page_id';
    v_ig := v_identity ->> 'instagram_user_id';
    IF char_length(v_page) < 1 OR char_length(v_page) > 128 OR btrim(v_page) <> v_page
       OR char_length(v_ig) < 1 OR char_length(v_ig) > 128 OR btrim(v_ig) <> v_ig THEN
      RAISE EXCEPTION 'page and instagram ids must be provider ids of at most 128 characters'
        USING ERRCODE = 'FUC04';
    END IF;
  END IF;

  IF p_payload ? 'account' THEN
    v_account_fields := p_payload -> 'account';
  END IF;

  IF v_platform = 'instagram' THEN
    IF NOT (p_payload ? 'expected_capability_generation') THEN
      RAISE EXCEPTION 'expected_capability_generation is required'
        USING ERRCODE = 'FUC04';
    END IF;
    v_expected_generation := public.facebook_user_credential_parse_uint(
      p_payload -> 'expected_capability_generation',
      'expected_capability_generation', true);
  ELSIF p_payload ? 'expected_capability_generation' THEN
    RAISE EXCEPTION 'facebook accounts have no capability generation'
      USING ERRCODE = 'FUC04';
  END IF;

  PERFORM public.facebook_user_credential_lock_scope(ARRAY[v_account], ARRAY[]::UUID[]);

  IF EXISTS (
    SELECT 1 FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = v_account
  ) THEN
    IF v_creating THEN
      RAISE EXCEPTION 'expected absent but a binding exists'
        USING ERRCODE = 'FUC03';
    END IF;
    RAISE EXCEPTION 'account is already bound'
      USING ERRCODE = 'FUC03';
  END IF;

  IF v_platform = 'instagram' THEN
    SELECT c.login_kind, c.credential_generation
      INTO v_login_kind, v_live_generation
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_account
       AND c.user_id = p_user_id;
    IF v_login_kind = 'direct' THEN
      RAISE EXCEPTION 'direct Instagram login cannot bind a Facebook user credential'
        USING ERRCODE = 'FUC02';
    END IF;
    IF v_login_kind IS DISTINCT FROM 'page_linked' THEN
      RAISE EXCEPTION 'page-linked capability evidence is required to bind an Instagram account'
        USING ERRCODE = 'FUC02';
    END IF;
    IF v_live_generation IS DISTINCT FROM v_expected_generation THEN
      RAISE EXCEPTION 'stale capability generation'
        USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  IF v_creating THEN
    IF NOT (p_payload ? 'token') OR jsonb_typeof(p_payload -> 'token') <> 'string' THEN
      RAISE EXCEPTION 'token must be a string' USING ERRCODE = 'FUC04';
    END IF;
    v_token := p_payload ->> 'token';
    IF btrim(v_token) = '' OR char_length(v_token) > 4096 THEN
      RAISE EXCEPTION 'token must be a non-empty string of at most 4096 characters'
        USING ERRCODE = 'FUC04';
    END IF;
    IF NOT (p_payload ? 'provenance_captured_at')
       OR jsonb_typeof(p_payload -> 'provenance_captured_at') <> 'string' THEN
      RAISE EXCEPTION 'provenance_captured_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_captured := public.facebook_user_credential_parse_zoned_timestamp(
      p_payload ->> 'provenance_captured_at', 'provenance_captured_at');
    IF p_payload ? 'token_expires_at' THEN
      v_set_expiry := true;
      IF jsonb_typeof(p_payload -> 'token_expires_at') = 'null' THEN
        v_expires := NULL;
      ELSIF jsonb_typeof(p_payload -> 'token_expires_at') <> 'string' THEN
        RAISE EXCEPTION 'token_expires_at must be a finite ISO-8601 timestamp'
          USING ERRCODE = 'ICG04';
      ELSE
        v_expires := public.facebook_user_credential_parse_zoned_timestamp(
          p_payload ->> 'token_expires_at', 'token_expires_at');
      END IF;
    END IF;

    PERFORM public.facebook_user_credential_apply_account_fields(
      p_user_id, v_account, v_account_fields);

    INSERT INTO public.facebook_user_credentials (
      user_id, token, revision, lifecycle, token_expires_at,
      provider_user_id, provenance_source, provenance_captured_at
    ) VALUES (
      p_user_id, v_token, 1, 'active', CASE WHEN v_set_expiry THEN v_expires ELSE NULL END,
      v_fb_user, v_source, v_captured
    )
    RETURNING id INTO v_credential_id;

    PERFORM public.facebook_user_credential_lock_scope(
      ARRAY[v_account], ARRAY[v_credential_id]);
  ELSE
    IF jsonb_typeof(p_payload -> 'credential_id') <> 'string' THEN
      RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
    END IF;
    BEGIN
      v_credential_id := (p_payload ->> 'credential_id')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
    END;
    IF NOT (p_payload ? 'expected_revision') THEN
      RAISE EXCEPTION 'expected_revision is required' USING ERRCODE = 'FUC04';
    END IF;
    v_expected_revision := public.facebook_user_credential_parse_uint(
      p_payload -> 'expected_revision', 'expected_revision', false);

    PERFORM public.facebook_user_credential_lock_scope(
      ARRAY[v_account], ARRAY[v_credential_id]);

    SELECT c.revision, c.provider_user_id
      INTO v_live_revision, v_provider
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential_id
       AND c.user_id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'facebook user credential is not owned by the given user';
    END IF;
    IF v_live_revision IS DISTINCT FROM v_expected_revision THEN
      RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
    END IF;
    IF v_provider IS NULL OR v_provider IS DISTINCT FROM v_fb_user THEN
      RAISE EXCEPTION 'credential has no verified facebook user id matching this evidence'
        USING ERRCODE = 'FUC02';
    END IF;

    PERFORM public.facebook_user_credential_apply_account_fields(
      p_user_id, v_account, v_account_fields);
  END IF;

  v_connection := public.facebook_user_credential_allocate_connection_version(
    v_account, p_user_id, v_platform);
  INSERT INTO public.facebook_user_credential_bindings (
    social_account_id, user_id, platform, credential_id,
    verified_facebook_user_id, verified_facebook_page_id,
    verified_instagram_user_id, evidence_source, connection_version
  ) VALUES (
    v_account, p_user_id, v_platform, v_credential_id,
    v_fb_user, v_page, v_ig, v_source, v_connection
  );

  IF v_platform = 'instagram' THEN
    PERFORM public.facebook_user_credential_sync_instagram_linkage(
      v_account, p_user_id, v_credential_id);
    UPDATE public.instagram_account_capabilities AS c
       SET credential_generation = c.credential_generation + 1,
           credential_updated_at = now(),
           generation_reason = 'credential_bound',
           updated_at = now()
     WHERE c.social_account_id = v_account
       AND c.user_id = p_user_id
       AND c.credential_generation = v_expected_generation;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  RETURN public.facebook_user_credential_status(p_user_id, v_credential_id)
         || jsonb_build_object('operation', CASE WHEN v_creating THEN 'created' ELSE 'bound' END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.write_facebook_user_credential(
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
  v_credential_id UUID;
  v_expected_revision BIGINT;
  v_live_revision BIGINT;
  v_provider TEXT;
  v_before UUID[];
  v_after UUID[];
  v_has_token BOOLEAN;
  v_token TEXT := NULL;
  v_set_expiry BOOLEAN := false;
  v_expires TIMESTAMPTZ := NULL;
  v_source TEXT := NULL;
  v_captured TIMESTAMPTZ := NULL;
  v_item JSONB;
  v_account UUID;
  v_platform TEXT;
  v_seen UUID[] := ARRAY[]::UUID[];
  v_fields JSONB;
  v_expected_generation BIGINT;
  v_live_generation BIGINT;
  v_expected_connection BIGINT;
  v_live_connection BIGINT;
  v_operation TEXT;
  v_bumped BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'FUC04';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'FUC04';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN (
      'credential_id', 'expected_revision', 'token', 'token_expires_at',
      'provenance_source', 'provenance_captured_at', 'accounts'
    ) THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;

  IF jsonb_typeof(p_payload -> 'credential_id') <> 'string' THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_credential_id := (p_payload ->> 'credential_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END;
  IF NOT (p_payload ? 'expected_revision') THEN
    RAISE EXCEPTION 'expected_revision is required' USING ERRCODE = 'FUC04';
  END IF;
  v_expected_revision := public.facebook_user_credential_parse_uint(
    p_payload -> 'expected_revision', 'expected_revision', false);

  v_has_token := p_payload ? 'token';
  IF NOT v_has_token AND (
       NOT (p_payload ? 'accounts')
       OR jsonb_typeof(p_payload -> 'accounts') <> 'array'
       OR jsonb_array_length(p_payload -> 'accounts') = 0
     ) THEN
    RAISE EXCEPTION 'token or accounts is required' USING ERRCODE = 'FUC04';
  END IF;
  IF p_payload ? 'accounts' AND jsonb_typeof(p_payload -> 'accounts') <> 'array' THEN
    RAISE EXCEPTION 'accounts must be an array' USING ERRCODE = 'FUC04';
  END IF;

  IF v_has_token THEN
    IF jsonb_typeof(p_payload -> 'token') <> 'string'
       OR btrim(p_payload ->> 'token') = ''
       OR char_length(p_payload ->> 'token') > 4096 THEN
      RAISE EXCEPTION 'token must be a non-empty string of at most 4096 characters'
        USING ERRCODE = 'FUC04';
    END IF;
    v_token := p_payload ->> 'token';
    IF NOT (p_payload ? 'provenance_source')
       OR jsonb_typeof(p_payload -> 'provenance_source') <> 'string'
       OR (p_payload ->> 'provenance_source') NOT IN ('oauth_exchange', 'token_refresh') THEN
      RAISE EXCEPTION 'provenance_source must be oauth_exchange or token_refresh'
        USING ERRCODE = 'FUC04';
    END IF;
    v_source := p_payload ->> 'provenance_source';
    IF NOT (p_payload ? 'provenance_captured_at')
       OR jsonb_typeof(p_payload -> 'provenance_captured_at') <> 'string' THEN
      RAISE EXCEPTION 'provenance_captured_at must be a finite ISO-8601 timestamp'
        USING ERRCODE = 'ICG04';
    END IF;
    v_captured := public.facebook_user_credential_parse_zoned_timestamp(
      p_payload ->> 'provenance_captured_at', 'provenance_captured_at');
    IF p_payload ? 'token_expires_at' THEN
      v_set_expiry := true;
      IF jsonb_typeof(p_payload -> 'token_expires_at') = 'null' THEN
        v_expires := NULL;
      ELSIF jsonb_typeof(p_payload -> 'token_expires_at') <> 'string' THEN
        RAISE EXCEPTION 'token_expires_at must be a finite ISO-8601 timestamp'
          USING ERRCODE = 'ICG04';
      ELSE
        v_expires := public.facebook_user_credential_parse_zoned_timestamp(
          p_payload ->> 'token_expires_at', 'token_expires_at');
      END IF;
    END IF;
  ELSIF p_payload ? 'token_expires_at'
        OR p_payload ? 'provenance_source'
        OR p_payload ? 'provenance_captured_at' THEN
    RAISE EXCEPTION 'token expiry and provenance require token'
      USING ERRCODE = 'FUC04';
  END IF;

  SELECT c.revision, c.provider_user_id
    INTO v_live_revision, v_provider
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'facebook user credential is not owned by the given user';
  END IF;

  v_before := public.facebook_user_credential_bound_accounts(v_credential_id);
  PERFORM public.facebook_user_credential_lock_scope(v_before, ARRAY[v_credential_id]);
  v_after := public.facebook_user_credential_bound_accounts(v_credential_id);
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'credential bindings changed; retry' USING ERRCODE = 'FUC01';
  END IF;

  SELECT c.revision, c.provider_user_id
    INTO v_live_revision, v_provider
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF v_live_revision IS DISTINCT FROM v_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
  END IF;
  IF v_has_token AND v_source = 'oauth_exchange' AND v_provider IS NULL THEN
    RAISE EXCEPTION 'oauth_exchange provenance requires a verified facebook user id'
      USING ERRCODE = 'FUC02';
  END IF;

  IF v_has_token THEN
    IF NOT (p_payload ? 'accounts') THEN
      RAISE EXCEPTION 'complete dependent account set is required'
        USING ERRCODE = 'FUC04';
    END IF;
    PERFORM public.facebook_user_credential_require_bound_set(
      p_user_id, v_credential_id, p_payload -> 'accounts');
  END IF;

  IF p_payload ? 'accounts' THEN
    FOR v_item IN
      SELECT e.value FROM jsonb_array_elements(p_payload -> 'accounts') AS e(value)
    LOOP
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'accounts entries must be objects' USING ERRCODE = 'FUC04';
      END IF;
      FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
        IF v_key NOT IN (
          'social_account_id', 'expected_capability_generation',
          'expected_connection_version', 'access_token',
          'token_expires_at', 'needs_reauth', 'failure_count',
          'last_refresh_error', 'last_refresh_attempt_at'
        ) THEN
          RAISE EXCEPTION 'unsupported account field: %', v_key USING ERRCODE = 'FUC04';
        END IF;
      END LOOP;
      IF jsonb_typeof(v_item -> 'social_account_id') <> 'string' THEN
        RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
      END IF;
      BEGIN
        v_account := (v_item ->> 'social_account_id')::UUID;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
      END;
      IF v_account = ANY (v_seen) THEN
        RAISE EXCEPTION 'duplicate account in accounts' USING ERRCODE = 'FUC04';
      END IF;
      v_seen := v_seen || v_account;
      IF NOT v_account = ANY (v_after) THEN
        RAISE EXCEPTION 'account is not bound to this credential' USING ERRCODE = 'FUC04';
      END IF;
      v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);
      v_fields := v_item - 'social_account_id' - 'expected_capability_generation'
                         - 'expected_connection_version';
      IF v_platform = 'instagram' THEN
        IF v_item ? 'expected_connection_version' THEN
          RAISE EXCEPTION 'instagram account fences use capability generation'
            USING ERRCODE = 'FUC04';
        END IF;
        IF NOT (v_item ? 'expected_capability_generation') THEN
          RAISE EXCEPTION 'expected_capability_generation is required' USING ERRCODE = 'FUC04';
        END IF;
        v_expected_generation := public.facebook_user_credential_parse_uint(
          v_item -> 'expected_capability_generation', 'expected_capability_generation', true);
        SELECT c.credential_generation INTO v_live_generation
          FROM public.instagram_account_capabilities AS c
         WHERE c.social_account_id = v_account
           AND c.user_id = p_user_id;
        IF v_live_generation IS NULL THEN
          RAISE EXCEPTION 'instagram binding has no capability record' USING ERRCODE = 'FUC02';
        END IF;
        IF v_live_generation IS DISTINCT FROM v_expected_generation THEN
          RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
        END IF;
      ELSE
        IF v_item ? 'expected_capability_generation' THEN
          RAISE EXCEPTION 'facebook accounts have no capability generation' USING ERRCODE = 'FUC04';
        END IF;
        IF v_fields <> '{}'::JSONB AND NOT (v_item ? 'expected_connection_version') THEN
          RAISE EXCEPTION 'expected_connection_version is required' USING ERRCODE = 'FUC04';
        END IF;
        IF v_item ? 'expected_connection_version' THEN
          v_expected_connection := public.facebook_user_credential_parse_uint(
            v_item -> 'expected_connection_version', 'expected_connection_version', false);
          SELECT b.connection_version INTO v_live_connection
            FROM public.facebook_user_credential_bindings AS b
           WHERE b.social_account_id = v_account
             AND b.user_id = p_user_id
             AND b.credential_id = v_credential_id;
          IF v_live_connection IS DISTINCT FROM v_expected_connection THEN
            RAISE EXCEPTION 'stale connection version' USING ERRCODE = 'FUC01';
          END IF;
        END IF;
      END IF;
      IF NOT v_has_token AND v_fields = '{}'::JSONB THEN
        RAISE EXCEPTION 'account update requires a field' USING ERRCODE = 'FUC04';
      END IF;
    END LOOP;
  END IF;

  IF v_has_token AND EXISTS (
       SELECT 1
         FROM public.facebook_user_credential_bindings AS b
        WHERE b.credential_id = v_credential_id
          AND b.platform = 'instagram'
          AND NOT EXISTS (
            SELECT 1
              FROM public.instagram_account_capabilities AS c
             WHERE c.social_account_id = b.social_account_id
               AND c.user_id = b.user_id
          )
     ) THEN
    RAISE EXCEPTION 'instagram binding has no capability record' USING ERRCODE = 'FUC02';
  END IF;

  IF v_has_token THEN
    UPDATE public.facebook_user_credentials AS c
       SET token = v_token,
           token_expires_at = CASE
             WHEN v_set_expiry THEN v_expires
             ELSE c.token_expires_at
           END,
           revision = c.revision + 1,
           provenance_source = v_source,
           provenance_captured_at = v_captured,
           updated_at = now()
     WHERE c.id = v_credential_id
       AND c.user_id = p_user_id
       AND c.revision = v_expected_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
    END IF;
    v_operation := 'secret_replaced';
  ELSE
    v_operation := 'account_state_updated';
  END IF;

  IF p_payload ? 'accounts' THEN
    FOR v_item IN
      SELECT e.value FROM jsonb_array_elements(p_payload -> 'accounts') AS e(value)
    LOOP
      v_account := (v_item ->> 'social_account_id')::UUID;
      v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);
      v_fields := v_item - 'social_account_id' - 'expected_capability_generation'
                         - 'expected_connection_version';
      PERFORM public.facebook_user_credential_apply_account_fields(
        p_user_id, v_account, v_fields);
      IF v_platform = 'facebook' AND v_fields <> '{}'::JSONB THEN
        PERFORM public.facebook_user_credential_commit_connection_version(
          p_user_id,
          v_account,
          public.facebook_user_credential_parse_uint(
            v_item -> 'expected_connection_version',
            'expected_connection_version',
            false));
      END IF;
      IF NOT v_has_token AND v_platform = 'instagram' THEN
        v_expected_generation := public.facebook_user_credential_parse_uint(
          v_item -> 'expected_capability_generation', 'expected_capability_generation', true);
        UPDATE public.instagram_account_capabilities AS c
           SET credential_generation = c.credential_generation + 1,
               credential_updated_at = now(),
               generation_reason = 'account_token_updated',
               updated_at = now()
         WHERE c.social_account_id = v_account
           AND c.user_id = p_user_id
           AND c.credential_generation = v_expected_generation;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_has_token THEN
    UPDATE public.instagram_account_capabilities AS c
       SET credential_generation = c.credential_generation + 1,
           credential_updated_at = now(),
           generation_reason = 'credential_replaced',
           updated_at = now()
      FROM public.facebook_user_credential_bindings AS b
      JOIN jsonb_array_elements(p_payload -> 'accounts') AS e(value)
        ON (e.value ->> 'social_account_id')::UUID = b.social_account_id
     WHERE b.credential_id = v_credential_id
       AND b.user_id = p_user_id
       AND b.platform = 'instagram'
       AND c.social_account_id = b.social_account_id
       AND c.user_id = p_user_id
       AND c.credential_generation = (e.value ->> 'expected_capability_generation')::BIGINT;
    GET DIAGNOSTICS v_bumped = ROW_COUNT;
    IF v_bumped IS DISTINCT FROM (
      SELECT count(*)::BIGINT
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = v_credential_id
         AND b.user_id = p_user_id
         AND b.platform = 'instagram'
    ) THEN
      RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  RETURN public.facebook_user_credential_status(p_user_id, v_credential_id)
         || jsonb_build_object('operation', v_operation);
END;
$function$;

CREATE OR REPLACE FUNCTION public.unbind_facebook_user_credential(
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
  v_account UUID;
  v_platform TEXT;
  v_credential_id UUID;
  v_captured_credential UUID;
  v_live_credential UUID;
  v_expected_revision BIGINT;
  v_live_revision BIGINT;
  v_expected_connection BIGINT;
  v_live_connection BIGINT;
  v_expected_generation BIGINT;
  v_live_generation BIGINT;
  v_fields JSONB := NULL;
  v_generation BIGINT := NULL;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'FUC04';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'FUC04';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN (
      'social_account_id', 'credential_id', 'expected_revision',
      'expected_connection_version', 'expected_capability_generation', 'account'
    ) THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload -> 'social_account_id') <> 'string' THEN
    RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_account := (p_payload ->> 'social_account_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
  END;
  IF NOT (p_payload ? 'expected_revision') THEN
    RAISE EXCEPTION 'expected_revision is required' USING ERRCODE = 'FUC04';
  END IF;
  v_expected_revision := public.facebook_user_credential_parse_uint(
    p_payload -> 'expected_revision', 'expected_revision', false);
  IF jsonb_typeof(p_payload -> 'credential_id') <> 'string' THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_captured_credential := (p_payload ->> 'credential_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END;
  IF NOT (p_payload ? 'expected_connection_version') THEN
    RAISE EXCEPTION 'expected_connection_version is required' USING ERRCODE = 'FUC04';
  END IF;
  v_expected_connection := public.facebook_user_credential_parse_uint(
    p_payload -> 'expected_connection_version', 'expected_connection_version', false);
  IF p_payload ? 'account' THEN
    v_fields := p_payload -> 'account';
  END IF;

  v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);
  IF v_platform = 'instagram' THEN
    IF NOT (p_payload ? 'expected_capability_generation') THEN
      RAISE EXCEPTION 'expected_capability_generation is required' USING ERRCODE = 'FUC04';
    END IF;
    v_expected_generation := public.facebook_user_credential_parse_uint(
      p_payload -> 'expected_capability_generation', 'expected_capability_generation', true);
  ELSIF p_payload ? 'expected_capability_generation' THEN
    RAISE EXCEPTION 'facebook accounts have no capability generation' USING ERRCODE = 'FUC04';
  END IF;

  -- Captured credential id is locked with the account. The live binding is
  -- compared to that id. Discovering whichever credential is bound now and
  -- accepting it because its revision matches is the detach/rebind ABA.
  PERFORM public.facebook_user_credential_lock_scope(
    ARRAY[v_account], ARRAY[v_captured_credential]);

  SELECT b.credential_id, b.connection_version
    INTO v_live_credential, v_live_connection
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_account
     AND b.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no facebook user credential binding' USING ERRCODE = 'FUC03';
  END IF;
  IF v_live_credential IS DISTINCT FROM v_captured_credential THEN
    RAISE EXCEPTION 'stale credential identity' USING ERRCODE = 'FUC01';
  END IF;
  IF v_live_connection IS DISTINCT FROM v_expected_connection THEN
    RAISE EXCEPTION 'stale connection version' USING ERRCODE = 'FUC01';
  END IF;
  v_credential_id := v_live_credential;

  SELECT c.revision INTO v_live_revision
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF v_live_revision IS DISTINCT FROM v_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
  END IF;

  IF v_platform = 'instagram' THEN
    SELECT c.credential_generation INTO v_live_generation
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = v_account
       AND c.user_id = p_user_id;
    IF v_live_generation IS NULL THEN
      RAISE EXCEPTION 'instagram binding has no capability record' USING ERRCODE = 'FUC02';
    END IF;
    IF v_live_generation IS DISTINCT FROM v_expected_generation THEN
      RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  PERFORM public.facebook_user_credential_apply_account_fields(p_user_id, v_account, v_fields);

  IF v_platform = 'instagram' THEN
    UPDATE public.instagram_account_capabilities AS c
       SET credential_generation = c.credential_generation + 1,
           credential_updated_at = now(),
           generation_reason = 'binding_removed',
           updated_at = now()
     WHERE c.social_account_id = v_account
       AND c.user_id = p_user_id
       AND c.credential_generation = v_expected_generation
     RETURNING c.credential_generation INTO v_generation;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
    END IF;
  END IF;

  DELETE FROM public.facebook_user_credential_bindings
   WHERE social_account_id = v_account
     AND user_id = p_user_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential_id
  ) THEN
    RETURN jsonb_build_object(
      'found', false,
      'deleted', true,
      'operation', 'unbound',
      'credential_id', v_credential_id,
      'revision', NULL,
      'binding_count', 0,
      'former_bindings', jsonb_build_array(jsonb_build_object(
        'social_account_id', v_account,
        'platform', v_platform,
        'capability_generation', v_generation
      ))
    );
  END IF;

  RETURN public.facebook_user_credential_status(p_user_id, v_credential_id)
         || jsonb_build_object('operation', 'unbound');
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_facebook_user_credential(
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
  v_credential_id UUID;
  v_expected_revision BIGINT;
  v_live_revision BIGINT;
  v_reason TEXT := 'grant_revoked';
  v_before UUID[];
  v_after UUID[];
  v_item JSONB;
  v_account UUID;
  v_platform TEXT;
  v_seen UUID[] := ARRAY[]::UUID[];
  v_fields JSONB;
  v_expected_generation BIGINT;
  v_live_generation BIGINT;
  v_expected_connection BIGINT;
  v_live_connection BIGINT;
  v_former JSONB;
  v_bumped BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'FUC04';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'FUC04';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('credential_id', 'expected_revision', 'reason', 'accounts') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'FUC04';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload -> 'credential_id') <> 'string' THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END IF;
  BEGIN
    v_credential_id := (p_payload ->> 'credential_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'credential_id must be a uuid string' USING ERRCODE = 'FUC04';
  END;
  IF NOT (p_payload ? 'expected_revision') THEN
    RAISE EXCEPTION 'expected_revision is required' USING ERRCODE = 'FUC04';
  END IF;
  v_expected_revision := public.facebook_user_credential_parse_uint(
    p_payload -> 'expected_revision', 'expected_revision', false);
  IF p_payload ? 'reason' THEN
    IF jsonb_typeof(p_payload -> 'reason') <> 'string'
       OR btrim(p_payload ->> 'reason') = ''
       OR char_length(p_payload ->> 'reason') > 100 THEN
      RAISE EXCEPTION 'reason must be a non-empty string of at most 100 characters'
        USING ERRCODE = 'FUC04';
    END IF;
    v_reason := p_payload ->> 'reason';
  END IF;

  SELECT c.revision INTO v_live_revision
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'facebook user credential is not owned by the given user';
  END IF;

  v_before := public.facebook_user_credential_bound_accounts(v_credential_id);
  PERFORM public.facebook_user_credential_lock_scope(v_before, ARRAY[v_credential_id]);
  v_after := public.facebook_user_credential_bound_accounts(v_credential_id);
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'credential bindings changed; retry' USING ERRCODE = 'FUC01';
  END IF;
  SELECT c.revision INTO v_live_revision
    FROM public.facebook_user_credentials AS c
   WHERE c.id = v_credential_id
     AND c.user_id = p_user_id;
  IF v_live_revision IS DISTINCT FROM v_expected_revision THEN
    RAISE EXCEPTION 'stale credential revision' USING ERRCODE = 'FUC01';
  END IF;

  IF NOT (p_payload ? 'accounts') THEN
    RAISE EXCEPTION 'complete dependent account set is required'
      USING ERRCODE = 'FUC04';
  END IF;
  PERFORM public.facebook_user_credential_require_bound_set(
    p_user_id, v_credential_id, p_payload -> 'accounts');

  IF p_payload ? 'accounts' THEN
    IF jsonb_typeof(p_payload -> 'accounts') <> 'array' THEN
      RAISE EXCEPTION 'accounts must be an array' USING ERRCODE = 'FUC04';
    END IF;
    FOR v_item IN
      SELECT e.value FROM jsonb_array_elements(p_payload -> 'accounts') AS e(value)
    LOOP
      IF jsonb_typeof(v_item) <> 'object'
         OR jsonb_typeof(v_item -> 'social_account_id') <> 'string' THEN
        RAISE EXCEPTION 'accounts entries must name a social_account_id'
          USING ERRCODE = 'FUC04';
      END IF;
      BEGIN
        v_account := (v_item ->> 'social_account_id')::UUID;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'social_account_id must be a uuid string' USING ERRCODE = 'FUC04';
      END;
      IF v_account = ANY (v_seen) THEN
        RAISE EXCEPTION 'duplicate account in accounts' USING ERRCODE = 'FUC04';
      END IF;
      v_seen := v_seen || v_account;
      IF NOT v_account = ANY (v_after) THEN
        RAISE EXCEPTION 'account is not bound to this credential' USING ERRCODE = 'FUC04';
      END IF;
      v_platform := public.facebook_user_credential_owned_platform(p_user_id, v_account);
      FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
        IF v_key NOT IN (
          'social_account_id', 'expected_capability_generation',
          'expected_connection_version', 'access_token',
          'token_expires_at', 'needs_reauth', 'failure_count',
          'last_refresh_error', 'last_refresh_attempt_at'
        ) THEN
          RAISE EXCEPTION 'unsupported account field: %', v_key USING ERRCODE = 'FUC04';
        END IF;
      END LOOP;
      v_fields := v_item - 'social_account_id' - 'expected_capability_generation'
                         - 'expected_connection_version';
      IF v_platform = 'instagram' THEN
        IF v_item ? 'expected_connection_version' THEN
          RAISE EXCEPTION 'instagram account fences use capability generation'
            USING ERRCODE = 'FUC04';
        END IF;
        IF NOT (v_item ? 'expected_capability_generation') THEN
          RAISE EXCEPTION 'expected_capability_generation is required' USING ERRCODE = 'FUC04';
        END IF;
        v_expected_generation := public.facebook_user_credential_parse_uint(
          v_item -> 'expected_capability_generation', 'expected_capability_generation', true);
        SELECT c.credential_generation INTO v_live_generation
          FROM public.instagram_account_capabilities AS c
         WHERE c.social_account_id = v_account AND c.user_id = p_user_id;
        IF v_live_generation IS DISTINCT FROM v_expected_generation THEN
          RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
        END IF;
      ELSE
        IF v_item ? 'expected_capability_generation' THEN
          RAISE EXCEPTION 'facebook accounts have no capability generation' USING ERRCODE = 'FUC04';
        END IF;
        IF v_fields <> '{}'::JSONB THEN
          IF NOT (v_item ? 'expected_connection_version') THEN
            RAISE EXCEPTION 'expected_connection_version is required' USING ERRCODE = 'FUC04';
          END IF;
          v_expected_connection := public.facebook_user_credential_parse_uint(
            v_item -> 'expected_connection_version', 'expected_connection_version', false);
          SELECT b.connection_version INTO v_live_connection
            FROM public.facebook_user_credential_bindings AS b
           WHERE b.social_account_id = v_account
             AND b.user_id = p_user_id
             AND b.credential_id = v_credential_id;
          IF v_live_connection IS DISTINCT FROM v_expected_connection THEN
            RAISE EXCEPTION 'stale connection version' USING ERRCODE = 'FUC01';
          END IF;
        END IF;
      END IF;
      PERFORM public.facebook_user_credential_apply_account_fields(
        p_user_id, v_account, v_fields);
      IF v_platform = 'facebook' AND v_fields <> '{}'::JSONB THEN
        PERFORM public.facebook_user_credential_commit_connection_version(
          p_user_id, v_account, v_expected_connection);
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM public.facebook_user_credential_bindings AS b
        WHERE b.credential_id = v_credential_id
          AND b.platform = 'instagram'
          AND NOT EXISTS (
            SELECT 1 FROM public.instagram_account_capabilities AS c
             WHERE c.social_account_id = b.social_account_id
               AND c.user_id = b.user_id
          )
     ) THEN
    RAISE EXCEPTION 'instagram binding has no capability record' USING ERRCODE = 'FUC02';
  END IF;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = v_reason,
         updated_at = now()
    FROM public.facebook_user_credential_bindings AS b
    JOIN jsonb_array_elements(p_payload -> 'accounts') AS e(value)
      ON (e.value ->> 'social_account_id')::UUID = b.social_account_id
   WHERE b.credential_id = v_credential_id
     AND b.user_id = p_user_id
     AND b.platform = 'instagram'
     AND c.social_account_id = b.social_account_id
     AND c.user_id = p_user_id
     AND c.credential_generation = (e.value ->> 'expected_capability_generation')::BIGINT;
  GET DIAGNOSTICS v_bumped = ROW_COUNT;
  IF v_bumped IS DISTINCT FROM (
    SELECT count(*)::BIGINT
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.credential_id = v_credential_id
       AND b.user_id = p_user_id
       AND b.platform = 'instagram'
  ) THEN
    RAISE EXCEPTION 'stale capability generation' USING ERRCODE = 'FUC01';
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'social_account_id', b.social_account_id,
             'platform', b.platform,
             'capability_generation', cap.credential_generation
           )
           ORDER BY b.social_account_id
         ), '[]'::JSONB)
    INTO v_former
    FROM public.facebook_user_credential_bindings AS b
    LEFT JOIN public.instagram_account_capabilities AS cap
      ON cap.social_account_id = b.social_account_id
     AND cap.user_id = b.user_id
   WHERE b.credential_id = v_credential_id
     AND b.user_id = p_user_id;

  DELETE FROM public.facebook_user_credential_bindings
   WHERE credential_id = v_credential_id
     AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'found', false,
    'deleted', true,
    'operation', 'revoked',
    'credential_id', v_credential_id,
    'revision', NULL,
    'binding_count', 0,
    'former_bindings', v_former
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.describe_facebook_user_credential(
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF p_user_id IS NULL OR p_credential_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_credential_id are required' USING ERRCODE = 'FUC04';
  END IF;
  RETURN public.facebook_user_credential_status(p_user_id, p_credential_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_facebook_user_credential(
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_token TEXT;
  v_expires TIMESTAMPTZ;
  v_revision BIGINT;
  v_lifecycle TEXT;
BEGIN
  IF p_user_id IS NULL OR p_credential_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_credential_id are required' USING ERRCODE = 'FUC04';
  END IF;

  SELECT c.token, c.token_expires_at, c.revision, c.lifecycle
    INTO v_token, v_expires, v_revision, v_lifecycle
    FROM public.facebook_user_credentials AS c
   WHERE c.id = p_credential_id
     AND c.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'facebook user credential is not owned by the given user';
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'credential_id', p_credential_id,
    'credential_kind', 'facebook_user',
    'token', v_token,
    'token_expires_at', v_expires,
    'revision', v_revision,
    'lifecycle', v_lifecycle
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_facebook_user_account_credential(
  p_user_id UUID,
  p_social_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_platform TEXT;
  v_token TEXT := NULL;
  v_expires TIMESTAMPTZ := NULL;
  v_revision BIGINT := NULL;
  v_credential_id UUID := NULL;
  v_generation BIGINT := NULL;
  v_connection BIGINT := NULL;
BEGIN
  IF p_user_id IS NULL OR p_social_account_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id and p_social_account_id are required' USING ERRCODE = 'FUC04';
  END IF;

  v_platform := public.facebook_user_credential_owned_platform(p_user_id, p_social_account_id);

  IF v_platform = 'instagram' THEN
    SELECT c.credential_generation INTO v_generation
      FROM public.instagram_account_capabilities AS c
     WHERE c.social_account_id = p_social_account_id
       AND c.user_id = p_user_id;
  END IF;

  SELECT cred.token, cred.token_expires_at, cred.revision, cred.id, b.connection_version
    INTO v_token, v_expires, v_revision, v_credential_id, v_connection
    FROM public.facebook_user_credential_bindings AS b
    JOIN public.facebook_user_credentials AS cred
      ON cred.id = b.credential_id
     AND cred.user_id = b.user_id
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_credential_id IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'social_account_id', p_social_account_id,
      'platform', v_platform,
      'credential_id', NULL,
      'credential_kind', NULL,
      'token', NULL,
      'token_expires_at', NULL,
      'revision', NULL,
      'capability_generation', v_generation,
      'connection_version', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'social_account_id', p_social_account_id,
    'platform', v_platform,
    'credential_id', v_credential_id,
    'credential_kind', 'facebook_user',
    'token', v_token,
    'token_expires_at', v_expires,
    'revision', v_revision,
    'capability_generation', v_generation,
    'connection_version', v_connection
  );
END;
$function$;

COMMENT ON FUNCTION public.bind_facebook_user_credential(UUID, JSONB) IS
  'Create a Facebook User credential and bind one owned account, or attach '
  'an account to an existing credential. Instagram requires login_kind '
  'page_linked and verified_provider_identity. Does not read account_metadata. '
  'Optional account object updates access_token, token_expires_at, '
  'needs_reauth, failure_count, last_refresh_error, last_refresh_attempt_at '
  'in this same function. Returns no token.';

COMMENT ON FUNCTION public.write_facebook_user_credential(UUID, JSONB) IS
  'Replace the shared User token and/or update bound account token health '
  'fields. expected_revision was captured before the provider call. A token '
  'replacement requires accounts to name every currently bound account, and '
  'every Instagram entry to carry the capability generation captured before '
  'the provider call. A Facebook page-token or health field also requires '
  'expected_connection_version. That fence advances by one and does not '
  'advance the shared User-token revision, rotate the secret, or modify an '
  'unlisted account. Omitting an account or a captured version writes '
  'nothing. Omitted token_expires_at on a token replacement leaves the '
  'stored expiry. Returns no token.';

COMMENT ON FUNCTION public.unbind_facebook_user_credential(UUID, JSONB) IS
  'Remove one account binding. Requires the captured credential id and '
  'connection version, and for Instagram the captured capability generation. '
  'A different credential or a rebound same credential at a new connection '
  'version writes nothing. Bumps that Instagram capability only. Deletes the '
  'secret when no binding remains. Does not clear a stored permission read. '
  'Returns no token.';

COMMENT ON FUNCTION public.revoke_facebook_user_credential(UUID, JSONB) IS
  'Provider-response grant revocation. Requires expected_revision and accounts '
  'naming every currently bound account, with each Instagram generation '
  'captured before the provider call. A stale or partial set writes nothing. '
  'This is not a current-state administrative revoke and it is not a '
  'one-account disconnect. Deletes the secret and every binding. Does not '
  'clear stored permission reads. Returns no token.';

COMMENT ON FUNCTION public.describe_facebook_user_credential(UUID, UUID) IS
  'Owner-scoped credential status. No token and no account access_token.';

COMMENT ON FUNCTION public.read_facebook_user_credential(UUID, UUID) IS
  'Service-only User token read by credential id and owner. Unknown ids raise.';

COMMENT ON FUNCTION public.read_facebook_user_account_credential(UUID, UUID) IS
  'Service-only User token read by owned Facebook or Instagram account. '
  'A missing binding is found=false and token=null.';

REVOKE ALL ON FUNCTION public.facebook_user_credential_parse_zoned_timestamp(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_lock_scope(UUID[], UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credentials_require_binding() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_parse_uint(JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_owned_platform(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_apply_account_fields(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_allocate_connection_version(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_commit_connection_version(UUID, UUID, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_status(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_bound_accounts(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_require_bound_set(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.facebook_user_credential_sync_instagram_linkage(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.facebook_user_credential_parse_zoned_timestamp(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_lock_scope(UUID[], UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credentials_require_binding() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_parse_uint(JSONB, TEXT, BOOLEAN) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_owned_platform(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_apply_account_fields(UUID, UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_allocate_connection_version(UUID, UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_commit_connection_version(UUID, UUID, BIGINT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_status(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_bound_accounts(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_require_bound_set(UUID, UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_sync_instagram_linkage(UUID, UUID, UUID) TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.facebook_user_credential_binding_deleted() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.facebook_user_credential_guard_instagram_linkage() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_binding_deleted() TO CURRENT_USER, service_role;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_guard_instagram_linkage() TO CURRENT_USER, service_role;

REVOKE ALL ON FUNCTION public.bind_facebook_user_credential(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_facebook_user_credential(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unbind_facebook_user_credential(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_facebook_user_credential(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.describe_facebook_user_credential(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_facebook_user_credential(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_facebook_user_account_credential(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bind_facebook_user_credential(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_facebook_user_credential(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.unbind_facebook_user_credential(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_facebook_user_credential(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.describe_facebook_user_credential(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_facebook_user_credential(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_facebook_user_account_credential(UUID, UUID) TO service_role;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'instagram_account_credentials'
       AND column_name IN ('token', 'token_expires_at', 'credential_kind')
  ) THEN
    RAISE EXCEPTION 'instagram_account_credentials still has a secret column';
  END IF;
END;
$do$;

COMMIT;
