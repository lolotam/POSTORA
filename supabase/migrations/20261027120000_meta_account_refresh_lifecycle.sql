-- ===========================================================================
-- 20261027120000_meta_account_refresh_lifecycle.sql
--
-- Phase 2, prerequisite 3: the direct-Instagram and Meta refresh transactions.
--
-- WHAT THIS MIGRATION IS
-- ----------------------
-- The legacy refresh path is not safe to enable for a protected Meta account,
-- and the reason is structural, not a bug in one function:
--
--   * the token and the authority that describes it are read in two different
--     statements, so a concurrent writer can produce a mixed capture;
--   * the success path updates the token and then bumps the generation in a
--     later statement, so a job result can land between them and persist;
--   * the historical failure path prewrote needs_reauth and then called
--     partner_record_refresh_failure, which only knows the account id, so the
--     false -> true transition and its delivery event were lost. This
--     contract does not prewrite needs_reauth. The fence advances first and
--     the existing RPC remains the only writer of health, the alert marker
--     and the event.
--
-- This migration adds the missing seam. One service-only RPC captures the
-- token material AND the authority that describes it in a single transaction,
-- and the success and failure writers consume exactly that capture. There is
-- no second secret authority, no owner-wide inventory, and no path that
-- recaptures authority after the provider call.
--
-- THE CONTRACT
-- ------------
--   begin_meta_account_refresh(owner, payload)
--       Validates an explicit owned Meta identity, its capability / login
--       kind / binding consistency and its eligibility; locks the complete
--       required account and credential set; records the attempt marker; and
--       returns the token material together with the versioned capture that
--       describes it. The capture is stored, server-authored, and nonsecret.
--
--   write_direct_instagram_account(owner, payload)
--       The direct-login writer. Its token stays in social_accounts. It
--       refuses a Facebook binding, refuses the OAuth-only lifecycle fields,
--       and advances the account's capability generation so an older job
--       result can no longer persist.
--
--   write_meta_account_refresh_success(owner, payload)
--       The captured success for an Instagram page-linked operational token,
--       an owned Facebook Page operational token, or a shared Facebook User
--       grant. Page and direct tokens stay on social_accounts. The User
--       token stays on facebook_user_credentials. A shared rotation fences
--       the complete captured grant and resets failure evidence only on the
--       explicit targets. It does not clear needs_reauth.
--
--   record_meta_refresh_failure(owner, payload)
--       The captured failure. It advances the applicable fence, then calls the
--       existing partner_record_refresh_failure so the health columns, the
--       alert marker and the false -> true reauthorization event stay in one
--       transaction with the fence advance.
--
-- WHAT THIS MIGRATION IS NOT
-- --------------------------
-- It does not change any TypeScript route, it does not enable the protected
-- HTTP writers, it does not change the default legacy behaviour, and it does
-- not activate collection. The existing refresh-tokens handler still refuses
-- protected Meta accounts; this is the database half only. Open captures are
-- explicit operational debt to close before a recurring worker is activated.
-- This migration does not add a scheduler, a backfill or a second framework.
--
-- DESIGN NOTES
-- ------------
-- * The capture is a row, not a caller-supplied document. A caller-supplied
--   capture would make the captured membership, the captured subject and the
--   captured identities forgeable, and the whole point of the capture is that
--   they are not.
-- * The capture holds identifiers, presence flags and versions only. It never
--   holds a token, an expiry secret, a raw provider response or a raw error.
-- * A direct Instagram token stays in social_accounts.access_token. A page
--   operational token stays in social_accounts.access_token. A Facebook User
--   token stays in facebook_user_credentials.token. No token is copied into
--   account_metadata, into a pending stash or into the capture.
-- * The operation is explicit at every boundary. A direct token, a page
--   operational token and a shared Facebook User grant are three different
--   authorities and cannot be refreshed through one another's writer.
--   direct_token and page_token each capture exactly one account. There is
--   no batch protocol. facebook_user_token may name one or more explicit
--   targets that already share one grant; success fences the complete
--   captured membership and resets failure evidence only on those explicit
--   targets. An account-only failure validates that target and the credential
--   it used. It does not require every sibling generation to be unchanged
--   and it does not mutate the rest of the grant.
-- * Discovery names one credential, then reads that grant's membership once.
--   The lock account set is the explicit targets plus that one document.
--   Under those locks every explicit target must still be bound to that
--   same credential and still be in that document, and the live member ids
--   must still equal it. A difference is MAR05: retry the whole transaction.
--   The new ids are not added to the lock set and the new grant is not
--   adopted. Direct stays unbound. At success, an explicit target that is
--   not in the captured member set, or whose live binding is not the
--   captured credential, is MAR04. A stored capture is not rewritten to
--   match the newer grant.
-- * Lock order (the accepted Phase 1 discipline, with bounded refusal):
--       auth.users -> capture row -> social_accounts rows (sorted)
--         -> social_account guard advisory -> instagram capability advisory
--         -> facebook_user_credentials rows (sorted) -> credential advisory
--   Account, credential and capture row locks are NOWAIT. Advisory locks use
--   try_advisory_xact_lock. A busy row or lock is MAR05 and the caller
--   retries the whole transaction. The one bounded wait is superseding an
--   older open capture: lock_timeout is one second, and only
--   lock_not_available becomes MAR05. query_canceled is a cancellation, not
--   contention. Begin holds accounts before it updates other capture rows;
--   a writer takes the capture NOWAIT and then the accounts NOWAIT, so it
--   cannot sit on the capture while begin holds the accounts.
-- * auth.users ON DELETE CASCADE does delete this owner's captures. There is
--   no foreign key to social_accounts, so an account delete does not.
--   Owner-first KEY SHARE NOWAIT is why the owner-delete inversion is safe:
--   the refresh refuses instead of waiting on auth.users while it holds rows
--   the cascade will lock.
-- * The failure path locks the webhook subscriptions of the account's
--   workspace before the outbox insert. partner_emit_webhook_event INSERTS
--   deliveries; it does not update webhook rows, so KEY SHARE remains
--   compatible with non-key updates. That is not a reason to broaden the
--   lock. A workspace or subscription delete still takes the parent in the
--   opposite order, and locking it first turns that inversion into MAR05.
-- * Capture lifetime and every known supplied token expiry are checked again
--   with clock_timestamp() after the mutations that can wait, immediately
--   before the capture is completed. An omitted expiry is preserved. An
--   explicit null clears. Neither is refused merely because it is absent.
--
-- SQLSTATE
-- --------
--   MAR01  malformed or unsupported request payload
--   MAR02  unknown or foreign resource (not found, or not owned)
--   MAR03  ineligible account or capture for the requested operation
--   MAR04  stale capture: the captured authority moved, the capture closed,
--          or an explicit target is not on the captured grant and member set
--   MAR05  contention, or discovery that no longer matches under the locks:
--          retry the whole transaction. The lock set is not extended.
--   MAR06  operation or credential-kind mismatch
--   MAR07  the supplied token expiry has already passed
--
-- No message in this migration contains a token.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The capture relation.
--
--    One row per refresh attempt. Nonsecret: it holds identifiers, presence
--    flags and versions. The token material is returned by begin and is never
--    written here, so the table is safe to expose to a service reader that
--    must never see a secret.
--
--    There is deliberately no foreign key to social_accounts, so deleting an
--    account does not cascade into this row. The captured accounts are checked
--    structurally inside SQL on every read and every write. auth.users is a
--    foreign-key parent: ON DELETE CASCADE does remove this owner's captures.
--    Owner-first KEY SHARE NOWAIT is the protection for that cascade. The
--    capture row is itself a lock target, taken NOWAIT by the writers.
-- ---------------------------------------------------------------------------
CREATE TABLE public.meta_account_refresh_captures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  -- The capture format version. Bumped only by a later migration.
  capture_version INTEGER NOT NULL DEFAULT 1,
  -- The single operation this capture describes.
  operation       TEXT NOT NULL,
  -- open -> completed | failed | superseded. A closed capture is never
  -- writable again.
  status          TEXT NOT NULL DEFAULT 'open',
  captured_at     TIMESTAMPTZ NOT NULL,
  -- The finite validity of this attempt. Written once, never extended.
  expires_at      TIMESTAMPTZ NOT NULL,
  -- The immutable authority capture. Identifiers, presence flags, versions
  -- and the complete captured membership. No token, no provider response.
  capture         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_account_refresh_captures_owner_key
    UNIQUE (id, user_id),
  CONSTRAINT meta_account_refresh_captures_user_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_account_refresh_captures_version_chk
    CHECK (capture_version >= 1),
  CONSTRAINT meta_account_refresh_captures_operation_chk
    CHECK (operation IN ('direct_token', 'page_token', 'facebook_user_token')),
  CONSTRAINT meta_account_refresh_captures_status_chk
    CHECK (status IN ('open', 'completed', 'failed', 'superseded')),
  CONSTRAINT meta_account_refresh_captures_capture_object_chk
    CHECK (jsonb_typeof(capture) = 'object'),
  CONSTRAINT meta_account_refresh_captures_deadline_chk
    CHECK (
      isfinite(captured_at)
      AND isfinite(expires_at)
      AND expires_at > captured_at
    )
);

CREATE INDEX idx_meta_account_refresh_captures_user
  ON public.meta_account_refresh_captures (user_id);

CREATE INDEX idx_meta_account_refresh_captures_status
  ON public.meta_account_refresh_captures (status);

CREATE INDEX idx_meta_account_refresh_captures_expiry
  ON public.meta_account_refresh_captures (expires_at);

CREATE TRIGGER update_meta_account_refresh_captures_updated_at
  BEFORE UPDATE ON public.meta_account_refresh_captures
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.meta_account_refresh_captures IS
  'Service-only, nonsecret record of one Meta refresh attempt. Holds the '
  'immutable authority capture taken before the provider call, the attempt '
  'marker and the capture lifetime. Holds NO token, NO refresh token and NO '
  'raw provider response. Never readable by a browser role.';

COMMENT ON COLUMN public.meta_account_refresh_captures.capture IS
  'The captured authority: per target the platform, the stable provider '
  'identity, the binding presence, the surviving connection-fence high-water '
  'mark, the credential id / revision / subject, the Instagram capability '
  'generation and login kind, the health columns and the attempt marker; and '
  'for a shared User grant the complete captured membership of that grant. '
  'Never rewritten.';

COMMENT ON COLUMN public.meta_account_refresh_captures.expires_at IS
  'The finite validity of this attempt. A commit after this instant is '
  'refused. Never extended by a read, a retry or a re-begin.';

-- ---------------------------------------------------------------------------
-- 2. Internal helpers.
--
--    SECURITY INVOKER, service-boundary only. They are granted to the
--    migration owner alone, exactly like the accepted prerequisite 2 helpers.
-- ---------------------------------------------------------------------------

-- The refresh owner is an FK parent. An owner delete holds that row and then
-- cascades into the accounts and the workspaces, so waiting for it while
-- this transaction already holds those rows is the cycle. NOWAIT.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_lock_owner(
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_found BOOLEAN := false;
BEGIN
  BEGIN
    SELECT true INTO v_found
      FROM auth.users
     WHERE id = p_user_id
     FOR KEY SHARE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION
        'the refresh owner is being deleted; retry the whole transaction'
        USING ERRCODE = 'MAR05';
  END;
  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the refresh owner no longer exists' USING ERRCODE = 'MAR02';
  END IF;
END;
$function$;

-- The accepted Phase 1 lock discipline, with bounded refusal.
--
-- Accounts first, in id order, each with its row lock and then its guard and
-- capability advisory locks; credentials second, in id order, each with its
-- row lock and then its advisory lock. That is the order the accepted
-- credential writers take, so this writer cannot pass them.
--
-- Every acquisition is bounded. A busy row or a busy advisory lock is a
-- typed refusal and the caller retries the whole transaction. There is no
-- wait, no sleep loop and no blanket deadlock catch.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_lock_scope(
  p_user_id UUID,
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
  FOR v_account IN
    SELECT DISTINCT x
      FROM unnest(COALESCE(p_account_ids, ARRAY[]::UUID[])) AS u(x)
     WHERE x IS NOT NULL
     ORDER BY 1
  LOOP
    BEGIN
      PERFORM 1
        FROM public.social_accounts AS sa
       WHERE sa.id = v_account
         AND sa.user_id = p_user_id
       FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'account % is not owned by the given user', v_account
          USING ERRCODE = 'MAR02';
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION
          'account % is busy; retry the whole transaction', v_account
          USING ERRCODE = 'MAR05';
    END;

    IF NOT pg_try_advisory_xact_lock(
         hashtext('social_account_guard:' || v_account::text)) THEN
      RAISE EXCEPTION
        'the guard lock of account % is busy; retry the whole transaction', v_account
        USING ERRCODE = 'MAR05';
    END IF;

    IF NOT pg_try_advisory_xact_lock(
         hashtext('instagram_capability:' || v_account::text)) THEN
      RAISE EXCEPTION
        'the capability lock of account % is busy; retry the whole transaction', v_account
        USING ERRCODE = 'MAR05';
    END IF;
  END LOOP;

  FOR v_credential IN
    SELECT DISTINCT x
      FROM unnest(COALESCE(p_credential_ids, ARRAY[]::UUID[])) AS u(x)
     WHERE x IS NOT NULL
     ORDER BY 1
  LOOP
    BEGIN
      PERFORM 1
        FROM public.facebook_user_credentials AS c
       WHERE c.id = v_credential
         AND c.user_id = p_user_id
       FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'facebook user credential % is not owned by the given user', v_credential
          USING ERRCODE = 'MAR02';
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION
          'facebook user credential % is busy; retry the whole transaction', v_credential
          USING ERRCODE = 'MAR05';
    END;

    IF NOT pg_try_advisory_xact_lock(
         hashtext('facebook_user_credential:' || v_credential::text)) THEN
      RAISE EXCEPTION
        'the lock of facebook user credential % is busy; retry the whole transaction', v_credential
        USING ERRCODE = 'MAR05';
    END IF;
  END LOOP;
END;
$function$;

-- The webhook subscriptions of one workspace.
--
-- The outbox row's foreign key parent is partner_webhooks. A workspace
-- delete or a subscription delete takes that parent in the opposite order to
-- this transaction, so the parent is locked here, before the outbox insert,
-- with a bounded refusal. Every candidate subscription of the workspace is
-- locked, not only the ones that match the event, because the emit filter is
-- the producer's business and the lock set must not depend on it.
-- partner_emit_webhook_event INSERTs deliveries. It does not update webhook
-- rows, so KEY SHARE stays compatible with non-key updates. That compatibility
-- is not a defect and this lock is not widened for it.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_lock_subscriptions(
  p_workspace_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_webhook UUID;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_webhook IN
    SELECT w.id
      FROM public.partner_webhooks AS w
     WHERE w.workspace_id = p_workspace_id
     ORDER BY w.id
  LOOP
    BEGIN
      PERFORM 1
        FROM public.partner_webhooks AS w
       WHERE w.id = v_webhook
       FOR KEY SHARE NOWAIT;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION
          'webhook subscription % is busy; retry the whole transaction', v_webhook
          USING ERRCODE = 'MAR05';
    END;
  END LOOP;
END;
$function$;

-- A uuid field, with this contract's own error code.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_uuid(
  p_value TEXT,
  p_field TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  BEGIN
    RETURN p_value::UUID;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '% must be a uuid string', p_field USING ERRCODE = 'MAR01';
  END;
END;
$function$;

-- A zoned ISO-8601 timestamp. The accepted parser's rules are kept exactly
-- (an explicit zone, a finite instant) and only the error code is this
-- contract's own. A NULL input is a NULL output, so an explicit null expiry
-- clears and an omitted expiry preserves.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_timestamp(
  p_raw TEXT,
  p_field TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public.facebook_user_credential_parse_zoned_timestamp(p_raw, p_field);
EXCEPTION
  WHEN SQLSTATE 'ICG04' THEN
    RAISE EXCEPTION '% must be a finite ISO-8601 timestamp', p_field
      USING ERRCODE = 'MAR01';
END;
$function$;

-- A non-negative integer field.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_uint(
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
BEGIN
  IF p_value IS NULL THEN
    RAISE EXCEPTION '% must be a non-negative integer', p_field
      USING ERRCODE = 'MAR01';
  END IF;
  RETURN public.facebook_user_credential_parse_uint(p_value, p_field, p_allow_zero);
EXCEPTION
  WHEN SQLSTATE 'FUC04' THEN
    RAISE EXCEPTION '% must be a non-negative integer', p_field
      USING ERRCODE = 'MAR01';
END;
$function$;

-- The stable failure classification.
--
-- The category is the whole error surface that reaches storage. A provider
-- message, a provider response body or a token never reaches the health
-- columns, the event payload or a log line through this contract.
--
--   transient  the failure is not evidence against the grant. The failure
--              count is held and the account is never latched.
--   permanent  the grant itself is dead. The account is latched at once.
--   counted    an unclassified provider failure. It counts, and it latches
--              only at the ceiling.
--
-- The category list is closed. An unknown category is a malformed request,
-- not a new error surface.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_error_policy(
  p_category TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_category IN (
    'provider_transient',
    'provider_rate_limited',
    'provider_unavailable',
    'local_internal_error'
  ) THEN
    RETURN jsonb_build_object('kind', 'transient', 'counts', false, 'latches', false);
  END IF;

  -- Definitive revoked, expired or invalid-grant evidence, and a grant that
  -- has no refresh material, latch immediately. That is the canonical
  -- escalation: a permanent message, a structured permanent Meta error, or
  -- canAttemptRefresh = false. A malformed successful response and a generic
  -- permission error are not that evidence. They count toward the ceiling
  -- of three, the same way an ordinary provider_error does.
  IF p_category IN (
    'provider_auth_expired',
    'provider_auth_revoked',
    'provider_invalid_grant',
    'local_no_refresh_material'
  ) THEN
    RETURN jsonb_build_object('kind', 'permanent', 'counts', true, 'latches', true);
  END IF;

  IF p_category IN (
    'provider_error',
    'provider_permission_denied',
    'provider_response_invalid'
  ) THEN
    RETURN jsonb_build_object('kind', 'counted', 'counts', true, 'latches', false);
  END IF;

  RAISE EXCEPTION 'unsupported error category' USING ERRCODE = 'MAR01';
END;
$function$;

-- A required JSON field. A missing key, SQL NULL, JSON null and a wrong
-- JSON type are all MAR01. `jsonb_typeof(x) <> 'string'` is not this check:
-- a missing key makes jsonb_typeof return NULL, and IF treats that NULL as
-- false, which is how an omitted operation used to fall through.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_json(
  p_object JSONB,
  p_field TEXT,
  p_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_object IS NULL
     OR jsonb_typeof(p_object) IS DISTINCT FROM 'object'
     OR NOT (p_object ? p_field)
     OR jsonb_typeof(p_object -> p_field) IS DISTINCT FROM p_type THEN
    RAISE EXCEPTION '% must be present and a JSON %', p_field, p_type
      USING ERRCODE = 'MAR01';
  END IF;
  RETURN p_object -> p_field;
END;
$function$;

-- Known supplied expiries, on the live clock. This function writes nothing.
-- An omitted token_expires_at preserves the stored expiry. An explicit JSON
-- null clears it. Neither is a known expiry, so neither is refused here.
-- A present timestamp must still be in the future.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_assert_known_expiries(
  p_fields JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;
  IF p_fields ? 'token_expires_at'
     AND jsonb_typeof(p_fields -> 'token_expires_at') = 'string'
     AND clock_timestamp() >= public.meta_account_refresh_timestamp(
           p_fields ->> 'token_expires_at', 'token_expires_at') THEN
    RAISE EXCEPTION
      'the supplied token expiry has already passed'
      USING ERRCODE = 'MAR07';
  END IF;
END;
$function$;

-- Operation eligibility from the rows the caller has locked, or from the
-- unlocked discovery read. The returned uuid is the binding's credential,
-- or NULL when the account is not bound. A direct token, a page operational
-- token and a User grant stay distinct. A Facebook Page uses its connection
-- binding as the fence and does not need an Instagram capability row.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_eligibility(
  p_user_id UUID,
  p_account UUID,
  p_operation TEXT
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_platform TEXT;
  v_account_token TEXT;
  v_is_active BOOLEAN;
  v_binding UUID;
  v_login_kind TEXT;
  v_capability_present BOOLEAN;
BEGIN
  SELECT sa.platform, sa.access_token, sa.is_active, b.credential_id
    INTO v_platform, v_account_token, v_is_active, v_binding
    FROM public.social_accounts AS sa
    LEFT JOIN public.facebook_user_credential_bindings AS b
      ON b.social_account_id = sa.id
     AND b.user_id = sa.user_id
   WHERE sa.id = p_account
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'social account % is not owned by the given user', p_account
      USING ERRCODE = 'MAR02';
  END IF;

  IF p_operation = 'direct_token' AND v_platform IS DISTINCT FROM 'instagram' THEN
    RAISE EXCEPTION
      'a direct Instagram refresh needs an Instagram account'
      USING ERRCODE = 'MAR03';
  END IF;
  IF p_operation = 'page_token'
     AND v_platform NOT IN ('instagram', 'facebook') THEN
    RAISE EXCEPTION
      'a page operational refresh needs an Instagram or Facebook Page account'
      USING ERRCODE = 'MAR03';
  END IF;
  IF p_operation = 'facebook_user_token'
     AND v_platform NOT IN ('instagram', 'facebook') THEN
    RAISE EXCEPTION
      'a shared Facebook User refresh needs a Facebook or Instagram account'
      USING ERRCODE = 'MAR03';
  END IF;

  IF v_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'account % is not active; a refresh must not reactivate it', p_account
      USING ERRCODE = 'MAR03';
  END IF;

  SELECT c.login_kind INTO v_login_kind
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_account
     AND c.user_id = p_user_id;
  v_capability_present := FOUND;

  IF v_platform = 'instagram' AND NOT v_capability_present THEN
    RAISE EXCEPTION
      'account % has no capability record', p_account
      USING ERRCODE = 'MAR03';
  END IF;

  IF p_operation = 'direct_token' THEN
    IF v_login_kind IS DISTINCT FROM 'direct' THEN
      RAISE EXCEPTION
        'a direct refresh requires a direct capability classification'
        USING ERRCODE = 'MAR03';
    END IF;
    IF v_binding IS NOT NULL THEN
      RAISE EXCEPTION
        'a direct refresh refuses the Facebook user binding of account %', p_account
        USING ERRCODE = 'MAR03';
    END IF;
    IF v_account_token IS NULL OR btrim(v_account_token) = '' THEN
      RAISE EXCEPTION
        'account % has no refresh material', p_account
        USING ERRCODE = 'MAR03';
    END IF;
  ELSIF p_operation = 'page_token' THEN
    IF v_platform = 'instagram' THEN
      IF v_login_kind IS DISTINCT FROM 'page_linked' THEN
        RAISE EXCEPTION
          'a page operational refresh requires a page-linked capability classification'
          USING ERRCODE = 'MAR03';
      END IF;
    ELSE
      IF v_binding IS NULL THEN
        RAISE EXCEPTION
          'a Facebook Page operational refresh needs its captured connection binding'
          USING ERRCODE = 'MAR03';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM public.facebook_user_credential_connection_fences AS f
         WHERE f.social_account_id = p_account
           AND f.user_id = p_user_id
      ) THEN
        RAISE EXCEPTION
          'a Facebook Page operational refresh needs its captured connection fence'
          USING ERRCODE = 'MAR03';
      END IF;
      IF v_capability_present AND v_login_kind IS DISTINCT FROM 'page_linked' THEN
        RAISE EXCEPTION
          'a Facebook Page operational refresh refuses a non-page capability classification'
          USING ERRCODE = 'MAR03';
      END IF;
    END IF;
    IF v_account_token IS NULL OR btrim(v_account_token) = '' THEN
      RAISE EXCEPTION
        'account % has no refresh material', p_account
        USING ERRCODE = 'MAR03';
    END IF;
  ELSE
    IF v_binding IS NULL THEN
      RAISE EXCEPTION
        'a shared Facebook User refresh needs a bound account, not account %', p_account
        USING ERRCODE = 'MAR03';
    END IF;
    IF v_platform = 'instagram' AND v_login_kind IS DISTINCT FROM 'page_linked' THEN
      RAISE EXCEPTION
        'a direct Instagram account cannot carry a Facebook user grant: account %', p_account
        USING ERRCODE = 'MAR03';
    END IF;
  END IF;

  RETURN v_binding;
END;
$function$;

-- The locked recheck of the credential discovery just named.
--
-- Eligibility is repeated, and its credential id is kept. A direct account
-- must still be unbound. A page or shared target must still be bound to the
-- discovered credential and must still be one of the accounts in the single
-- membership document that was locked. A different live binding, or a target
-- missing from that document, is discovery drift: MAR05, and the caller
-- retries. The returned id is the discovered id. This function does not
-- switch the capture onto the grant it found instead.
--
-- A direct account that has become bound is MAR03 from eligibility, because
-- it is no longer a direct refresh. That is ineligibility, not a grant to adopt.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_discovered_grant(
  p_user_id UUID,
  p_account UUID,
  p_operation TEXT,
  p_discovered UUID,
  p_member_accounts UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_live UUID;
BEGIN
  v_live := public.meta_account_refresh_require_eligibility(
    p_user_id, p_account, p_operation);

  IF v_live IS DISTINCT FROM p_discovered THEN
    RAISE EXCEPTION
      'the discovered grant no longer matches account %; retry the whole transaction',
      p_account
      USING ERRCODE = 'MAR05';
  END IF;

  IF p_discovered IS NOT NULL
     AND NOT (p_account = ANY (COALESCE(p_member_accounts, ARRAY[]::UUID[]))) THEN
    RAISE EXCEPTION
      'the discovered grant no longer contains account %; retry the whole transaction',
      p_account
      USING ERRCODE = 'MAR05';
  END IF;

  RETURN v_live;
END;
$function$;

-- Successful refresh clears failure evidence on an explicit target only.
-- needs_reauth is untouched: only the OAuth lifecycle may clear it.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_clear_failure_evidence(
  p_user_id UUID,
  p_social_account_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.social_accounts AS sa
     SET failure_count = 0,
         last_refresh_error = NULL,
         updated_at = now()
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'account % is not owned by the given user', p_social_account_id
      USING ERRCODE = 'MAR02';
  END IF;
END;
$function$;

-- The captured authority of one owned account.
--
-- The shape is the accepted prerequisite 2 account capture: the platform and
-- the stable provider identity, the binding presence, the surviving
-- connection-fence high-water mark, the credential id, revision and subject,
-- and the Instagram capability presence, generation and login kind. The
-- refresh contract adds the health columns, the known token expiry and the
-- refresh-token presence, because a refresh decision is made from those too.
--
-- Nothing here is a secret.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_capture_account(
  p_user_id UUID,
  p_social_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_base JSONB;
  v_platform TEXT;
  v_token_expires_at TIMESTAMPTZ;
  v_refresh_token TEXT;
  v_failure_count INTEGER;
  v_needs_reauth BOOLEAN;
BEGIN
  BEGIN
    v_base := public.meta_oauth_attempt_capture_account(p_user_id, p_social_account_id);
  EXCEPTION
    WHEN SQLSTATE 'MOA02' THEN
      RAISE EXCEPTION
        'social account % is not owned by the given user', p_social_account_id
        USING ERRCODE = 'MAR02';
    WHEN SQLSTATE 'MOA07' THEN
      RAISE EXCEPTION
        'social account % carries a binding whose credential no longer exists',
        p_social_account_id
        USING ERRCODE = 'MAR04';
  END;

  SELECT sa.platform, sa.token_expires_at, sa.refresh_token,
         sa.failure_count, sa.needs_reauth
    INTO v_platform, v_token_expires_at, v_refresh_token,
         v_failure_count, v_needs_reauth
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'social account % is not owned by the given user', p_social_account_id
      USING ERRCODE = 'MAR02';
  END IF;

  RETURN v_base || jsonb_build_object(
    'token_expires_at', v_token_expires_at,
    -- Presence only. The value never enters a capture.
    'refresh_token_present', (v_refresh_token IS NOT NULL),
    'failure_count', COALESCE(v_failure_count, 0),
    'needs_reauth', COALESCE(v_needs_reauth, false)
  );
END;
$function$;

-- The complete membership of one shared Facebook User grant.
--
-- This is the membership of ONE credential. It is never an owner-wide
-- inventory of accounts, and it is never supplied by the caller.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_capture_members(
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_members JSONB;
BEGIN
  IF p_credential_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'social_account_id', b.social_account_id,
             'platform', b.platform,
             'connection_version', b.connection_version,
             'capability_generation', cap.credential_generation,
             'fence_connection_version', f.connection_version
           )
           ORDER BY b.social_account_id
         ), '[]'::JSONB)
    INTO v_members
    FROM public.facebook_user_credential_bindings AS b
    LEFT JOIN public.instagram_account_capabilities AS cap
      ON cap.social_account_id = b.social_account_id
     AND cap.user_id = b.user_id
    LEFT JOIN public.facebook_user_credential_connection_fences AS f
      ON f.social_account_id = b.social_account_id
     AND f.user_id = b.user_id
   WHERE b.credential_id = p_credential_id
     AND b.user_id = p_user_id;

  RETURN v_members;
END;
$function$;

-- The captured membership must still be the live membership.
--
-- A grant that gained or lost a member after the capture is a refusal, not
-- a set that is quietly re-read. The held lock set is never expanded.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_members(
  p_user_id UUID,
  p_credential_id UUID,
  p_members JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_expected TEXT[];
  v_live TEXT[];
  v_member JSONB;
  v_account UUID;
  v_connection BIGINT;
  v_generation BIGINT;
BEGIN
  IF p_credential_id IS NULL OR p_members IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'the captured grant membership is malformed' USING ERRCODE = 'MAR04';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT e.value ->> 'social_account_id'
      FROM jsonb_array_elements(p_members) AS e(value)
     WHERE e.value ->> 'social_account_id' IS NOT NULL
     ORDER BY 1)
    INTO v_expected;

  v_live := public.meta_oauth_attempt_live_grant_members(p_user_id, p_credential_id);

  IF v_expected IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION
      'the captured shared grant membership no longer matches the live membership'
      USING ERRCODE = 'MAR04';
  END IF;

  FOR v_member IN
    SELECT e.value FROM jsonb_array_elements(p_members) AS e(value)
  LOOP
    v_account := public.meta_account_refresh_uuid(
      v_member ->> 'social_account_id', 'captured member social_account_id');

    SELECT b.connection_version
      INTO v_connection
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.social_account_id = v_account
       AND b.user_id = p_user_id
       AND b.credential_id = p_credential_id;
    IF NOT FOUND
       OR v_connection IS DISTINCT FROM (v_member ->> 'connection_version')::BIGINT THEN
      RAISE EXCEPTION
        'a captured grant member connection version no longer matches'
        USING ERRCODE = 'MAR04';
    END IF;

    -- The fence is the high-water mark. A bind -> detach cycle that restores
    -- the binding version is the connection ABA, and it refuses.
    SELECT f.connection_version
      INTO v_connection
      FROM public.facebook_user_credential_connection_fences AS f
     WHERE f.social_account_id = v_account
       AND f.user_id = p_user_id;
    IF v_connection IS DISTINCT FROM (v_member ->> 'fence_connection_version')::BIGINT THEN
      RAISE EXCEPTION
        'a captured grant member connection fence no longer matches'
        USING ERRCODE = 'MAR04';
    END IF;

    IF (v_member ->> 'platform') = 'instagram'
       AND (v_member ->> 'capability_generation') IS NOT NULL THEN
      SELECT c.credential_generation
        INTO v_generation
        FROM public.instagram_account_capabilities AS c
       WHERE c.social_account_id = v_account
         AND c.user_id = p_user_id;
      IF v_generation IS DISTINCT FROM (v_member ->> 'capability_generation')::BIGINT THEN
        RAISE EXCEPTION
          'a captured grant member capability generation no longer matches'
          USING ERRCODE = 'MAR04';
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- An explicit target has to be part of the captured grant, not merely a
-- valid account document placed beside a valid grant document.
--
-- The target must be one of the captured member ids, and its live binding
-- must be the captured credential. Either miss is MAR04. The member set is
-- the one already locked; this check does not read a new membership and
-- does not add accounts to the lock.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_target_on_grant(
  p_user_id UUID,
  p_credential_id UUID,
  p_members JSONB,
  p_target JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_account UUID;
  v_live UUID;
BEGIN
  v_account := public.meta_account_refresh_uuid(
    p_target ->> 'social_account_id', 'captured social_account_id');

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
     WHERE (e.value ->> 'social_account_id')::UUID = v_account
  ) THEN
    RAISE EXCEPTION
      'explicit target % is not in the captured member set', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  SELECT b.credential_id
    INTO v_live
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_account
     AND b.user_id = p_user_id;

  IF v_live IS DISTINCT FROM p_credential_id THEN
    RAISE EXCEPTION
      'explicit target % does not belong to the captured grant', v_account
      USING ERRCODE = 'MAR04';
  END IF;
END;
$function$;

-- The captured authority of one account must still match the live account.
--
-- This is the check that refuses a stale result. It runs under the account
-- lock and before any write, so a stale result produces no health change,
-- no fence advance, no event and no alert marker.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_require_captured_account(
  p_user_id UUID,
  p_capture JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_account UUID;
  v_platform TEXT;
  v_platform_user_id TEXT;
  v_binding_present BOOLEAN := false;
  v_binding_credential UUID;
  v_binding_connection BIGINT;
  v_fence_state TEXT;
  v_fence_version BIGINT;
  v_revision BIGINT;
  v_subject TEXT;
  v_capability_present BOOLEAN := false;
  v_generation BIGINT;
  v_login_kind TEXT;
  v_failure_count INTEGER;
  v_needs_reauth BOOLEAN;
  v_token_expires_at TIMESTAMPTZ;
BEGIN
  IF p_capture IS NULL OR jsonb_typeof(p_capture) <> 'object' THEN
    RAISE EXCEPTION 'the captured account is missing' USING ERRCODE = 'MAR04';
  END IF;

  v_account := public.meta_account_refresh_uuid(
    p_capture ->> 'social_account_id', 'captured social_account_id');

  SELECT sa.platform, sa.platform_user_id, sa.failure_count, sa.needs_reauth,
         sa.token_expires_at
    INTO v_platform, v_platform_user_id, v_failure_count, v_needs_reauth,
         v_token_expires_at
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account
     AND sa.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the captured account % is no longer owned by the given user', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  IF v_platform IS DISTINCT FROM (p_capture ->> 'platform')
     OR v_platform_user_id IS DISTINCT FROM (p_capture ->> 'platform_user_id') THEN
    RAISE EXCEPTION
      'the captured provider identity no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  SELECT b.credential_id, b.connection_version
    INTO v_binding_credential, v_binding_connection
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = v_account
     AND b.user_id = p_user_id;
  v_binding_present := FOUND;
  IF v_binding_present IS DISTINCT FROM (p_capture ->> 'binding_present')::BOOLEAN THEN
    RAISE EXCEPTION
      'the captured binding presence no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  SELECT f.connection_version INTO v_fence_version
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = v_account
     AND f.user_id = p_user_id;
  IF FOUND THEN
    v_fence_state := 'present';
  ELSE
    v_fence_state := 'never_created';
    v_fence_version := 0;
  END IF;
  IF v_fence_state IS DISTINCT FROM (p_capture ->> 'fence_state')
     OR v_fence_version IS DISTINCT FROM (p_capture ->> 'fence_connection_version')::BIGINT THEN
    RAISE EXCEPTION
      'the captured connection fence no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  IF v_binding_present THEN
    IF v_binding_credential IS DISTINCT FROM (p_capture ->> 'binding_credential_id')::UUID
       OR v_binding_connection IS DISTINCT FROM
          (p_capture ->> 'binding_connection_version')::BIGINT THEN
      RAISE EXCEPTION
        'the captured binding no longer matches account %', v_account
        USING ERRCODE = 'MAR04';
    END IF;
    SELECT c.revision, c.provider_user_id
      INTO v_revision, v_subject
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_binding_credential
       AND c.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the captured credential for account % no longer exists', v_account
        USING ERRCODE = 'MAR04';
    END IF;
    IF v_revision IS DISTINCT FROM (p_capture ->> 'credential_revision')::BIGINT THEN
      RAISE EXCEPTION
        'the captured credential revision no longer matches account %', v_account
        USING ERRCODE = 'MAR04';
    END IF;
    IF (p_capture ? 'provider_user_id')
       AND v_subject IS DISTINCT FROM (p_capture ->> 'provider_user_id') THEN
      RAISE EXCEPTION
        'the captured credential subject no longer matches account %', v_account
        USING ERRCODE = 'MAR04';
    END IF;
  END IF;

  SELECT c.credential_generation, c.login_kind
    INTO v_generation, v_login_kind
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account
     AND c.user_id = p_user_id;
  v_capability_present := FOUND;
  IF v_capability_present IS DISTINCT FROM (p_capture ->> 'capability_present')::BOOLEAN THEN
    RAISE EXCEPTION
      'the captured capability presence no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;
  IF v_capability_present
     AND (
       v_generation IS DISTINCT FROM (p_capture ->> 'capability_generation')::BIGINT
       OR v_login_kind IS DISTINCT FROM (p_capture ->> 'capability_login_kind')
     ) THEN
    RAISE EXCEPTION
      'the captured capability no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  -- The health columns are part of the captured decision: the failure policy
  -- counts from the captured failure count, not from a live re-read.
  IF v_failure_count IS DISTINCT FROM (p_capture ->> 'failure_count')::INTEGER
     OR v_needs_reauth IS DISTINCT FROM (p_capture ->> 'needs_reauth')::BOOLEAN THEN
    RAISE EXCEPTION
      'the captured health state no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;

  IF v_token_expires_at IS DISTINCT FROM (p_capture ->> 'token_expires_at')::TIMESTAMPTZ THEN
    RAISE EXCEPTION
      'the captured token expiry no longer matches account %', v_account
      USING ERRCODE = 'MAR04';
  END IF;
END;
$function$;

-- The account fields a refresh may write.
--
-- The whitelist is exact. An omitted key preserves the stored value; an
-- explicit null clears it. An omitted refresh token is NOT a null refresh
-- token, and an omitted expiry is NOT a cleared expiry.
--
-- needs_reauth is deliberately absent. Only the OAuth lifecycle may clear it.
-- is_active, social_profile_id, platform_user_id, platform_username,
-- account_metadata and the login kind are absent too: they are OAuth-only
-- lifecycle fields.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_apply_account_fields(
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
  v_set_refresh BOOLEAN := false;
  v_refresh TEXT := NULL;
BEGIN
  IF p_fields IS NULL OR p_fields = '{}'::JSONB THEN
    RAISE EXCEPTION 'a refresh write requires at least one field' USING ERRCODE = 'MAR01';
  END IF;
  IF jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'the refresh fields must be a JSON object' USING ERRCODE = 'MAR01';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF v_key NOT IN ('access_token', 'token_expires_at', 'refresh_token') THEN
      RAISE EXCEPTION 'unsupported refresh field: %', v_key USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;

  IF p_fields ? 'access_token' THEN
    IF jsonb_typeof(p_fields -> 'access_token') <> 'string'
       OR btrim(p_fields ->> 'access_token') = ''
       OR char_length(p_fields ->> 'access_token') > 4096 THEN
      RAISE EXCEPTION
        'access_token must be a non-empty string of at most 4096 characters'
        USING ERRCODE = 'MAR01';
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
        USING ERRCODE = 'MAR01';
    ELSE
      v_expiry := public.meta_account_refresh_timestamp(
        p_fields ->> 'token_expires_at', 'token_expires_at');
    END IF;
  END IF;

  IF p_fields ? 'refresh_token' THEN
    v_set_refresh := true;
    IF jsonb_typeof(p_fields -> 'refresh_token') = 'null' THEN
      v_refresh := NULL;
    ELSIF jsonb_typeof(p_fields -> 'refresh_token') <> 'string'
          OR char_length(p_fields ->> 'refresh_token') > 4096 THEN
      RAISE EXCEPTION
        'refresh_token must be a string of at most 4096 characters or null'
        USING ERRCODE = 'MAR01';
    ELSE
      v_refresh := p_fields ->> 'refresh_token';
    END IF;
  END IF;

  UPDATE public.social_accounts AS sa
     SET access_token = CASE WHEN v_set_access THEN v_access ELSE sa.access_token END,
         token_expires_at = CASE WHEN v_set_expiry THEN v_expiry ELSE sa.token_expires_at END,
         refresh_token = CASE WHEN v_set_refresh THEN v_refresh ELSE sa.refresh_token END,
         -- A successful refresh clears the failure evidence. It does NOT
         -- clear needs_reauth: only the OAuth lifecycle may do that.
         failure_count = 0,
         last_refresh_error = NULL,
         updated_at = now()
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'account % is not owned by the given user', p_social_account_id
      USING ERRCODE = 'MAR02';
  END IF;
END;
$function$;

-- The account's own fence.
--
-- The Instagram capability generation is that account's credential fence.
-- The advance is a compare-and-swap on the captured generation, so a
-- generation that moved while the provider call was in flight refuses
-- instead of overwriting the newer authority.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_advance_generation(
  p_user_id UUID,
  p_social_account_id UUID,
  p_expected_generation BIGINT,
  p_reason TEXT
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
  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = clock_timestamp(),
         generation_reason = p_reason,
         updated_at = now()
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id
     AND c.credential_generation = p_expected_generation
  RETURNING c.credential_generation INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the captured capability generation of account % no longer matches', p_social_account_id
      USING ERRCODE = 'MAR04';
  END IF;

  RETURN v_next;
END;
$function$;

-- The captured shared-grant rotation.
--
-- Every captured member of the grant is fenced: the Instagram members by
-- their capability generation, the Facebook members by their connection
-- fence. A member that moved while the provider call was in flight refuses
-- the whole rotation instead of being silently skipped.
--
-- The accepted write_facebook_user_credential is deliberately not called
-- here. Its preconditions do not fit: it takes a caller-supplied account
-- list rather than the captured membership, and it does not advance the
-- Facebook connection fences that the accepted shared-rotation contract
-- requires. The accepted internal that does advance them,
-- facebook_user_credential_commit_connection_version, is used instead.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_fence_members(
  p_user_id UUID,
  p_members JSONB,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_member JSONB;
  v_account UUID;
  v_platform TEXT;
  v_bumped BIGINT;
  v_expected BIGINT;
BEGIN
  SELECT count(*) INTO v_expected
    FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
   WHERE COALESCE(e.value ->> 'platform', 'instagram') = 'instagram'
     AND (e.value ->> 'capability_generation') IS NOT NULL;

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = clock_timestamp(),
         generation_reason = p_reason,
         updated_at = clock_timestamp()
    FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
   WHERE COALESCE(e.value ->> 'platform', 'instagram') = 'instagram'
     AND c.social_account_id = (e.value ->> 'social_account_id')::UUID
     AND c.user_id = p_user_id
     AND c.credential_generation = (e.value ->> 'capability_generation')::BIGINT;
  GET DIAGNOSTICS v_bumped = ROW_COUNT;

  IF v_bumped IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'a captured grant member capability generation no longer matches'
      USING ERRCODE = 'MAR04';
  END IF;

  FOR v_member IN
    SELECT e.value FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
  LOOP
    v_account := public.meta_account_refresh_uuid(
      v_member ->> 'social_account_id', 'captured member social_account_id');
    v_platform := COALESCE(v_member ->> 'platform', 'instagram');

    IF v_platform = 'facebook' THEN
      BEGIN
        PERFORM public.facebook_user_credential_commit_connection_version(
          p_user_id, v_account, (v_member ->> 'connection_version')::BIGINT);
      EXCEPTION
        WHEN SQLSTATE 'FUC01' THEN
          RAISE EXCEPTION
            'a captured facebook connection fence no longer matches'
            USING ERRCODE = 'MAR04';
      END;
    END IF;
  END LOOP;
END;
$function$;

-- Load one open capture for this owner.
--
-- The capture row is a lock target and is taken NOWAIT. auth.users ON DELETE
-- CASCADE does remove captures; there is no social_accounts foreign key.
-- Owner-first KEY SHARE NOWAIT is what keeps that cascade from deadlocking
-- a refresh that already holds account rows. A busy capture is MAR05.
-- query_canceled is not remapped: a real cancellation is not contention.
--
-- p_operation NULL is only for a fully validated failure request, which may
-- fail whichever operation the capture describes. Success writers pass the
-- claimed operation and it is compared unconditionally. A missing success
-- operation must never reach this function as NULL.
--
-- The lifetime is NOT checked here. It is checked again after the mutations
-- that can wait, immediately before the capture is completed.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_load_capture(
  p_user_id UUID,
  p_capture_id UUID,
  p_operation TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_capture JSONB;
  v_status TEXT;
  v_operation TEXT;
BEGIN
  BEGIN
    SELECT c.capture, c.status, c.operation
      INTO v_capture, v_status, v_operation
      FROM public.meta_account_refresh_captures AS c
     WHERE c.id = p_capture_id
       AND c.user_id = p_user_id
     FOR UPDATE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION
        'the refresh capture % is busy; retry the whole transaction', p_capture_id
        USING ERRCODE = 'MAR05';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the refresh capture % does not exist for the given owner', p_capture_id
      USING ERRCODE = 'MAR02';
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'the refresh capture % is no longer open', p_capture_id
      USING ERRCODE = 'MAR04';
  END IF;

  IF p_operation IS NOT NULL AND v_operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'the refresh capture % describes a different operation', p_capture_id
      USING ERRCODE = 'MAR06';
  END IF;

  IF v_capture IS NULL OR jsonb_typeof(v_capture) <> 'object' THEN
    RAISE EXCEPTION
      'the refresh capture % is malformed', p_capture_id
      USING ERRCODE = 'MAR04';
  END IF;

  RETURN v_capture;
END;
$function$;

-- The capture lifetime, checked against the live clock AFTER the account
-- and credential locks. A capture that expired while this transaction was
-- waiting is refused; a result is never accepted because the transaction
-- started before the deadline.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_assert_capture_live(
  p_capture_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_expires_at TIMESTAMPTZ;
BEGIN
  SELECT c.expires_at INTO v_expires_at
    FROM public.meta_account_refresh_captures AS c
   WHERE c.id = p_capture_id;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION
      'the refresh capture % no longer exists', p_capture_id
      USING ERRCODE = 'MAR04';
  END IF;

  IF clock_timestamp() >= v_expires_at THEN
    RAISE EXCEPTION
      'the refresh capture % expired before the result was committed', p_capture_id
      USING ERRCODE = 'MAR04';
  END IF;
END;
$function$;

-- The captured targets of one capture, as a JSON array.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_capture_targets(
  p_capture JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_capture -> 'targets') = 'array'
      THEN p_capture -> 'targets'
    ELSE '[]'::JSONB
  END;
$function$;

-- The one captured target of a single-account capture.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_capture_target(
  p_capture JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_targets JSONB;
BEGIN
  v_targets := public.meta_account_refresh_capture_targets(p_capture);
  IF jsonb_array_length(v_targets) <> 1 THEN
    RAISE EXCEPTION
      'this refresh capture describes exactly one account'
      USING ERRCODE = 'MAR04';
  END IF;
  RETURN v_targets -> 0;
END;
$function$;

-- The authoritative, nonsecret state of one account after a refresh write.
CREATE OR REPLACE FUNCTION public.meta_account_refresh_account_state(
  p_user_id UUID,
  p_social_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_platform TEXT;
  v_platform_user_id TEXT;
  v_token_expires_at TIMESTAMPTZ;
  v_refresh_token_present BOOLEAN;
  v_failure_count INTEGER;
  v_needs_reauth BOOLEAN;
  v_is_active BOOLEAN;
  v_generation BIGINT;
  v_login_kind TEXT;
  v_binding_credential UUID;
  v_binding_connection BIGINT;
  v_credential_revision BIGINT;
BEGIN
  SELECT sa.platform, sa.platform_user_id, sa.token_expires_at,
         (sa.refresh_token IS NOT NULL), sa.failure_count, sa.needs_reauth,
         sa.is_active
    INTO v_platform, v_platform_user_id, v_token_expires_at,
         v_refresh_token_present, v_failure_count, v_needs_reauth, v_is_active
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT c.credential_generation, c.login_kind
    INTO v_generation, v_login_kind
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;

  SELECT b.credential_id, b.connection_version
    INTO v_binding_credential, v_binding_connection
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;

  IF v_binding_credential IS NOT NULL THEN
    SELECT c.revision INTO v_credential_revision
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_binding_credential AND c.user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'social_account_id', p_social_account_id,
    'platform', v_platform,
    'platform_user_id', v_platform_user_id,
    'login_kind', v_login_kind,
    'credential_generation', v_generation,
    'binding_credential_id', v_binding_credential,
    'binding_connection_version', v_binding_connection,
    'credential_revision', v_credential_revision,
    'token_expires_at', v_token_expires_at,
    'refresh_token_present', v_refresh_token_present,
    'failure_count', COALESCE(v_failure_count, 0),
    'needs_reauth', COALESCE(v_needs_reauth, false),
    'is_active', v_is_active
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. begin_meta_account_refresh.
--
--    The coherent pre-provider capture. It validates the owned identity, the
--    capability / login kind / binding consistency and the eligibility; it
--    locks the complete required account and credential set; it records the
--    attempt marker; and it returns the token material together with the
--    versioned capture that describes it.
--
--    The returned capture is stored. The commit writers read it back, so the
--    captured membership, the captured subject and the captured identities
--    cannot be supplied by the caller.
--
--    Retry and duplicate semantics:
--      * the newest attempt for an account wins; an older open capture of the
--        same account is closed as superseded, so a late result of the
--        previous attempt can no longer be committed;
--      * a capture is valid for thirty minutes and is never extended;
--      * a closed capture (completed, failed or superseded) is never
--        writable again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_meta_account_refresh(
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
  v_operation TEXT := NULL;
  v_item JSONB;
  v_account UUID;
  v_accounts UUID[] := ARRAY[]::UUID[];
  v_credential_ids UUID[] := ARRAY[]::UUID[];
  v_member_accounts UUID[] := ARRAY[]::UUID[];
  v_lock_accounts UUID[];
  v_target JSONB;
  v_targets JSONB := '[]'::JSONB;
  v_capture JSONB;
  v_capture_id UUID;
  v_captured_at TIMESTAMPTZ;
  v_expires_at TIMESTAMPTZ;
  v_members JSONB := NULL;
  v_credential JSONB := NULL;
  v_credential_id UUID := NULL;
  v_credential_revision BIGINT;
  v_credential_subject TEXT;
  v_platform TEXT;
  v_login_kind TEXT;
  v_capability_present BOOLEAN;
  v_account_token TEXT;
  v_account_expires TIMESTAMPTZ;
  v_account_refresh_token TEXT;
  v_credential_token TEXT;
  v_credential_expires TIMESTAMPTZ;
  v_binding_credential UUID;
  v_is_active BOOLEAN;
  v_tokens JSONB := '[]'::JSONB;
  v_before_members TEXT[];
  v_after_members TEXT[];
  v_lock_timeout TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MAR01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MAR01';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key <> 'accounts' THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;

  PERFORM public.meta_account_refresh_require_json(p_payload, 'accounts', 'array');
  IF jsonb_array_length(p_payload -> 'accounts') = 0 THEN
    RAISE EXCEPTION 'at least one account is required' USING ERRCODE = 'MAR01';
  END IF;
  IF jsonb_array_length(p_payload -> 'accounts') > 100 THEN
    RAISE EXCEPTION 'at most 100 accounts may be captured at once' USING ERRCODE = 'MAR01';
  END IF;

  -- One capture describes one operation. A direct token, a page operational
  -- token and a shared User grant are three different authorities.
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_payload -> 'accounts') AS e(value)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'accounts entries must be objects' USING ERRCODE = 'MAR01';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
      IF v_key NOT IN ('social_account_id', 'operation') THEN
        RAISE EXCEPTION 'unsupported account field: %', v_key USING ERRCODE = 'MAR01';
      END IF;
    END LOOP;
    PERFORM public.meta_account_refresh_require_json(
      v_item, 'social_account_id', 'string');
    PERFORM public.meta_account_refresh_require_json(v_item, 'operation', 'string');
    IF (v_item ->> 'operation') NOT IN
         ('direct_token', 'page_token', 'facebook_user_token') THEN
      RAISE EXCEPTION
        'operation must be direct_token, page_token or facebook_user_token'
        USING ERRCODE = 'MAR01';
    END IF;
    IF v_operation IS NULL THEN
      v_operation := v_item ->> 'operation';
    ELSIF v_operation IS DISTINCT FROM (v_item ->> 'operation') THEN
      RAISE EXCEPTION
        'one refresh capture may not mix operations' USING ERRCODE = 'MAR01';
    END IF;

    v_account := public.meta_account_refresh_uuid(
      v_item ->> 'social_account_id', 'social_account_id');
    IF v_account = ANY (v_accounts) THEN
      RAISE EXCEPTION 'duplicate account in accounts' USING ERRCODE = 'MAR01';
    END IF;
    v_accounts := v_accounts || v_account;
  END LOOP;

  -- direct_token and page_token are one account. A second account used to
  -- be stored and then refused by the writer, leaving an open capture no
  -- caller could complete. facebook_user_token keeps its explicit-target
  -- list, up to the cap above, provided every target shares one grant.
  IF v_operation IN ('direct_token', 'page_token')
     AND COALESCE(array_length(v_accounts, 1), 0) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'a direct or page operational refresh captures exactly one account'
      USING ERRCODE = 'MAR01';
  END IF;

  -- Unlocked discovery names the operation and at most one credential.
  -- No owner lock and no account lock are held here. The token is read
  -- only after the locked recheck below.
  FOR v_account IN SELECT u FROM unnest(v_accounts) AS u ORDER BY u
  LOOP
    v_binding_credential := public.meta_account_refresh_require_eligibility(
      p_user_id, v_account, v_operation);

    IF v_binding_credential IS NOT NULL THEN
      IF v_credential_id IS NULL THEN
        v_credential_id := v_binding_credential;
      ELSIF v_credential_id IS DISTINCT FROM v_binding_credential THEN
        RAISE EXCEPTION
          'every account of one shared User refresh must share one grant'
          USING ERRCODE = 'MAR03';
      END IF;
    END IF;
  END LOOP;

  IF v_operation = 'facebook_user_token' AND v_credential_id IS NULL THEN
    RAISE EXCEPTION
      'a shared Facebook User refresh needs a bound account'
      USING ERRCODE = 'MAR03';
  END IF;

  -- One membership document. The lock set and the expected member ids both
  -- come from this array. A second read before the locks would let a member
  -- appear in the comparison and stay out of the lock set.
  IF v_credential_id IS NOT NULL THEN
    v_credential_ids := ARRAY[v_credential_id];

    SELECT COALESCE(array_agg(b.social_account_id ORDER BY b.social_account_id),
                    ARRAY[]::UUID[])
      INTO v_member_accounts
      FROM public.facebook_user_credential_bindings AS b
     WHERE b.credential_id = v_credential_id
       AND b.user_id = p_user_id;
    v_before_members := ARRAY(
      SELECT u::TEXT
        FROM unnest(COALESCE(v_member_accounts, ARRAY[]::UUID[])) AS u
       ORDER BY u
    );
  END IF;

  -- Owner first, then the explicit targets plus the discovered members,
  -- then the credential. A member that appears only on a later read is not
  -- added here.
  PERFORM public.meta_account_refresh_lock_owner(p_user_id);

  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), ARRAY[]::UUID[])
    INTO v_lock_accounts
    FROM unnest(v_accounts || COALESCE(v_member_accounts, ARRAY[]::UUID[])) AS u;

  PERFORM public.meta_account_refresh_lock_scope(
    p_user_id, v_lock_accounts, v_credential_ids);

  IF v_credential_id IS NOT NULL THEN
    v_after_members := public.meta_oauth_attempt_live_grant_members(
      p_user_id, v_credential_id);
    IF v_before_members IS DISTINCT FROM v_after_members THEN
      RAISE EXCEPTION
        'the shared grant membership changed; retry the whole transaction'
        USING ERRCODE = 'MAR05';
    END IF;
  END IF;

  v_captured_at := clock_timestamp();
  -- The finite validity of one attempt. Thirty minutes is longer than any
  -- provider exchange this contract covers, and it is never extended.
  v_expires_at := v_captured_at + INTERVAL '30 minutes';
  v_lock_timeout := current_setting('lock_timeout');

  -- Under the locks, the live binding has to be the discovered credential
  -- and the explicit target has to be in the membership document. The
  -- returned id is not allowed to replace that credential.
  FOR v_account IN SELECT u FROM unnest(v_accounts) AS u ORDER BY u
  LOOP
    v_binding_credential := public.meta_account_refresh_require_discovered_grant(
      p_user_id, v_account, v_operation, v_credential_id, v_member_accounts);
    v_target := public.meta_account_refresh_capture_account(p_user_id, v_account);

    SELECT sa.access_token, sa.token_expires_at, sa.refresh_token
      INTO v_account_token, v_account_expires, v_account_refresh_token
      FROM public.social_accounts AS sa
     WHERE sa.id = v_account AND sa.user_id = p_user_id;

    v_targets := v_targets || jsonb_build_array(
      v_target || jsonb_build_object(
        'last_refresh_attempt_at', v_captured_at));

    -- The token material leaves on the service boundary only.
    IF v_operation = 'facebook_user_token' THEN
      v_tokens := v_tokens || jsonb_build_array(jsonb_build_object(
        'scope', 'account',
        'social_account_id', v_account,
        'credential_id', v_binding_credential,
        'credential_revision', NULL,
        'token', NULL,
        'token_expires_at', NULL,
        'refresh_token', NULL));
    ELSE
      v_tokens := v_tokens || jsonb_build_array(jsonb_build_object(
        'scope', 'account',
        'social_account_id', v_account,
        'credential_id', NULL,
        'credential_revision', NULL,
        'token', v_account_token,
        'token_expires_at', v_account_expires,
        'refresh_token', v_account_refresh_token));
    END IF;
  END LOOP;

  IF v_credential_id IS NOT NULL THEN
    v_members := public.meta_account_refresh_capture_members(
      p_user_id, v_credential_id);

    SELECT c.revision, c.provider_user_id, c.token, c.token_expires_at
      INTO v_credential_revision, v_credential_subject, v_credential_token,
           v_credential_expires
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential_id AND c.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the shared Facebook User credential is not owned by the given user'
        USING ERRCODE = 'MAR02';
    END IF;

    IF v_operation = 'facebook_user_token'
       AND (v_credential_token IS NULL OR btrim(v_credential_token) = '') THEN
      RAISE EXCEPTION
        'the shared Facebook User credential has no refresh material'
        USING ERRCODE = 'MAR03';
    END IF;

    v_credential := jsonb_build_object(
      'credential_id', v_credential_id,
      'revision', v_credential_revision,
      'provider_user_id', v_credential_subject,
      'token_expires_at', v_credential_expires);

    -- Only a User rotation returns the User secret. A bound Page account
    -- still captures that credential for its fence, and keeps its own
    -- operational token in v_tokens.
    IF v_operation = 'facebook_user_token' THEN
      v_tokens := jsonb_build_array(jsonb_build_object(
        'scope', 'credential',
        'social_account_id', NULL,
        'credential_id', v_credential_id,
        'credential_revision', v_credential_revision,
        'token', v_credential_token,
        'token_expires_at', v_credential_expires,
        'refresh_token', NULL));
    END IF;
  END IF;

  v_capture := jsonb_build_object(
    'capture_version', 1,
    'captured_at', v_captured_at,
    'expires_at', v_expires_at,
    'user_id', p_user_id,
    'operation', v_operation,
    'targets', v_targets,
    'credential', v_credential,
    'members', v_members);

  INSERT INTO public.meta_account_refresh_captures (
    user_id, capture_version, operation, status, captured_at, expires_at, capture
  ) VALUES (
    p_user_id, 1, v_operation, 'open', v_captured_at, v_expires_at, v_capture
  ) RETURNING id INTO v_capture_id;

  -- The newest attempt for an account wins. An older open capture of the
  -- same account is closed, so a late result of the previous attempt can no
  -- longer be committed.
  --
  -- The supersede may wait at most one second for another transaction's
  -- capture row. Writers take that row NOWAIT, so they do not form the
  -- other side of an unbounded wait. lock_timeout raises lock_not_available,
  -- which is MAR05. query_canceled is left alone: a statement timeout or an
  -- explicit cancel is not retryable contention. Begin already holds the
  -- account locks; the writer that holds this capture and then needs those
  -- accounts is refused NOWAIT rather than waited on.
  BEGIN
    PERFORM set_config('lock_timeout', '1s', true);
    UPDATE public.meta_account_refresh_captures AS c
       SET status = 'superseded'
     WHERE c.user_id = p_user_id
       AND c.id <> v_capture_id
       AND c.status = 'open'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(c.capture -> 'targets') = 'array'
                       THEN c.capture -> 'targets'
                       ELSE '[]'::JSONB END) AS e(value)
          WHERE (e.value ->> 'social_account_id')::UUID = ANY (v_accounts));
    PERFORM set_config('lock_timeout', v_lock_timeout, true);
  EXCEPTION
    WHEN lock_not_available THEN
      PERFORM set_config('lock_timeout', v_lock_timeout, true);
      RAISE EXCEPTION
        'a refresh capture of this owner is busy; retry the whole transaction'
        USING ERRCODE = 'MAR05';
  END;

  -- The attempt marker belongs to this transaction and to this capture.
  UPDATE public.social_accounts AS sa
     SET last_refresh_attempt_at = v_captured_at,
         updated_at = now()
   WHERE sa.id = ANY (v_accounts)
     AND sa.user_id = p_user_id;

  RETURN jsonb_build_object(
    'capture_id', v_capture_id,
    'capture_version', 1,
    'captured_at', v_captured_at,
    'expires_at', v_expires_at,
    'operation', v_operation,
    'capture', v_capture,
    'tokens', v_tokens,
    'attempt_marker', v_captured_at);
END;
$function$;

COMMENT ON FUNCTION public.begin_meta_account_refresh(UUID, JSONB) IS
  'Service-only. Captures the token material and the matching versioned '
  'authority of an explicit owned Meta account in one transaction, and '
  'records the attempt marker in that same transaction. The capture is '
  'stored, nonsecret and server-authored; the token material is returned on '
  'the service boundary only. Payload: {"accounts":[{"social_account_id":'
  '"...","operation":"direct_token|page_token|facebook_user_token"}]}. One '
  'operation per capture. direct_token and page_token name exactly one '
  'account. facebook_user_token may name several explicit targets of one '
  'grant. The returned token matches that operation: an account Page or '
  'direct token, or the shared User credential. SQLSTATE MAR01..MAR07.';

-- ---------------------------------------------------------------------------
-- 4. write_direct_instagram_account.
--
--    The direct-login writer. Its token stays in social_accounts. It refuses
--    a Facebook binding, refuses the OAuth-only lifecycle fields, and
--    advances the account's capability generation so an older job result
--    can no longer persist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_direct_instagram_account(
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
  v_target JSONB;
  v_account UUID;
  v_fields JSONB;
  v_expiry TIMESTAMPTZ;
  v_generation BIGINT;
  v_next_generation BIGINT;
  v_state JSONB;
BEGIN
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

  PERFORM public.meta_account_refresh_require_json(p_payload, 'operation', 'string');
  IF (p_payload ->> 'operation') IS DISTINCT FROM 'direct_token' THEN
    RAISE EXCEPTION
      'write_direct_instagram_account only writes a direct token'
      USING ERRCODE = 'MAR06';
  END IF;

  v_fields := public.meta_account_refresh_require_json(p_payload, 'fields', 'object');

  -- The field whitelist is exact. Anything else is refused before a lock is
  -- taken, so an unknown field can never reach the account row.
  FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
    IF v_key NOT IN ('access_token', 'token_expires_at', 'refresh_token') THEN
      RAISE EXCEPTION 'unsupported refresh field: %', v_key USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;
  IF NOT (v_fields ? 'access_token') THEN
    RAISE EXCEPTION 'access_token is required' USING ERRCODE = 'MAR01';
  END IF;

  PERFORM public.meta_account_refresh_lock_owner(p_user_id);

  v_capture := public.meta_account_refresh_load_capture(
    p_user_id, v_capture_id, 'direct_token');

  v_target := public.meta_account_refresh_capture_target(v_capture);
  v_account := public.meta_account_refresh_uuid(
    v_target ->> 'social_account_id', 'captured social_account_id');

  PERFORM public.meta_account_refresh_lock_scope(
    p_user_id, ARRAY[v_account], ARRAY[]::UUID[]);

  -- The capture lifetime is checked after the locks, against the live clock.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

  -- The captured authority must still be the live authority, and this is
  -- checked before any side effect.
  PERFORM public.meta_account_refresh_require_captured_account(p_user_id, v_target);

  IF (v_target ->> 'capability_login_kind') IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION
      'a direct refresh requires a direct capability classification'
      USING ERRCODE = 'MAR06';
  END IF;
  IF (v_target ->> 'binding_present')::BOOLEAN IS DISTINCT FROM false THEN
    RAISE EXCEPTION
      'a direct refresh refuses a Facebook user binding'
      USING ERRCODE = 'MAR06';
  END IF;

  -- The token validity is checked after the waits, with the live clock.
  IF v_fields ? 'token_expires_at'
     AND jsonb_typeof(v_fields -> 'token_expires_at') <> 'null' THEN
    v_expiry := public.meta_account_refresh_timestamp(
      v_fields ->> 'token_expires_at', 'token_expires_at');
    IF clock_timestamp() >= v_expiry THEN
      RAISE EXCEPTION
        'the supplied token expiry has already passed'
        USING ERRCODE = 'MAR07';
    END IF;
  END IF;

  PERFORM public.meta_account_refresh_apply_account_fields(
    p_user_id, v_account, v_fields);

  -- The account's own fence advances, so a job result captured before this
  -- write can no longer persist.
  v_generation := public.meta_account_refresh_uint(
    v_target -> 'capability_generation', 'capability_generation', true);
  v_next_generation := public.meta_account_refresh_advance_generation(
    p_user_id, v_account, v_generation, 'credential_refreshed');

  -- After the capability update, which can wait on the capability row.
  -- A refusal here rolls the token write and the generation back together.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);
  PERFORM public.meta_account_refresh_assert_known_expiries(v_fields);

  UPDATE public.meta_account_refresh_captures AS c
     SET status = 'completed'
   WHERE c.id = v_capture_id AND c.user_id = p_user_id;

  v_state := public.meta_account_refresh_account_state(p_user_id, v_account);

  RETURN jsonb_build_object(
    'capture_id', v_capture_id,
    'operation', 'direct_token',
    'applied', true,
    'credential_generation', v_next_generation,
    'account', v_state);
END;
$function$;

COMMENT ON FUNCTION public.write_direct_instagram_account(UUID, JSONB) IS
  'Service-only. Writes the refreshed token of a direct Instagram account '
  'from the capture taken by begin_meta_account_refresh. The token stays in '
  'social_accounts, the field whitelist is exact, needs_reauth is never '
  'written, and the capability generation advances so an older job result '
  'cannot persist. Payload: {"capture_id":"...","operation":"direct_token",'
  '"fields":{"access_token":"...","token_expires_at":"...","refresh_token":'
  '"..."}}. An omitted field is preserved, an explicit null clears it.';

-- ---------------------------------------------------------------------------
-- 5. write_meta_account_refresh_success.
--
--    The captured success for a page-linked operational token and for a
--    shared Facebook User grant.
--
--    The shared rotation is NOT delegated to the accepted
--    write_facebook_user_credential. That writer takes a caller-supplied
--    account list instead of the captured membership, and it does not advance
--    the Facebook connection fences that the accepted shared-rotation
--    contract requires. The accepted internal that does advance them is used
--    instead, and the captured membership is the only source.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_meta_account_refresh_success(
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
  v_operation TEXT;
  v_target JSONB;
  v_account UUID;
  v_accounts UUID[];
  v_fields JSONB;
  v_expiry TIMESTAMPTZ;
  v_generation BIGINT;
  v_next_generation BIGINT;
  v_state JSONB;
  v_credential JSONB;
  v_credential_id UUID;
  v_revision BIGINT;
  v_live_revision BIGINT;
  v_live_subject TEXT;
  v_token TEXT;
  v_members JSONB;
  v_member JSONB;
  v_states JSONB := '[]'::JSONB;
  v_binding_credential UUID;
  v_lock_accounts UUID[];
BEGIN
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

  PERFORM public.meta_account_refresh_require_json(p_payload, 'operation', 'string');
  v_operation := p_payload ->> 'operation';
  IF v_operation NOT IN ('page_token', 'facebook_user_token') THEN
    RAISE EXCEPTION
      'write_meta_account_refresh_success writes a page operational token or a '
      'shared Facebook User grant; a direct token uses write_direct_instagram_account'
      USING ERRCODE = 'MAR06';
  END IF;

  v_fields := public.meta_account_refresh_require_json(p_payload, 'fields', 'object');

  IF v_operation = 'page_token' THEN
    FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
      IF v_key NOT IN ('access_token', 'token_expires_at', 'refresh_token') THEN
        RAISE EXCEPTION 'unsupported refresh field: %', v_key USING ERRCODE = 'MAR01';
      END IF;
    END LOOP;
    IF NOT (v_fields ? 'access_token') THEN
      RAISE EXCEPTION 'access_token is required' USING ERRCODE = 'MAR01';
    END IF;
  ELSE
    FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
      IF v_key NOT IN ('token', 'token_expires_at') THEN
        RAISE EXCEPTION 'unsupported refresh field: %', v_key USING ERRCODE = 'MAR01';
      END IF;
    END LOOP;
    IF NOT (v_fields ? 'token') THEN
      RAISE EXCEPTION 'token is required' USING ERRCODE = 'MAR01';
    END IF;
  END IF;

  PERFORM public.meta_account_refresh_lock_owner(p_user_id);

  v_capture := public.meta_account_refresh_load_capture(
    p_user_id, v_capture_id, v_operation);

  v_members := v_capture -> 'members';

  IF v_operation = 'page_token' THEN
    v_target := public.meta_account_refresh_capture_target(v_capture);
    v_account := public.meta_account_refresh_uuid(
      v_target ->> 'social_account_id', 'captured social_account_id');
    v_accounts := ARRAY[v_account];
    v_binding_credential := (v_target ->> 'binding_credential_id')::UUID;

    PERFORM public.meta_account_refresh_lock_scope(
      p_user_id,
      v_accounts,
      CASE WHEN v_binding_credential IS NULL
           THEN ARRAY[]::UUID[]
           ELSE ARRAY[v_binding_credential] END);

    -- The capture lifetime is checked after the locks, against the live
    -- clock.
    PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

    PERFORM public.meta_account_refresh_require_captured_account(p_user_id, v_target);

    -- A page capture records the grant that owned the page. The live binding
    -- has to be that grant, and the page has to be one of its captured members.
    IF jsonb_typeof(v_capture -> 'credential') = 'object' THEN
      PERFORM public.meta_account_refresh_require_target_on_grant(
        p_user_id,
        public.meta_account_refresh_uuid(
          v_capture -> 'credential' ->> 'credential_id', 'captured credential_id'),
        v_members,
        v_target);
    END IF;

    IF (v_target ->> 'platform') = 'instagram' THEN
      IF (v_target ->> 'capability_login_kind') IS DISTINCT FROM 'page_linked' THEN
        RAISE EXCEPTION
          'a page operational refresh requires a page-linked capability classification'
          USING ERRCODE = 'MAR06';
      END IF;
    ELSIF (v_target ->> 'platform') = 'facebook' THEN
      IF (v_target ->> 'binding_present')::BOOLEAN IS DISTINCT FROM true THEN
        RAISE EXCEPTION
          'a Facebook Page operational refresh needs its captured connection binding'
          USING ERRCODE = 'MAR06';
      END IF;
    ELSE
      RAISE EXCEPTION
        'a page operational refresh needs an Instagram or Facebook Page account'
        USING ERRCODE = 'MAR06';
    END IF;

    PERFORM public.meta_account_refresh_assert_known_expiries(v_fields);

    PERFORM public.meta_account_refresh_apply_account_fields(
      p_user_id, v_account, v_fields);

    IF (v_target ->> 'platform') = 'instagram' THEN
      v_generation := public.meta_account_refresh_uint(
        v_target -> 'capability_generation', 'capability_generation', true);
      v_next_generation := public.meta_account_refresh_advance_generation(
        p_user_id, v_account, v_generation, 'credential_refreshed');
    ELSE
      -- Facebook Page authority is the connection fence, not an Instagram
      -- generation. The returned credential_generation stays null; the
      -- account state carries binding_connection_version.
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

    v_state := public.meta_account_refresh_account_state(p_user_id, v_account);
    v_states := jsonb_build_array(v_state);
  ELSE
    -- The shared User grant. The credential, its revision and the complete
    -- captured membership come from the capture, never from the caller.
    v_credential := v_capture -> 'credential';
    IF v_credential IS NULL OR jsonb_typeof(v_credential) <> 'object' THEN
      RAISE EXCEPTION
        'the captured shared grant is missing' USING ERRCODE = 'MAR04';
    END IF;
    v_credential_id := public.meta_account_refresh_uuid(
      v_credential ->> 'credential_id', 'captured credential_id');
    v_revision := public.meta_account_refresh_uint(
      v_credential -> 'revision', 'captured credential revision', false);

    SELECT COALESCE(array_agg(
             (e.value ->> 'social_account_id')::UUID
             ORDER BY (e.value ->> 'social_account_id')::UUID),
           ARRAY[]::UUID[])
      INTO v_accounts
      FROM jsonb_array_elements(COALESCE(v_members, '[]'::JSONB)) AS e(value);

    IF array_length(v_accounts, 1) IS NULL THEN
      RAISE EXCEPTION
        'the captured shared grant has no members' USING ERRCODE = 'MAR04';
    END IF;

    -- The lock set is the captured members plus every explicit target.
    -- It is not a live re-read, so a member added after the capture is not
    -- pulled in. A target that was left out of the member document is locked
    -- and then refused, rather than cleared without a lock.
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::UUID[])
      INTO v_lock_accounts
      FROM (
        SELECT unnest(v_accounts) AS x
        UNION
        SELECT (e.value ->> 'social_account_id')::UUID
          FROM jsonb_array_elements(
                 public.meta_account_refresh_capture_targets(v_capture)) AS e(value)
      ) AS ids
     WHERE x IS NOT NULL;

    PERFORM public.meta_account_refresh_lock_scope(
      p_user_id, v_lock_accounts, ARRAY[v_credential_id]);

    -- The capture lifetime is checked after the locks, against the live
    -- clock.
    PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

    -- The membership, the revision and the subject must still match.
    -- Every explicit target must belong to this credential and this member
    -- set, then the complete account validator checks identity, binding,
    -- fence, capability, health and expiry.
    PERFORM public.meta_account_refresh_require_members(
      p_user_id, v_credential_id, v_members);

    FOR v_target IN
      SELECT e.value
        FROM jsonb_array_elements(
               public.meta_account_refresh_capture_targets(v_capture)) AS e(value)
    LOOP
      PERFORM public.meta_account_refresh_require_target_on_grant(
        p_user_id, v_credential_id, v_members, v_target);
      PERFORM public.meta_account_refresh_require_captured_account(
        p_user_id, v_target);
    END LOOP;

    SELECT c.revision, c.provider_user_id
      INTO v_live_revision, v_live_subject
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential_id AND c.user_id = p_user_id;
    IF NOT FOUND
       OR v_live_revision IS DISTINCT FROM v_revision
       OR v_live_subject IS DISTINCT FROM (v_credential ->> 'provider_user_id') THEN
      RAISE EXCEPTION
        'the captured shared grant no longer matches the live credential'
        USING ERRCODE = 'MAR04';
    END IF;

    IF v_fields ? 'token_expires_at'
       AND jsonb_typeof(v_fields -> 'token_expires_at') <> 'null' THEN
      v_expiry := public.meta_account_refresh_timestamp(
        v_fields ->> 'token_expires_at', 'token_expires_at');
      IF clock_timestamp() >= v_expiry THEN
        RAISE EXCEPTION
          'the supplied token expiry has already passed'
          USING ERRCODE = 'MAR07';
      END IF;
    END IF;

    IF jsonb_typeof(v_fields -> 'token') <> 'string'
       OR btrim(v_fields ->> 'token') = ''
       OR char_length(v_fields ->> 'token') > 4096 THEN
      RAISE EXCEPTION
        'token must be a non-empty string of at most 4096 characters'
        USING ERRCODE = 'MAR01';
    END IF;
    v_token := v_fields ->> 'token';

    -- The shared secret rotates once, with its revision.
    UPDATE public.facebook_user_credentials AS c
       SET token = v_token,
           token_expires_at = CASE
             WHEN v_fields ? 'token_expires_at'
               THEN public.meta_account_refresh_timestamp(
                      v_fields ->> 'token_expires_at', 'token_expires_at')
             ELSE c.token_expires_at
           END,
           revision = c.revision + 1,
           provenance_source = 'token_refresh',
           provenance_captured_at = clock_timestamp(),
           updated_at = now()
     WHERE c.id = v_credential_id
       AND c.user_id = p_user_id
       AND c.revision = v_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the captured shared grant revision no longer matches'
        USING ERRCODE = 'MAR04';
    END IF;

    -- Every captured member of the grant is fenced. Failure evidence is
    -- reset only on the explicit targets. Siblings keep their health, and
    -- needs_reauth is never cleared here.
    PERFORM public.meta_account_refresh_fence_members(
      p_user_id, v_members, 'credential_refreshed');

    FOR v_target IN
      SELECT e.value
        FROM jsonb_array_elements(
               public.meta_account_refresh_capture_targets(v_capture)) AS e(value)
    LOOP
      PERFORM public.meta_account_refresh_clear_failure_evidence(
        p_user_id,
        public.meta_account_refresh_uuid(
          v_target ->> 'social_account_id', 'captured social_account_id'));
    END LOOP;

    FOR v_member IN
      SELECT e.value FROM jsonb_array_elements(v_members) AS e(value)
    LOOP
      v_states := v_states || jsonb_build_array(
        public.meta_account_refresh_account_state(
          p_user_id,
          public.meta_account_refresh_uuid(
            v_member ->> 'social_account_id',
            'captured member social_account_id')));
    END LOOP;

    v_next_generation := NULL;
  END IF;

  -- After capability, binding and member-fence updates, any of which can
  -- wait. A refusal rolls tokens, health, fences and this capture back
  -- together. Omitted and explicit-null expiries are not known expiries.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);
  PERFORM public.meta_account_refresh_assert_known_expiries(v_fields);

  UPDATE public.meta_account_refresh_captures AS c
     SET status = 'completed'
   WHERE c.id = v_capture_id AND c.user_id = p_user_id;

  RETURN jsonb_build_object(
    'capture_id', v_capture_id,
    'operation', v_operation,
    'applied', true,
    'credential_generation', v_next_generation,
    'accounts', v_states);
END;
$function$;

COMMENT ON FUNCTION public.write_meta_account_refresh_success(UUID, JSONB) IS
  'Service-only. Writes one captured page operational token, for an Instagram '
  'page-linked account or an owned Facebook Page, or rotates one shared '
  'Facebook User grant. The Page token stays on social_accounts and a '
  'Facebook Page advances its connection fence instead of an Instagram '
  'generation. A shared rotation replaces the User secret once, fences every '
  'captured member, and resets failure evidence only on the explicit targets. '
  'Every explicit target must belong to that captured credential and member '
  'set. '
  'needs_reauth is never cleared. Payload: {"capture_id":"...","operation":'
  '"page_token|facebook_user_token","fields":{...}}. An omitted field is '
  'preserved, an explicit null clears it.';

-- ---------------------------------------------------------------------------
-- 6. record_meta_refresh_failure.
--
--    The captured failure. It validates the captured authority before any
--    side effect, advances the applicable fence WITHOUT setting
--    needs_reauth, and then calls the existing partner_record_refresh_failure
--    so the health columns, the alert marker, the false -> true transition
--    and the partner delivery enqueue stay in one transaction with the fence
--    advance.
--
--    The existing function is called, not reimplemented: its unrelated
--    platform callers keep their exact behaviour, and its event semantics are
--    the accepted ones.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_meta_refresh_failure(
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
  v_target JSONB;
  v_account UUID;
  v_category TEXT;
  v_policy JSONB;
  v_failure_count INTEGER;
  v_new_count INTEGER;
  v_escalate BOOLEAN;
  v_alert_at TIMESTAMPTZ := NULL;
  v_alert_due BOOLEAN;
  v_snoozed BOOLEAN;
  v_last_alert TIMESTAMPTZ;
  v_outcome JSONB;
  v_workspace UUID;
  v_workspace_after UUID;
  v_generation BIGINT;
  v_capability_present BOOLEAN;
  v_credential JSONB;
  v_credential_id UUID;
  v_revision BIGINT;
  v_live_revision BIGINT;
  v_live_subject TEXT;
  v_state JSONB;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MAR01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MAR01';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('capture_id', 'social_account_id', 'error_category') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MAR01';
    END IF;
  END LOOP;

  PERFORM public.meta_account_refresh_require_json(p_payload, 'capture_id', 'string');
  v_capture_id := public.meta_account_refresh_uuid(
    p_payload ->> 'capture_id', 'capture_id');

  PERFORM public.meta_account_refresh_require_json(
    p_payload, 'social_account_id', 'string');
  v_account := public.meta_account_refresh_uuid(
    p_payload ->> 'social_account_id', 'social_account_id');

  PERFORM public.meta_account_refresh_require_json(
    p_payload, 'error_category', 'string');
  v_category := p_payload ->> 'error_category';
  v_policy := public.meta_account_refresh_error_policy(v_category);

  PERFORM public.meta_account_refresh_lock_owner(p_user_id);

  -- The request's capture, account and category are already present and
  -- typed. Only then may a failure load whichever operation the capture
  -- describes. Success writers never pass NULL here.
  v_capture := public.meta_account_refresh_load_capture(
    p_user_id, v_capture_id, NULL);

  SELECT e.value INTO v_target
    FROM jsonb_array_elements(
           public.meta_account_refresh_capture_targets(v_capture)) AS e(value)
   WHERE (e.value ->> 'social_account_id')::UUID = v_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the failing account % is not one of the captured accounts', v_account
      USING ERRCODE = 'MAR02';
  END IF;

  v_credential := v_capture -> 'credential';
  IF v_credential IS NOT NULL AND jsonb_typeof(v_credential) = 'object' THEN
    v_credential_id := public.meta_account_refresh_uuid(
      v_credential ->> 'credential_id', 'captured credential_id');
    v_revision := public.meta_account_refresh_uint(
      v_credential -> 'revision', 'captured credential revision', false);
  END IF;

  PERFORM public.meta_account_refresh_lock_scope(
    p_user_id,
    ARRAY[v_account],
    CASE WHEN v_credential_id IS NULL
         THEN ARRAY[]::UUID[]
         ELSE ARRAY[v_credential_id] END);

  -- The capture lifetime is checked after the locks, against the live clock.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

  -- The captured authority is validated before any side effect. A stale
  -- failure produces no health change, no fence advance, no event and no
  -- alert marker.
  PERFORM public.meta_account_refresh_require_captured_account(p_user_id, v_target);

  -- A shared grant that already rotated is not the grant this attempt
  -- failed on.
  IF v_credential_id IS NOT NULL THEN
    SELECT c.revision, c.provider_user_id
      INTO v_live_revision, v_live_subject
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_credential_id AND c.user_id = p_user_id;
    IF NOT FOUND
       OR v_live_revision IS DISTINCT FROM v_revision
       OR v_live_subject IS DISTINCT FROM (v_credential ->> 'provider_user_id') THEN
      RAISE EXCEPTION
        'the captured shared grant no longer matches the live credential'
        USING ERRCODE = 'MAR04';
    END IF;
  END IF;

  -- The applicable fence advances first, and it does NOT set needs_reauth.
  SELECT c.credential_generation INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_account AND c.user_id = p_user_id;
  v_capability_present := FOUND;

  IF v_capability_present THEN
    PERFORM public.meta_account_refresh_advance_generation(
      p_user_id, v_account, v_generation, 'credential_refresh_failed');
  ELSIF (v_target ->> 'binding_present')::BOOLEAN IS TRUE THEN
    BEGIN
      PERFORM public.facebook_user_credential_commit_connection_version(
        p_user_id, v_account,
        (v_target ->> 'binding_connection_version')::BIGINT);
    EXCEPTION
      WHEN SQLSTATE 'FUC01' THEN
        RAISE EXCEPTION
          'the captured connection fence no longer matches'
          USING ERRCODE = 'MAR04';
    END;
  END IF;

  -- The failure policy is derived from the captured failure count, not from
  -- a live re-read, so the count cannot jump.
  v_failure_count := (v_target ->> 'failure_count')::INTEGER;
  IF (v_policy ->> 'counts')::BOOLEAN THEN
    v_new_count := v_failure_count + 1;
  ELSE
    v_new_count := v_failure_count;
  END IF;

  -- The escalation. A permanent failure latches at once. A transient failure
  -- never latches: an unreachable provider is not evidence against a grant.
  IF (v_policy ->> 'latches')::BOOLEAN THEN
    v_escalate := true;
  ELSIF (v_policy ->> 'kind') = 'transient' THEN
    v_escalate := false;
  ELSE
    v_escalate := (v_new_count >= 3);
  END IF;

  -- The alert marker. A snoozed account is never marked, and the cooldown
  -- is the accepted twenty-four hours.
  SELECT sa.alerts_snoozed, sa.last_alert_sent_at
    INTO v_snoozed, v_last_alert
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account AND sa.user_id = p_user_id;

  v_alert_due := NOT COALESCE(v_snoozed, false)
    AND (
      v_last_alert IS NULL
      OR clock_timestamp() - v_last_alert > INTERVAL '24 hours'
    );
  IF v_escalate AND v_alert_due THEN
    v_alert_at := clock_timestamp();
  END IF;

  -- The workspace of the account, resolved before the subscription lock and
  -- rechecked after it. The outbox row's foreign key parent is
  -- partner_webhooks, so that parent is locked before the insert. A
  -- workspace or subscription delete therefore becomes a bounded refusal
  -- instead of a deadlock.
  SELECT coalesce(
           sa.workspace_id,
           (SELECT w.id FROM public.workspaces AS w
             WHERE w.owner_id = sa.user_id AND w.is_personal LIMIT 1))
    INTO v_workspace
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account AND sa.user_id = p_user_id;

  PERFORM public.meta_account_refresh_lock_subscriptions(v_workspace);

  SELECT coalesce(
           sa.workspace_id,
           (SELECT w.id FROM public.workspaces AS w
             WHERE w.owner_id = sa.user_id AND w.is_personal LIMIT 1))
    INTO v_workspace_after
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account AND sa.user_id = p_user_id;

  IF v_workspace IS DISTINCT FROM v_workspace_after THEN
    RAISE EXCEPTION
      'the workspace of the failing account changed; retry the whole transaction'
      USING ERRCODE = 'MAR05';
  END IF;

  -- The accepted failure body. It performs the health mutation and the
  -- event enqueue together, and it only ever SETS needs_reauth.
  v_outcome := public.partner_record_refresh_failure(
    v_account,
    v_new_count,
    v_category,
    v_escalate,
    v_alert_at);

  -- After the generation or binding update and after the outbox insert,
  -- both of which can wait. A deadline that passed during either wait
  -- refuses the whole transition: health, fence, alert marker, outbox and
  -- capture status.
  PERFORM public.meta_account_refresh_assert_capture_live(v_capture_id);

  UPDATE public.meta_account_refresh_captures AS c
     SET status = 'failed'
   WHERE c.id = v_capture_id AND c.user_id = p_user_id;

  v_state := public.meta_account_refresh_account_state(p_user_id, v_account);

  RETURN v_outcome || jsonb_build_object(
    'capture_id', v_capture_id,
    'applied', true,
    'error_category', v_category,
    'failure_count', v_new_count,
    'escalated', v_escalate,
    'alert_marker_written', (v_alert_at IS NOT NULL),
    'account', v_state);
END;
$function$;

COMMENT ON FUNCTION public.record_meta_refresh_failure(UUID, JSONB) IS
  'Service-only. Records the captured failure of a Meta refresh. The captured '
  'authority is validated before any side effect; the applicable fence '
  'advances without setting needs_reauth; then the existing '
  'partner_record_refresh_failure performs the health mutation, the alert '
  'marker, the false -> true transition and the partner delivery enqueue in '
  'the same transaction. The error surface is a stable category, never a '
  'provider message. Payload: {"capture_id":"...","social_account_id":"...",'
  '"error_category":"..."}.';

-- ---------------------------------------------------------------------------
-- 7. Privileges.
--
--     The stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--     anon, authenticated, so every REVOKE below is load-bearing. The new
--     relation is service-only, has RLS and has no policy at all. The
--     helpers are SECURITY INVOKER and reachable by their owner only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.meta_account_refresh_captures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.meta_account_refresh_captures FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meta_account_refresh_captures FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.meta_account_refresh_captures TO service_role;

REVOKE ALL ON FUNCTION public.meta_account_refresh_lock_owner(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_lock_scope(UUID, UUID[], UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_lock_subscriptions(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_uuid(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_timestamp(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_uint(JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_error_policy(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_json(JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_assert_known_expiries(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_eligibility(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_discovered_grant(UUID, UUID, TEXT, UUID, UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_clear_failure_evidence(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_capture_account(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_capture_members(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_members(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_target_on_grant(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_require_captured_account(UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_apply_account_fields(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_advance_generation(UUID, UUID, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_fence_members(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_load_capture(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_assert_capture_live(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_capture_targets(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_capture_target(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_account_refresh_account_state(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.meta_account_refresh_lock_owner(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_lock_scope(UUID, UUID[], UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_lock_subscriptions(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_uuid(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_timestamp(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_uint(JSONB, TEXT, BOOLEAN) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_error_policy(TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_json(JSONB, TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_assert_known_expiries(JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_eligibility(UUID, UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_discovered_grant(UUID, UUID, TEXT, UUID, UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_clear_failure_evidence(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_capture_account(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_capture_members(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_members(UUID, UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_target_on_grant(UUID, UUID, JSONB, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_require_captured_account(UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_apply_account_fields(UUID, UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_advance_generation(UUID, UUID, BIGINT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_fence_members(UUID, JSONB, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_load_capture(UUID, UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_assert_capture_live(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_capture_targets(JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_capture_target(JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_account_refresh_account_state(UUID, UUID) TO CURRENT_USER;

-- The accepted Phase 1 and prerequisite 2 internals this contract reuses.
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_parse_zoned_timestamp(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_parse_uint(JSONB, TEXT, BOOLEAN) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_commit_connection_version(UUID, UUID, BIGINT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_capture_account(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_live_grant_members(UUID, UUID) TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.begin_meta_account_refresh(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_direct_instagram_account(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_meta_account_refresh_success(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_meta_refresh_failure(UUID, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_meta_account_refresh(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_direct_instagram_account(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_meta_account_refresh_success(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_meta_refresh_failure(UUID, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Assert the boundary this migration claims, before it commits.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
DECLARE
  p_name TEXT;
  f_sig regprocedure;
  v_helper RECORD;
BEGIN
  ASSERT (
    SELECT c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'meta_account_refresh_captures'
  ), 'RLS is enabled on public.meta_account_refresh_captures';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'meta_account_refresh_captures'
  ), 'no browser policy exists on public.meta_account_refresh_captures';

  FOREACH p_name IN ARRAY ARRAY[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
    'TRIGGER', 'MAINTAIN'
  ] LOOP
    ASSERT NOT has_table_privilege('anon', 'public.meta_account_refresh_captures', p_name),
      format('anon holds no %s privilege on public.meta_account_refresh_captures', p_name);
    ASSERT NOT has_table_privilege('authenticated', 'public.meta_account_refresh_captures', p_name),
      format('authenticated holds no %s privilege on public.meta_account_refresh_captures', p_name);
  END LOOP;

  FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    ASSERT has_table_privilege('service_role', 'public.meta_account_refresh_captures', p_name),
      format('service_role keeps %s on public.meta_account_refresh_captures', p_name);
  END LOOP;

  -- The capture relation holds no secret column.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'meta_account_refresh_captures'
       AND column_name IN (
         'token', 'access_token', 'refresh_token', 'secret', 'provider_response'
       )
  ), 'the capture relation holds no secret column';

  -- The public RPC surface is service-only.
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

  -- No browser-reachable SECURITY DEFINER function reaches the new relation
  -- besides the four service-only RPCs.
  FOR f_sig IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prosrc ILIKE '%meta_account_refresh_captures%'
       AND p.proname NOT IN (
         'begin_meta_account_refresh', 'write_direct_instagram_account',
         'write_meta_account_refresh_success', 'record_meta_refresh_failure'
       )
  LOOP
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('anon may not execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('authenticated may not execute %s', f_sig);
  END LOOP;

  -- The helpers stay SECURITY INVOKER and owner-only.
  FOR v_helper IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef AS prosecdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'meta\_account\_refresh\_%'
       AND p.proname NOT IN (
         'begin_meta_account_refresh', 'write_direct_instagram_account',
         'write_meta_account_refresh_success', 'record_meta_refresh_failure'
       )
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

  RAISE NOTICE
    'meta account refresh lifecycle: verified. The capture relation is '
    'service-only with RLS and no policy, it holds no secret column, the four '
    'lifecycle RPCs are service-only, and every helper is SECURITY INVOKER and '
    'owner-only.';
END
$assert_boundary$;

COMMIT;
