-- ===========================================================================
-- Captured Meta OAuth attempts and transactional selection commits.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   §14 "Phase 2 lifecycle prerequisites", prerequisite 2, and the accepted
--   read-only design at advisor consultation 14
--   ("Ordered implementation slices", slice 2: "Attempt capture and OAuth
--   completion: one coherent initial SQL task covering capture, claims,
--   absence fencing, create/reactivate/rebind and per-selection receipts").
--
-- APPLY AS supabase_admin. It is the migration role on this stack and the
-- superuser of the self-hosted image. postgres is NOT a superuser here, and a
-- REVOKE issued by a non-owner is a WARNING that changes nothing, so the
-- role this runs as is load-bearing.
--
-- ===========================================================================
--
-- WHAT THIS MIGRATION FIXES
--
-- The accepted Phase 1 contract can bind a Facebook User credential to an
-- owned account and can replace a credential's token, but it cannot capture
-- anything BEFORE the provider authorization. Two proven gaps follow:
--
--   1. `bind_facebook_user_credential` with `expected_absent` checks only
--      that no binding exists RIGHT NOW. It does not remember that the
--      account was unbound when the caller captured its intent. A bind ->
--      detach cycle by another attempt therefore makes an old "absent"
--      capture valid again. Measured on the accepted candidate: an
--      originally absent binding, followed by another bind and a properly
--      fenced detach, ACCEPTED the old absent bind.
--      (External evidence: instagram-phase2-preflight-probes.sql.)
--
--   2. Nothing binds an authorization attempt to a nonce, a deadline or a
--      claim, so a duplicate provider callback can reach a second token
--      exchange, and a delayed picker action can adopt authority that was
--      read AFTER the provider call.
--
-- This migration adds the pre-authorization capture and the transactional
-- completion that the accepted contract is missing. It does NOT replace any
-- accepted Phase 1 function, and it does not weaken any of them.
--
-- ===========================================================================
--
-- THE MODEL
--
--   meta_oauth_attempts                one nonsecret, service-only row per
--                                      authorization attempt
--   meta_oauth_attempt_receipts        one nonsecret row per committed
--                                      selection
--   oauth_pending_*_selections         the EXISTING temporary secret stash,
--                                      reused, now carrying a nullable
--                                      owner-matching attempt reference
--
-- An attempt row holds NO secret. It holds a nonce DIGEST, an immutable
-- versioned capture of the authority that existed BEFORE the provider was
-- contacted, server-controlled deadlines, a claim token, and the authority
-- this attempt's own commits returned.
--
-- The lifecycle is four service-only RPCs:
--
--   begin_meta_oauth_attempt      validate ownership, capture coherent
--                                  authority BEFORE authorization, mint a
--                                  nonce, return the material for a
--                                  server-authored signed state
--   claim_meta_oauth_callback      atomically claim one unexpired, unclaimed
--                                  attempt by owner/flow/nonce, BEFORE the
--                                  provider token exchange
--   complete_meta_oauth_callback   require the exact claim, validate the
--                                  service-provided verified candidates, and
--                                  persist the pending stash ONCE
--   commit_meta_oauth_selection    consume ONE verified candidate from that
--                                  stash and apply the whole account
--                                  transition in ONE transaction
--
-- plus read_meta_oauth_attempt, a nonsecret reader for the picker that
-- returns each candidate with its stable selection key.
--
-- The signed state carries the attempt id, the nonce and the flow. It does
-- NOT carry a token, a version or a browser-authored field: the signed state
-- is AUTHENTICATION, not authority. The authority is what SQL captured.
--
-- ===========================================================================
--
-- IMMUTABLE CAPTURE vs ATTEMPT-LOCAL PROGRESSION
--
-- `capture` is written once, before authorization, and can never change
-- afterwards. A BEFORE UPDATE trigger refuses any change to it, to the
-- nonce digest, to the flow, to the intent, to the owner or to the captured
-- account references.
--
-- `authority_progression` is the SEPARATE record of what this attempt's own
-- successful commits returned. A later selection of the same attempt may
-- use ONLY that progression and the immutable capture. It may never adopt a
-- freshly read live version: re-reading the live credential after the
-- provider call is exactly the authority adoption this slice removes.
--
-- Concretely: the first successful selection of an attempt may create the
-- shared Facebook User credential, or rotate the grant it captured. That
-- commit advances the source account's revision, generation and fence.
-- The second selection of the SAME attempt reuses the credential and the
-- member versions the first selection stored in the progression. The
-- source's owner, platform and provider identity stay the original
-- capture. A target or linked account this attempt has not committed is
-- still checked against its original capture, including an absence fence.
-- Neither selection re-reads a live version to adopt it. An outside
-- change to the progressed source or to any other member still refuses.
--
-- ===========================================================================
--
-- ABSENCE FENCING (THE ABA THIS CLOSES)
--
-- The capture of an account records BOTH:
--
--   * whether a binding exists, and
--   * the SURVIVING connection-fence high-water mark for that account.
--
-- The fence row survives an unbind (the delete trigger advances it), so a
-- deleted binding never resets its high-water mark. A never-created fence
-- is an explicit sentinel: fence_state='never_created',
-- fence_connection_version=0.
--
-- At commit, under the account lock, BOTH must still match the capture:
--
--   captured binding absent + live binding absent      -> still absent
--   captured fence version 0 (never created)           -> live fence must
--                                                          still be absent
--   captured fence version N                           -> live fence must
--                                                          still be N
--
-- So an intervening bind -> detach by another attempt advances the fence and
-- the old absence capture is refused. The nonce additionally prevents the
-- same attempt from being replayed.
--
-- ===========================================================================
--
-- THE SUPPORTED FLOWS, EXACTLY
--
--   instagram_page_linked   The Instagram-via-Facebook-Business flow. The
--                            Meta User token becomes the shared Facebook
--                            User credential; the Page token becomes the
--                            account's operational token; the account is
--                            bound to the credential with the verified
--                            Page -> Instagram relationship. Several
--                            Instagram accounts may be selected from one
--                            stash, exactly as the existing picker
--                            supports.
--
--   instagram_direct        The Instagram Business Login flow. The account
--                            holds its own long-lived Instagram token and
--                            is NEVER given a Facebook User credential and
--                            NEVER bound to one. A standalone or direct
--                            token can never masquerade as a Facebook
--                            grant.
--
--   facebook_page           Facebook Page connect. A candidate is page_only
--                            or page_plus_ig. The Page token is the
--                            operational token on social_accounts, exactly
--                            as a Page or direct token already lives there.
--                            The Facebook User token is the accepted shared
--                            credential. Both are stashed in the EXISTING
--                            service-only Instagram pending row, tagged by
--                            candidate_kind. They are never written to
--                            oauth_pending_facebook_selections.pages_json,
--                            which the legacy Facebook picker projects
--                            verbatim.
--
-- `begin_meta_oauth_attempt` refuses every other flow with MOA02.
--
-- Page-plus-IG is one selection under one grant: both accounts, both
-- bindings, both fences and one receipt commit together or not at all.
-- A direct token never creates a Facebook User credential.
--
-- Rebind is an explicit intent. A different verified Facebook subject is
-- applied only to the captured target (and the captured linked target).
-- The old grant's other members, token and fences stay. An unrelated
-- credential is never adopted because its provider subject matches.
--
-- TOKEN EXPIRY ANCHORS (service-owned, written by complete, read by commit)
--
--   grant_token_expires_at    absolute Facebook User credential expiry,
--                              anchored at complete_meta_oauth_callback
--   page_token_expires_at     absolute Page operational-token expiry
--   direct_token_expires_at   absolute direct Instagram account expiry
--
-- An absolute *_expires_at on the stash wins. Otherwise a matching
-- *_expires_in (or the legacy stash expires_in) is added to the complete
-- call's clock_timestamp() once, and that absolute instant is what commit
-- stores. Commit never adds a TTL to selection time. Unknown expiry is
-- JSON null and is stored as NULL. A token that is already past at
-- selection is refused. The legacy expires_in on a page-linked or Page
-- flow anchors the User credential only, never the Page token.
--
-- LATER TYPESCRIPT RULE, NOT DONE BY THIS SQL: a legacy service writer
-- must reject a pending row whose meta_oauth_attempt_id is not null
-- BEFORE any provider call or account mutation, in every mode. The
-- pending UPDATE/DELETE guard does not see a legacy SELECT followed by
-- an account upsert.
--
-- The ORDINARY direct Instagram REFRESH writer, and the coherent
-- refresh-begin / refresh-failure wrapper, are slice 3 and are NOT here.
-- This slice owns the OAuth CONNECT transitions only. Nothing in this
-- migration grants a refresh path access to `is_active`, to profile
-- assignment or to the login classification.
--
-- ===========================================================================
--
-- THE FIELD WHITELIST
--
-- `commit_meta_oauth_selection` writes exactly these account fields:
--
--   platform_username     from the verified candidate, when it carries one
--   avatar_url            from the verified candidate, when it carries one
--   access_token          the verified candidate's operational token
--   token_expires_at      the stash lifetime
--   is_active             TRUE (this is a connect or a reactivation)
--   social_profile_id     the attempt's intended profile, when it has one
--   needs_reauth          FALSE (a completed connect clears the health flag)
--   failure_count         0
--   last_refresh_error    NULL
--   ig_auth_type          the legacy display classification
--   connected_at          set on CREATE only; preserved on an update
--
-- An omitted optional value is PRESERVED, never erased. `account_metadata`
-- is NEVER written by this contract: there is no browser-controlled JSON
-- authority and no metadata replacement. `user_id`, `platform` and
-- `platform_user_id` are immutable through a reconnect and are never
-- written. `refresh_token`, `workspace_id`, `connection_mode`,
-- `alerts_snoozed` and `last_alert_sent_at` are never written.
--
-- The AUTHORITATIVE login classification is
-- `instagram_account_capabilities.login_kind`, not the legacy
-- `social_accounts.ig_auth_type` column, which an account owner can edit
-- from the browser. `ig_auth_type` is written for display only.
--
-- ===========================================================================
--
-- THE LOCK ORDER
--
--   1. The attempt row, FOR UPDATE. Safe to take first: no accepted
--      credential, capability or job writer ever acquires an attempt.
--   2. The owner row in auth.users, FOR KEY SHARE, NOWAIT. Callback
--      completion and selection commit both do this while they hold the
--      attempt, because the pending insert and the credential insert
--      reference the owner. A user delete holds that row and then cascades
--      into the attempt. Waiting would be the 40P01 cycle. MOA09 asks the
--      caller to retry the whole transaction.
--   3. The intended social profile, FOR KEY SHARE, NOWAIT, when the attempt
--      has one. Same parent-before-child reason as the owner.
--   4. Every captured account, FOR UPDATE NOWAIT, in id order. The set is
--      the explicit target, the linked target, the source and the captured
--      or progressed grant members. A busy row is MOA09. This includes a
--      plain holder. It does not inspect pg_stat_activity, query text, or
--      whether the holder is a DELETE. There is no timed retry and no
--      deadlock handler standing in for prevention.
--   5. The accepted helper `facebook_user_credential_lock_scope` then takes
--      its guard, capability advisory and credential locks. Its own order
--      remains the authority for those locks.
--   6. The membership is RECHECKED under those locks. A membership that
--      grew or shrank is a refusal, not a reason to expand the lock set
--      halfway through the transaction.
--
-- No job or watchlist lock is ever taken from these writers.
--
-- Deadlines are validated against `clock_timestamp()` AFTER every relevant
-- lock wait and immediately before the first secret or account mutation. An
-- expiry checked at transaction start is not sufficient, because a commit
-- can wait behind another writer for longer than its own deadline.
--
-- ===========================================================================
--
-- REFUSALS
--
-- Every refusal raises, so the whole transaction rolls back and a refused,
-- stale or expired path leaves ZERO account, secret, fence and receipt
-- changes. The SQLSTATEs are stable and nonsecret:
--
--   MOA01  malformed payload, unsupported key, malformed identity
--   MOA02  not found, not owned, or an unsupported flow
--   MOA03  wrong attempt state, missing stash, unknown selection key
--   MOA04  a pending row that belongs to an attempt was touched by
--          something other than that attempt
--   MOA05  natural-key conflict: RECONNECT_REQUIRED, never an adoption
--   MOA06  a conflicting replay of an already committed selection
--   MOA07  the captured authority no longer matches the live authority
--   MOA08  the picker, the stash, or a known absolute token expiry has passed
--   MOA09  lock contention: retry the whole transaction
--
-- A failed read is never treated as an absence. Every read that decides
-- something is a read whose failure aborts the transaction.
--
-- ===========================================================================
--
-- RETENTION
--
-- Nothing here adds a scheduler. The pending stash keeps its own bounded
-- expiry (the attempt's picker deadline, written once and never renewed),
-- and the attempt carries its own bounded callback deadline. Expired rows
-- are inert: every RPC refuses them on the live clock. Cleanup is the
-- existing sweep pattern -- the one-shot DELETE in the pending-selection
-- scripts -- plus the attempt's own cleanup when its last selection is
-- committed. An operator-run sweep of `meta_oauth_attempts` may be added
-- later as a separate, explicitly scheduled migration; this slice does not
-- add one.
--
-- ROLLBACK
--
-- The rollback is not "drop the column". Reverting this file removes the
-- attempt tables, the attempt references and the guard trigger, and leaves
-- the legacy pending writers exactly as they were. The pending tables keep
-- their data; the appended column is nullable, so legacy rows are
-- unaffected either way.
--
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preconditions. Fail closed: a missing pending table or a missing
--    accepted Phase 1 relation means this contract would silently not apply
--    to the rows it is supposed to protect.
-- ---------------------------------------------------------------------------
DO $precondition$
DECLARE
  t_name text;
BEGIN
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections',
    'facebook_user_credentials',
    'facebook_user_credential_bindings',
    'facebook_user_credential_connection_fences',
    'instagram_account_capabilities',
    'instagram_account_credentials',
    'social_accounts',
    'social_profiles'
  ] LOOP
    IF to_regclass(format('public.%I', t_name)) IS NULL THEN
      RAISE EXCEPTION
        'meta oauth attempt lifecycle: public.% does not exist. Refusing to continue:'
        ' the attempt contract is defined against this relation and would not apply to it.',
        t_name
        USING ERRCODE = 'undefined_table';
    END IF;
  END LOOP;

  IF to_regprocedure('public.facebook_user_credential_lock_scope(uuid[], uuid[])') IS NULL THEN
    RAISE EXCEPTION
      'meta oauth attempt lifecycle: public.facebook_user_credential_lock_scope(uuid[], uuid[]) is missing.'
      ' Apply migration 20261026140000_facebook_user_credential_bindings.sql first: this contract'
      ' reuses that helper for its lock ordering.'
      USING ERRCODE = 'undefined_function';
  END IF;

  IF to_regprocedure('public.facebook_user_credential_allocate_connection_version(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public.facebook_user_credential_commit_connection_version(uuid, uuid, bigint)') IS NULL
     OR to_regprocedure('public.facebook_user_credential_sync_instagram_linkage(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION
      'meta oauth attempt lifecycle: an accepted Phase 1 credential helper is missing.'
      ' Apply migration 20261026140000_facebook_user_credential_bindings.sql first.'
      USING ERRCODE = 'undefined_function';
  END IF;
END
$precondition$;

-- ---------------------------------------------------------------------------
-- 1. The owner key the profile relationship needs.
--
--    social_profiles has a primary key on id only. The attempt must be able
--    to hold an owner-matching composite reference to a profile, so the
--    (id, user_id) pair needs to be unique. It already is, because id is
--    the primary key, so this constraint can never fail on existing data and
--    the scan it performs is over one row per profile.
-- ---------------------------------------------------------------------------
DO $profile_owner_key$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'social_profiles'
       AND c.contype = 'u'
       AND c.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = r.oid AND attname = 'id'),
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = r.oid AND attname = 'user_id')
       ]::smallint[]
  ) THEN
    ALTER TABLE public.social_profiles
      ADD CONSTRAINT social_profiles_id_user_id_key UNIQUE (id, user_id);
  END IF;
END
$profile_owner_key$;

-- ---------------------------------------------------------------------------
-- 2. The attempt relation. Nonsecret, service-only, one row per
--    authorization attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE public.meta_oauth_attempts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL,
  flow                        TEXT NOT NULL,
  intent                      TEXT NOT NULL,
  -- The explicit owned account this attempt reconnects to. NULL for a
  -- create-only attempt. The composite reference is what makes a foreign
  -- owner's account unreachable from another owner's attempt.
  target_social_account_id    UUID,
  -- The explicit owned account whose existing shared grant this attempt
  -- extends. NULL unless the intent is add_to_existing_grant.
  source_social_account_id    UUID,
  -- The intended profile. NULL means "no profile assignment".
  intended_social_profile_id  UUID,
  -- The capture format version. Bumped only by a new migration, never by
  -- a writer.
  capture_version             INTEGER NOT NULL DEFAULT 1,
  captured_at                 TIMESTAMPTZ NOT NULL,
  -- The immutable, versioned, WHITELISTED authority capture. No token, no
  -- authorization code, no raw provider response and no raw nonce.
  capture                     JSONB NOT NULL,
  -- The digest of the nonce. The raw nonce never reaches this table.
  nonce_digest                TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'authorized',
  -- The claim token handed to complete_meta_oauth_callback. Nonsecret, but
  -- still a capability: it proves the caller owns the claim.
  claim_token                 TEXT,
  claimed_at                  TIMESTAMPTZ,
  -- The stash row this attempt owns. Set once, by
  -- complete_meta_oauth_callback.
  pending_selection_id        UUID,
  -- The authority this attempt's own successful commits returned. Separate
  -- from the immutable capture on purpose.
  authority_progression       JSONB NOT NULL DEFAULT '{}'::JSONB,
  -- Server-controlled deadlines. Written once, never renewed, never
  -- extended by a read or a retry.
  callback_deadline           TIMESTAMPTZ NOT NULL,
  picker_deadline             TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The second explicit owned account of a page-plus-IG reconnect or
  -- rebind. NULL for every single-account attempt. Same owner-matching
  -- cascade as the primary target: deleting it must not race the attempt.
  linked_target_social_account_id UUID,

  CONSTRAINT meta_oauth_attempts_owner_key
    UNIQUE (id, user_id),
  CONSTRAINT meta_oauth_attempts_user_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  -- The owner-matching composite references. ON DELETE CASCADE, because an
  -- attempt whose target, source or profile is gone is meaningless, and
  -- because the cascade is what makes a concurrent profile deletion a
  -- refusal (the attempt disappears) rather than a silent reassignment.
  CONSTRAINT meta_oauth_attempts_target_fkey
    FOREIGN KEY (target_social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempts_source_fkey
    FOREIGN KEY (source_social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempts_profile_fkey
    FOREIGN KEY (intended_social_profile_id, user_id)
    REFERENCES public.social_profiles (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempts_linked_target_fkey
    FOREIGN KEY (linked_target_social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempts_flow_chk
    CHECK (flow IN ('instagram_page_linked', 'instagram_direct', 'facebook_page')),
  CONSTRAINT meta_oauth_attempts_intent_chk
    CHECK (intent IN ('connect_new', 'reconnect', 'add_to_existing_grant', 'rebind')),
  CONSTRAINT meta_oauth_attempts_status_chk
    CHECK (status IN ('authorized', 'claimed', 'selection_ready', 'completed', 'failed', 'expired')),
  CONSTRAINT meta_oauth_attempts_capture_version_chk
    CHECK (capture_version >= 1),
  CONSTRAINT meta_oauth_attempts_nonce_digest_chk
    CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meta_oauth_attempts_claim_token_chk
    CHECK (claim_token IS NULL OR claim_token ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meta_oauth_attempts_capture_object_chk
    CHECK (jsonb_typeof(capture) = 'object'),
  CONSTRAINT meta_oauth_attempts_progression_object_chk
    CHECK (jsonb_typeof(authority_progression) = 'object'),
  CONSTRAINT meta_oauth_attempts_deadline_order_chk
    CHECK (picker_deadline >= callback_deadline),
  CONSTRAINT meta_oauth_attempts_deadlines_finite_chk
    CHECK (isfinite(callback_deadline) AND isfinite(picker_deadline)),
  -- An intent and its references must agree. This is a table-level
  -- statement of the same rule the begin RPC enforces, so a row that
  -- exists is always internally coherent.
  CONSTRAINT meta_oauth_attempts_intent_refs_chk
    CHECK (
      (
        (intent = 'reconnect' AND target_social_account_id IS NOT NULL
                   AND source_social_account_id IS NULL)
        OR (intent = 'rebind' AND target_social_account_id IS NOT NULL
                   AND source_social_account_id IS NULL)
        OR (intent = 'connect_new' AND target_social_account_id IS NULL
                   AND source_social_account_id IS NULL
                   AND linked_target_social_account_id IS NULL)
        OR (intent = 'add_to_existing_grant' AND target_social_account_id IS NULL
                   AND source_social_account_id IS NOT NULL
                   AND linked_target_social_account_id IS NULL)
      )
      AND (
        linked_target_social_account_id IS NULL
        OR intent IN ('reconnect', 'rebind')
      )
    )
);

CREATE INDEX idx_meta_oauth_attempts_user
  ON public.meta_oauth_attempts (user_id);

CREATE INDEX idx_meta_oauth_attempts_status
  ON public.meta_oauth_attempts (status);

CREATE INDEX idx_meta_oauth_attempts_picker_deadline
  ON public.meta_oauth_attempts (picker_deadline);

CREATE UNIQUE INDEX idx_meta_oauth_attempts_nonce_digest
  ON public.meta_oauth_attempts (nonce_digest);

CREATE TRIGGER update_meta_oauth_attempts_updated_at
  BEFORE UPDATE ON public.meta_oauth_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.meta_oauth_attempts IS
  'Service-only, nonsecret record of one Meta OAuth authorization attempt. '
  'Holds the immutable pre-authorization authority capture, a nonce digest, '
  'server-controlled deadlines, the callback claim and the per-selection '
  'receipts. Holds NO token, no authorization code, no raw provider '
  'response and no raw nonce. Never readable by a browser role.';

COMMENT ON COLUMN public.meta_oauth_attempts.capture IS
  'Immutable, versioned, whitelisted authority capture taken BEFORE the '
  'provider was contacted: binding presence, the surviving connection-fence '
  'high-water mark, the credential id and revision, the Instagram capability '
  'generation and login kind, and the complete membership of the shared '
  'grant. Never rewritten.';

COMMENT ON COLUMN public.meta_oauth_attempts.authority_progression IS
  'The authority this attempt''s own successful commits returned. The only '
  'authority a later selection of this attempt may use. Never a freshly '
  'read live version.';

COMMENT ON COLUMN public.meta_oauth_attempts.nonce_digest IS
  'SHA-256 hex digest of the one-time nonce. The raw nonce lives only in the '
  'server-signed state and in the caller''s memory.';

-- ---------------------------------------------------------------------------
-- 3. The receipt relation. One nonsecret row per committed selection.
-- ---------------------------------------------------------------------------
CREATE TABLE public.meta_oauth_attempt_receipts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id              UUID NOT NULL,
  user_id                 UUID NOT NULL,
  -- The stable selection key. It distinguishes the provider identity AND
  -- the flow, so the same Instagram account selected under two flows is
  -- two different selections.
  selection_key           TEXT NOT NULL,
  platform                TEXT NOT NULL,
  platform_user_id        TEXT NOT NULL,
  instagram_user_id       TEXT,
  facebook_page_id        TEXT,
  facebook_user_id        TEXT,
  social_account_id       UUID,
  -- The second account committed by one page-plus-IG selection. NULL when
  -- the selection creates or reconnects a single account.
  companion_social_account_id UUID,
  credential_id           UUID,
  credential_revision     BIGINT,
  connection_version      BIGINT,
  capability_generation   BIGINT,
  login_kind              TEXT,
  -- The nonsecret receipt body. The same JSON the RPC returns.
  receipt                 JSONB NOT NULL,
  committed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meta_oauth_attempt_receipts_selection_key
    UNIQUE (attempt_id, selection_key),
  CONSTRAINT meta_oauth_attempt_receipts_attempt_fkey
    FOREIGN KEY (attempt_id, user_id)
    REFERENCES public.meta_oauth_attempts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempt_receipts_account_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempt_receipts_companion_fkey
    FOREIGN KEY (companion_social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT meta_oauth_attempt_receipts_platform_chk
    CHECK (platform IN ('instagram', 'facebook')),
  CONSTRAINT meta_oauth_attempt_receipts_login_kind_chk
    CHECK (login_kind IS NULL OR login_kind IN ('direct', 'page_linked')),
  CONSTRAINT meta_oauth_attempt_receipts_receipt_object_chk
    CHECK (jsonb_typeof(receipt) = 'object')
);

CREATE INDEX idx_meta_oauth_attempt_receipts_attempt
  ON public.meta_oauth_attempt_receipts (attempt_id);

CREATE INDEX idx_meta_oauth_attempt_receipts_user
  ON public.meta_oauth_attempt_receipts (user_id);

COMMENT ON TABLE public.meta_oauth_attempt_receipts IS
  'Service-only, nonsecret receipt for one committed Meta OAuth selection. '
  'The unique (attempt_id, selection_key) is what makes an identical retry '
  'return the same receipt with ZERO mutations, and what makes a conflicting '
  'retry a refusal rather than a second write.';

COMMENT ON COLUMN public.meta_oauth_attempt_receipts.receipt IS
  'The nonsecret receipt body. Whitelisted: identifiers, versions, the '
  'operation and the commit time. Never a token, a code or a raw provider '
  'response.';

-- ---------------------------------------------------------------------------
-- 4. The existing pending stashes gain a nullable, owner-matching attempt
--    reference. No default, so every legacy row keeps its exact shape and
--    every legacy query keeps its exact result shape.
--
--    The composite reference is what makes "a pending row owned by another
--    owner's attempt" structurally impossible, and the guard trigger below
--    is what makes "the legacy writer consumed an attempt's stash"
--    structurally impossible.
-- ---------------------------------------------------------------------------
ALTER TABLE public.oauth_pending_facebook_selections
  ADD COLUMN meta_oauth_attempt_id UUID NULL;

ALTER TABLE public.oauth_pending_instagram_selections
  ADD COLUMN meta_oauth_attempt_id UUID NULL;

ALTER TABLE public.oauth_pending_facebook_selections
  ADD CONSTRAINT oauth_pending_facebook_selections_attempt_fkey
  FOREIGN KEY (meta_oauth_attempt_id, user_id)
  REFERENCES public.meta_oauth_attempts (id, user_id)
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

ALTER TABLE public.oauth_pending_instagram_selections
  ADD CONSTRAINT oauth_pending_instagram_selections_attempt_fkey
  FOREIGN KEY (meta_oauth_attempt_id, user_id)
  REFERENCES public.meta_oauth_attempts (id, user_id)
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

CREATE INDEX idx_oauth_pending_fb_attempt
  ON public.oauth_pending_facebook_selections (meta_oauth_attempt_id)
  WHERE meta_oauth_attempt_id IS NOT NULL;

CREATE INDEX idx_oauth_pending_ig_attempt
  ON public.oauth_pending_instagram_selections (meta_oauth_attempt_id)
  WHERE meta_oauth_attempt_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Internal helpers.
-- ---------------------------------------------------------------------------

-- The nonce digest. pg_catalog.sha256 is core PostgreSQL 14+, so this does
-- not depend on which schema the pgcrypto extension was installed into.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_digest(
  p_text TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$function$;

-- 256 bits of nonce material from two core random UUIDs. No dependency on
-- an extension-provided random function.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_random_hex()
RETURNS TEXT
LANGUAGE sql
VOLATILE
STRICT
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT replace(gen_random_uuid()::TEXT, '-', '')
      || replace(gen_random_uuid()::TEXT, '-', '');
$function$;

-- A bounded, trimmed provider identifier. A control character, a blank
-- string or an over-long value is a malformed payload, not a value to be
-- truncated.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_identifier(
  p_value TEXT,
  p_field TEXT,
  p_max_length INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_value TEXT;
BEGIN
  IF p_value IS NULL THEN
    RAISE EXCEPTION '% is required', p_field USING ERRCODE = 'MOA01';
  END IF;
  v_value := btrim(p_value);
  IF v_value = '' THEN
    RAISE EXCEPTION '% must not be blank', p_field USING ERRCODE = 'MOA01';
  END IF;
  IF char_length(v_value) > p_max_length THEN
    RAISE EXCEPTION '% must be at most % characters', p_field, p_max_length
      USING ERRCODE = 'MOA01';
  END IF;
  IF v_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION '% must not contain control characters', p_field
      USING ERRCODE = 'MOA01';
  END IF;
  RETURN v_value;
END;
$function$;

-- A strict UUID reader. A malformed uuid is a malformed payload, not a
-- raw PostgreSQL cast error, so the refusal carries the stable MOA01.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_uuid(
  p_value TEXT,
  p_field TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RAISE EXCEPTION '% is required', p_field USING ERRCODE = 'MOA01';
  END IF;
  BEGIN
    RETURN btrim(p_value)::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION '% must be a uuid string', p_field USING ERRCODE = 'MOA01';
  END;
END;
$function$;

-- A strict JSON object reader. A missing key, a null value and a wrong type
-- are all refusals: a failed read is never treated as an absence.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_object(
  p_doc JSONB,
  p_field TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_doc IS NULL OR jsonb_typeof(p_doc) <> 'object' THEN
    RAISE EXCEPTION '% must be a JSON object', p_field USING ERRCODE = 'MOA01';
  END IF;
  IF NOT (p_doc ? p_field) THEN
    RAISE EXCEPTION '% is required', p_field USING ERRCODE = 'MOA01';
  END IF;
  IF jsonb_typeof(p_doc -> p_field) <> 'object' THEN
    RAISE EXCEPTION '% must be a JSON object', p_field USING ERRCODE = 'MOA01';
  END IF;
  RETURN p_doc -> p_field;
END;
$function$;

-- The stable selection key for one verified candidate. It distinguishes the
-- provider identity AND the flow.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_selection_key(
  p_flow TEXT,
  p_candidate JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_ig TEXT;
BEGIN
  IF p_flow = 'instagram_direct' THEN
    v_ig := public.meta_oauth_attempt_identifier(
      p_candidate ->> 'ig_user_id', 'ig_user_id', 128);
    RETURN 'instagram_direct:ig:' || v_ig;
  END IF;
  IF p_flow = 'instagram_page_linked' THEN
    v_ig := public.meta_oauth_attempt_identifier(
      p_candidate ->> 'ig_user_id', 'ig_user_id', 128);
    RETURN 'instagram_page_linked:ig:' || v_ig;
  END IF;
  IF p_flow = 'facebook_page' THEN
    IF COALESCE(p_candidate ->> 'candidate_kind', '') = 'page_plus_ig' THEN
      RETURN 'facebook_page:page:'
        || public.meta_oauth_attempt_identifier(p_candidate ->> 'facebook_page_id', 'facebook_page_id', 128)
        || ':ig:'
        || public.meta_oauth_attempt_identifier(p_candidate ->> 'ig_user_id', 'ig_user_id', 128);
    END IF;
    RETURN 'facebook_page:page:'
      || public.meta_oauth_attempt_identifier(p_candidate ->> 'facebook_page_id', 'facebook_page_id', 128);
  END IF;
  RAISE EXCEPTION 'unsupported attempt flow: %', p_flow USING ERRCODE = 'MOA02';
END;
$function$;

-- The intended profile, locked against a concurrent deletion.
--
-- FOR KEY SHARE conflicts with the FOR UPDATE a DELETE takes, so a profile
-- delete that starts first makes this fail fast instead of deadlocking
-- against the attempt lock we already hold. A busy profile is a refusal
-- with a whole-transaction retry, not a wait.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_lock_profile(
  p_user_id UUID,
  p_profile_id UUID
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
      FROM public.social_profiles
     WHERE id = p_profile_id
       AND user_id = p_user_id
     FOR KEY SHARE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION
        'the intended social profile % is being modified concurrently; retry the whole transaction',
        p_profile_id
        USING ERRCODE = 'MOA09';
  END;

  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'the intended social profile % is not owned by the given user or no longer exists',
      p_profile_id
      USING ERRCODE = 'MOA02';
  END IF;
END;
$function$;

-- The immutable capture of one owned account.
--
-- Nothing here is a secret: identifiers, presence flags and versions only.
-- The fence high-water mark is captured alongside the binding presence,
-- because binding absence alone cannot survive a bind -> detach cycle.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_capture_account(
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
  v_platform TEXT;
  v_platform_user_id TEXT;
  v_binding_present BOOLEAN := false;
  v_binding_credential_id UUID;
  v_binding_connection_version BIGINT;
  v_fence_present BOOLEAN := false;
  v_fence_connection_version BIGINT := 0;
  v_credential_revision BIGINT;
  v_provider_user_id TEXT;
  v_capability_present BOOLEAN := false;
  v_capability_generation BIGINT;
  v_capability_login_kind TEXT;
  v_capability_read_state TEXT;
BEGIN
  SELECT sa.platform, sa.platform_user_id
    INTO v_platform, v_platform_user_id
    FROM public.social_accounts AS sa
   WHERE sa.id = p_social_account_id
     AND sa.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'social account % is not owned by the given user', p_social_account_id
      USING ERRCODE = 'MOA02';
  END IF;

  SELECT b.credential_id, b.connection_version
    INTO v_binding_credential_id, v_binding_connection_version
    FROM public.facebook_user_credential_bindings AS b
   WHERE b.social_account_id = p_social_account_id
     AND b.user_id = p_user_id;
  v_binding_present := FOUND;

  SELECT f.connection_version
    INTO v_fence_connection_version
    FROM public.facebook_user_credential_connection_fences AS f
   WHERE f.social_account_id = p_social_account_id
     AND f.user_id = p_user_id;
  v_fence_present := FOUND;
  IF NOT v_fence_present THEN
    -- The explicit never-created sentinel. A fence that does not exist yet
    -- is not the same as a fence at zero.
    v_fence_connection_version := 0;
  END IF;

  IF v_binding_present THEN
    SELECT c.revision, c.provider_user_id
      INTO v_credential_revision, v_provider_user_id
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_binding_credential_id
       AND c.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'social account % carries a binding whose credential no longer exists',
        p_social_account_id
        USING ERRCODE = 'MOA07';
    END IF;
  END IF;

  SELECT c.credential_generation, c.login_kind, c.permission_read_state
    INTO v_capability_generation, v_capability_login_kind, v_capability_read_state
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_social_account_id
     AND c.user_id = p_user_id;
  v_capability_present := FOUND;

  RETURN jsonb_build_object(
    'social_account_id', p_social_account_id,
    'platform', v_platform,
    'platform_user_id', v_platform_user_id,
    'binding_present', v_binding_present,
    'binding_credential_id', v_binding_credential_id,
    'binding_connection_version', v_binding_connection_version,
    'fence_state', CASE WHEN v_fence_present THEN 'present' ELSE 'never_created' END,
    'fence_connection_version', v_fence_connection_version,
    'credential_revision', v_credential_revision,
    'provider_user_id', v_provider_user_id,
    'capability_present', v_capability_present,
    'capability_generation', v_capability_generation,
    'capability_login_kind', v_capability_login_kind,
    'capability_permission_read_state', v_capability_read_state
  );
END;
$function$;

-- The complete membership of the shared grant a captured account belongs
-- to. This is the membership of ONE credential, never an owner-wide
-- inventory of accounts.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_capture_grant(
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
  v_provider_user_id TEXT;
  v_revision BIGINT;
  v_members JSONB;
BEGIN
  IF p_credential_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.provider_user_id, c.revision
    INTO v_provider_user_id, v_revision
    FROM public.facebook_user_credentials AS c
   WHERE c.id = p_credential_id
     AND c.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the captured facebook user credential is not owned by the given user'
      USING ERRCODE = 'MOA02';
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'social_account_id', b.social_account_id,
             'platform', b.platform,
             'connection_version', b.connection_version,
             'capability_generation', cap.credential_generation
           )
           ORDER BY b.social_account_id
         ), '[]'::JSONB)
    INTO v_members
    FROM public.facebook_user_credential_bindings AS b
    LEFT JOIN public.instagram_account_capabilities AS cap
      ON cap.social_account_id = b.social_account_id
     AND cap.user_id = b.user_id
   WHERE b.credential_id = p_credential_id
     AND b.user_id = p_user_id;

  RETURN jsonb_build_object(
    'credential_id', p_credential_id,
    'provider_user_id', v_provider_user_id,
    'credential_revision', v_revision,
    'members', v_members
  );
END;
$function$;

-- The live membership of a grant, as a sorted array of account ids. Used
-- to recheck the membership under the locks.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_live_grant_members(
  p_user_id UUID,
  p_credential_id UUID
)
RETURNS TEXT[]
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(
    ARRAY(
      SELECT b.social_account_id::TEXT
        FROM public.facebook_user_credential_bindings AS b
       WHERE b.credential_id = p_credential_id
         AND b.user_id = p_user_id
       ORDER BY b.social_account_id
    ),
    ARRAY[]::TEXT[]
  );
$function$;

-- The attempt's own committed accounts, as recorded in the progression.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_progression_accounts(
  p_progression JSONB
)
RETURNS UUID[]
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT (e.value ->> 'social_account_id')::UUID
        FROM jsonb_array_elements(
               COALESCE(p_progression -> 'accounts', '[]'::JSONB)
             ) AS e(value)
       WHERE jsonb_typeof(e.value) = 'object'
         AND e.value ? 'social_account_id'
         AND (e.value ->> 'social_account_id') IS NOT NULL
       ORDER BY 1
    ),
    ARRAY[]::UUID[]
  );
$function$;

-- ---------------------------------------------------------------------------
-- 6. Triggers.
-- ---------------------------------------------------------------------------

-- The capture is immutable. Once an attempt exists, its captured
-- authority, its nonce digest, its flow, its intent and its account
-- references can never change. Only the lifecycle columns and the
-- attempt-local progression may move.
--
-- The progression is writable only from inside that attempt's own RPC, so
-- a stray writer cannot manufacture authority.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_guard_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_attempt TEXT;
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.flow IS DISTINCT FROM OLD.flow
     OR NEW.intent IS DISTINCT FROM OLD.intent
     OR NEW.target_social_account_id IS DISTINCT FROM OLD.target_social_account_id
     OR NEW.linked_target_social_account_id IS DISTINCT FROM OLD.linked_target_social_account_id
     OR NEW.source_social_account_id IS DISTINCT FROM OLD.source_social_account_id
     OR NEW.intended_social_profile_id IS DISTINCT FROM OLD.intended_social_profile_id
     OR NEW.capture_version IS DISTINCT FROM OLD.capture_version
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.capture IS DISTINCT FROM OLD.capture
     OR NEW.nonce_digest IS DISTINCT FROM OLD.nonce_digest
     OR NEW.callback_deadline IS DISTINCT FROM OLD.callback_deadline
     OR NEW.picker_deadline IS DISTINCT FROM OLD.picker_deadline THEN
    RAISE EXCEPTION
      'the captured authority of an OAuth attempt is immutable'
      USING ERRCODE = 'MOA04';
  END IF;

  IF NEW.authority_progression IS DISTINCT FROM OLD.authority_progression THEN
    v_attempt := current_setting('postora.meta_oauth_attempt', true);
    IF v_attempt IS NULL OR v_attempt <> OLD.id::TEXT THEN
      RAISE EXCEPTION
        'the authority progression of an OAuth attempt may only be advanced by that attempt'
        USING ERRCODE = 'MOA04';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER meta_oauth_attempt_guard_immutable
  BEFORE UPDATE ON public.meta_oauth_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.meta_oauth_attempt_guard_immutable();

-- A pending stash row that belongs to an attempt may only be written or
-- consumed by that attempt. A legacy row, whose attempt reference is NULL,
-- keeps the legacy behaviour exactly.
--
-- The attempt's RPCs set the transaction-local setting this trigger reads.
-- The setting is a capability held by the trusted backend, which already
-- holds the service role.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_guard_pending_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_attempt TEXT;
BEGIN
  v_attempt := current_setting('postora.meta_oauth_attempt', true);

  IF TG_OP = 'INSERT' THEN
    IF NEW.meta_oauth_attempt_id IS NOT NULL
       AND (v_attempt IS NULL OR v_attempt <> NEW.meta_oauth_attempt_id::TEXT) THEN
      RAISE EXCEPTION
        'a pending selection row may only be written by the OAuth attempt that owns it'
        USING ERRCODE = 'MOA04';
    END IF;
    RETURN NEW;
  END IF;

  -- The guard applies while the owning attempt still exists AND the owner
  -- still exists. When either is gone, the row is being removed by a
  -- cascade. The one other authorized deletion is purge_expired_meta_oauth_pending,
  -- and only for an already-expired row: the purge setting does not authorize
  -- an update or an unexpired delete.
  IF OLD.meta_oauth_attempt_id IS NOT NULL
     AND (v_attempt IS NULL OR v_attempt <> OLD.meta_oauth_attempt_id::TEXT)
     AND EXISTS (
       SELECT 1
         FROM public.meta_oauth_attempts AS a
        WHERE a.id = OLD.meta_oauth_attempt_id
     )
     AND EXISTS (
       SELECT 1
         FROM auth.users AS u
        WHERE u.id = OLD.user_id
     )
     AND NOT (
       TG_OP = 'DELETE'
       AND current_setting('postora.meta_oauth_purge', true)
           IS NOT DISTINCT FROM OLD.meta_oauth_attempt_id::TEXT
       AND OLD.expires_at IS NOT NULL
       AND clock_timestamp() >= OLD.expires_at
     ) THEN
    RAISE EXCEPTION
      'a pending selection row owned by an OAuth attempt can only be consumed by that attempt'
      USING ERRCODE = 'MOA04';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER meta_oauth_attempt_guard_pending_row
  BEFORE INSERT OR UPDATE OR DELETE ON public.oauth_pending_facebook_selections
  FOR EACH ROW
  EXECUTE FUNCTION public.meta_oauth_attempt_guard_pending_row();

CREATE TRIGGER meta_oauth_attempt_guard_pending_row
  BEFORE INSERT OR UPDATE OR DELETE ON public.oauth_pending_instagram_selections
  FOR EACH ROW
  EXECUTE FUNCTION public.meta_oauth_attempt_guard_pending_row();

-- Absolute expiry. Blank is unknown. A value that is not a timestamp is
-- a malformed service payload, not a silently invented expiry.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_timestamptz(
  p_value TEXT,
  p_field TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN p_value::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '% must be an absolute timestamptz', p_field
      USING ERRCODE = 'MOA01';
  END;
END;
$function$;

-- Seconds anchored at the callback capture, never at selection time.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_anchor_expiry(
  p_absolute TEXT,
  p_seconds TEXT,
  p_anchored_at TIMESTAMPTZ,
  p_field TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_absolute TIMESTAMPTZ;
  v_seconds BIGINT;
BEGIN
  IF p_absolute IS NOT NULL AND btrim(p_absolute) <> '' THEN
    RETURN public.meta_oauth_attempt_timestamptz(p_absolute, p_field);
  END IF;
  IF p_seconds IS NULL OR btrim(p_seconds) = '' THEN
    RETURN NULL;
  END IF;
  IF p_seconds !~ '^[0-9]+$' OR p_seconds::BIGINT > 315360000 THEN
    RAISE EXCEPTION '% must be a non-negative integer of seconds', p_field
      USING ERRCODE = 'MOA01';
  END IF;
  v_seconds := p_seconds::BIGINT;
  v_absolute := p_anchored_at + make_interval(secs => v_seconds::INTEGER);
  RETURN v_absolute;
END;
$function$;

-- The attempt's owner is an FK parent. A user delete holds that row and
-- then cascades into the attempt, so waiting for it while this transaction
-- already holds the attempt is the cycle reproduced as 40P01. NOWAIT.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_lock_owner(
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
        'the attempt owner is being deleted; retry the whole transaction'
        USING ERRCODE = 'MOA09';
  END;
  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the attempt owner no longer exists' USING ERRCODE = 'MOA02';
  END IF;
END;
$function$;

-- Every captured account, parents included. NOWAIT: a busy row is MOA09
-- and the caller retries the whole transaction. A plain holder and a
-- cascading delete are the same refusal. Query text is not authority.
-- p_parent_ids is retained so existing callers keep their signature; the
-- lock decision does not depend on it.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_lock_accounts(
  p_user_id UUID,
  p_account_ids UUID[],
  p_parent_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_account UUID;
BEGIN
  -- p_parent_ids stays in the signature. The lock decision does not use it.
  IF p_parent_ids IS NULL THEN
    NULL;
  END IF;
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
          'captured account % is not owned by the given user', v_account
          USING ERRCODE = 'MOA07';
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE EXCEPTION
          'account % is busy; retry the whole transaction', v_account
          USING ERRCODE = 'MOA09';
    END;
  END LOOP;
END;
$function$;

-- The explicit captured account, rechecked under the row lock and before
-- any account write. This is the target, the linked target, or the source.
-- A grant member that was not itself one of those three is still covered
-- by meta_oauth_attempt_require_members. An unbound companion is not a
-- member, so this function is what refuses a binding, a fence, or a
-- generation that appeared after capture.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_require_captured_account(
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
  v_provider TEXT;
  v_capability_present BOOLEAN := false;
  v_generation BIGINT;
  v_login_kind TEXT;
BEGIN
  IF p_capture IS NULL OR jsonb_typeof(p_capture) <> 'object' THEN
    RAISE EXCEPTION 'the captured account is missing' USING ERRCODE = 'MOA07';
  END IF;
  v_account := (p_capture ->> 'social_account_id')::UUID;

  SELECT sa.platform, sa.platform_user_id
    INTO v_platform, v_platform_user_id
    FROM public.social_accounts AS sa
   WHERE sa.id = v_account
     AND sa.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the captured account % is no longer owned by the given user', v_account
      USING ERRCODE = 'MOA07';
  END IF;
  IF v_platform IS DISTINCT FROM (p_capture ->> 'platform')
     OR v_platform_user_id IS DISTINCT FROM (p_capture ->> 'platform_user_id') THEN
    RAISE EXCEPTION
      'the captured provider identity no longer matches account %', v_account
      USING ERRCODE = 'MOA07';
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
      USING ERRCODE = 'MOA07';
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
      USING ERRCODE = 'MOA07';
  END IF;

  IF v_binding_present THEN
    IF v_binding_credential IS DISTINCT FROM (p_capture ->> 'binding_credential_id')::UUID
       OR v_binding_connection IS DISTINCT FROM
          (p_capture ->> 'binding_connection_version')::BIGINT THEN
      RAISE EXCEPTION
        'the captured binding no longer matches account %', v_account
        USING ERRCODE = 'MOA07';
    END IF;
    SELECT c.revision, c.provider_user_id
      INTO v_revision, v_provider
      FROM public.facebook_user_credentials AS c
     WHERE c.id = v_binding_credential
       AND c.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the captured credential for account % no longer exists', v_account
        USING ERRCODE = 'MOA07';
    END IF;
    IF v_revision IS DISTINCT FROM (p_capture ->> 'credential_revision')::BIGINT THEN
      RAISE EXCEPTION
        'the captured credential revision no longer matches account %', v_account
        USING ERRCODE = 'MOA07';
    END IF;
    -- begin() always stores this key. A hand-built capture that omits it
    -- is not given a discovered subject in its place.
    IF p_capture ? 'provider_user_id'
       AND v_provider IS DISTINCT FROM (p_capture ->> 'provider_user_id') THEN
      RAISE EXCEPTION
        'the captured credential subject no longer matches account %', v_account
        USING ERRCODE = 'MOA07';
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
      USING ERRCODE = 'MOA07';
  END IF;
  IF v_capability_present
     AND (
       v_generation IS DISTINCT FROM (p_capture ->> 'capability_generation')::BIGINT
       OR v_login_kind IS DISTINCT FROM (p_capture ->> 'capability_login_kind')
     ) THEN
    RAISE EXCEPTION
      'the captured capability no longer matches account %', v_account
      USING ERRCODE = 'MOA07';
  END IF;
END;
$function$;

-- Picker, stash, and every known absolute operational or User expiry.
-- Null means the expiry was not supplied and stays unknown. This does not
-- read the live credential, restart a TTL, or turn an expired instant into
-- null. Call it after each lock wait and again after the capability and
-- binding writes, before the receipt.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_assert_live_expiries(
  p_attempt UUID,
  p_picker TIMESTAMPTZ,
  p_stash_expires TIMESTAMPTZ,
  p_operational_expires TIMESTAMPTZ,
  p_user_grant_expires TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
BEGIN
  PERFORM public.meta_oauth_attempt_assert_deadline(
    p_attempt, p_picker, p_stash_expires);
  IF p_operational_expires IS NOT NULL
     AND clock_timestamp() >= p_operational_expires THEN
    RAISE EXCEPTION
      'the operational token expired before the selection was committed'
      USING ERRCODE = 'MOA08';
  END IF;
  IF p_user_grant_expires IS NOT NULL
     AND clock_timestamp() >= p_user_grant_expires THEN
    RAISE EXCEPTION
      'the facebook user token expired before the selection was committed'
      USING ERRCODE = 'MOA08';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_assert_deadline(
  p_attempt UUID,
  p_picker TIMESTAMPTZ,
  p_stash_expires TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_picker IS NOT NULL AND v_now >= p_picker THEN
    RAISE EXCEPTION
      'oauth attempt % expired before the selection was committed', p_attempt
      USING ERRCODE = 'MOA08';
  END IF;
  IF p_stash_expires IS NOT NULL AND v_now >= p_stash_expires THEN
    RAISE EXCEPTION
      'the pending selection stash expired before the selection was committed'
      USING ERRCODE = 'MOA08';
  END IF;
END;
$function$;

-- Every captured or progressed member, not only the selected account.
-- A changed generation, connection version, revision, subject or membership
-- refuses. This does not adopt the live version.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_require_members(
  p_user_id UUID,
  p_credential_id UUID,
  p_expected_revision BIGINT,
  p_expected_subject TEXT,
  p_members JSONB
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_member JSONB;
  v_expected TEXT[];
  v_live TEXT[];
  v_account UUID;
  v_platform TEXT;
  v_connection BIGINT;
  v_generation BIGINT;
  v_revision BIGINT;
  v_subject TEXT;
BEGIN
  IF p_credential_id IS NULL OR p_members IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_members) <> 'array' THEN
    RAISE EXCEPTION 'captured grant membership is malformed' USING ERRCODE = 'MOA07';
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
      USING ERRCODE = 'MOA07';
  END IF;

  SELECT c.revision, c.provider_user_id
    INTO v_revision, v_subject
    FROM public.facebook_user_credentials AS c
   WHERE c.id = p_credential_id
     AND c.user_id = p_user_id;
  IF NOT FOUND
     OR v_revision IS DISTINCT FROM p_expected_revision
     OR (p_expected_subject IS NOT NULL AND v_subject IS DISTINCT FROM p_expected_subject) THEN
    RAISE EXCEPTION
      'the captured credential revision no longer matches the live credential'
      USING ERRCODE = 'MOA07';
  END IF;

  FOR v_member IN
    SELECT e.value FROM jsonb_array_elements(p_members) AS e(value)
  LOOP
    v_account := (v_member ->> 'social_account_id')::UUID;
    v_platform := COALESCE(v_member ->> 'platform', 'instagram');
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
        USING ERRCODE = 'MOA07';
    END IF;
    -- The fence is the high-water mark. Restoring the binding version
    -- after the fence has moved is the connection ABA, and it refuses.
    SELECT f.connection_version
      INTO v_connection
      FROM public.facebook_user_credential_connection_fences AS f
     WHERE f.social_account_id = v_account
       AND f.user_id = p_user_id;
    IF v_connection IS DISTINCT FROM (v_member ->> 'connection_version')::BIGINT THEN
      RAISE EXCEPTION
        'a captured grant member connection fence no longer matches'
        USING ERRCODE = 'MOA07';
    END IF;
    IF v_platform = 'instagram' AND (v_member ->> 'capability_generation') IS NOT NULL THEN
      SELECT c.credential_generation
        INTO v_generation
        FROM public.instagram_account_capabilities AS c
       WHERE c.social_account_id = v_account
         AND c.user_id = p_user_id;
      IF v_generation IS DISTINCT FROM (v_member ->> 'capability_generation')::BIGINT THEN
        RAISE EXCEPTION
          'a captured grant member capability generation no longer matches'
          USING ERRCODE = 'MOA07';
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- Shared User-token replacement invalidates every other IG generation and
-- every other Facebook connection fence. The selected accounts are excluded
-- because this commit advances those itself. Sibling operational tokens and
-- health columns are not written.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_invalidate_grant(
  p_user_id UUID,
  p_credential_id UUID,
  p_members JSONB,
  p_excluded UUID[]
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
  v_bumped INTEGER;
  v_expected INTEGER;
BEGIN
  SELECT count(*) INTO v_expected
    FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
   WHERE COALESCE(e.value ->> 'platform', 'instagram') = 'instagram'
     AND (e.value ->> 'capability_generation') IS NOT NULL
     AND NOT ((e.value ->> 'social_account_id')::UUID = ANY(COALESCE(p_excluded, ARRAY[]::UUID[])));

  UPDATE public.instagram_account_capabilities AS c
     SET credential_generation = c.credential_generation + 1,
         credential_updated_at = clock_timestamp(),
         generation_reason = 'credential_replaced',
         updated_at = clock_timestamp()
    FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
   WHERE COALESCE(e.value ->> 'platform', 'instagram') = 'instagram'
     AND NOT ((e.value ->> 'social_account_id')::UUID = ANY(COALESCE(p_excluded, ARRAY[]::UUID[])))
     AND c.social_account_id = (e.value ->> 'social_account_id')::UUID
     AND c.user_id = p_user_id
     AND c.credential_generation = (e.value ->> 'capability_generation')::BIGINT;
  GET DIAGNOSTICS v_bumped = ROW_COUNT;
  IF v_bumped IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'a captured grant member capability generation no longer matches'
      USING ERRCODE = 'MOA07';
  END IF;

  FOR v_member IN
    SELECT e.value FROM jsonb_array_elements(COALESCE(p_members, '[]'::JSONB)) AS e(value)
  LOOP
    v_account := (v_member ->> 'social_account_id')::UUID;
    v_platform := COALESCE(v_member ->> 'platform', 'instagram');
    IF v_platform = 'facebook'
       AND NOT (v_account = ANY(COALESCE(p_excluded, ARRAY[]::UUID[]))) THEN
      BEGIN
        PERFORM public.facebook_user_credential_commit_connection_version(
          p_user_id, v_account, (v_member ->> 'connection_version')::BIGINT);
      EXCEPTION
        WHEN SQLSTATE 'FUC01' THEN
          RAISE EXCEPTION
            'a captured facebook connection fence no longer matches'
            USING ERRCODE = 'MOA07';
      END;
    END IF;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. begin_meta_oauth_attempt.
--
--    Validate the ownership and the intent, capture the coherent authority
--    BEFORE the provider is contacted, mint the nonce, and return the
--    material a server-signed state needs. It never returns a browser
--    version and it never adopts authority.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_meta_oauth_attempt(
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
  v_flow TEXT;
  v_intent TEXT;
  v_target UUID;
  v_linked UUID;
  v_source UUID;
  v_profile UUID;
  v_nonce TEXT;
  v_digest TEXT;
  v_attempt UUID;
  v_now TIMESTAMPTZ;
  v_capture JSONB;
  v_target_capture JSONB;
  v_linked_capture JSONB;
  v_source_capture JSONB;
  v_grant JSONB;
  v_target_platform TEXT;
  v_linked_platform TEXT;
  v_source_platform TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MOA01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MOA01';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN (
      'flow', 'intent', 'target_social_account_id',
      'linked_target_social_account_id',
      'source_social_account_id', 'intended_social_profile_id'
    ) THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MOA01';
    END IF;
  END LOOP;

  IF jsonb_typeof(p_payload -> 'flow') <> 'string' THEN
    RAISE EXCEPTION 'flow is required' USING ERRCODE = 'MOA01';
  END IF;
  v_flow := p_payload ->> 'flow';
  IF v_flow NOT IN ('instagram_page_linked', 'instagram_direct', 'facebook_page') THEN
    RAISE EXCEPTION
      'unsupported attempt flow: %. This contract supports instagram_page_linked, instagram_direct and facebook_page.',
      v_flow
      USING ERRCODE = 'MOA02';
  END IF;

  IF jsonb_typeof(p_payload -> 'intent') <> 'string' THEN
    RAISE EXCEPTION 'intent is required' USING ERRCODE = 'MOA01';
  END IF;
  v_intent := p_payload ->> 'intent';
  IF v_intent NOT IN ('connect_new', 'reconnect', 'add_to_existing_grant', 'rebind') THEN
    RAISE EXCEPTION 'unsupported attempt intent: %', v_intent USING ERRCODE = 'MOA01';
  END IF;

  IF (p_payload -> 'target_social_account_id') IS NOT NULL
     AND jsonb_typeof(p_payload -> 'target_social_account_id') <> 'string' THEN
    RAISE EXCEPTION 'target_social_account_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  IF (p_payload -> 'linked_target_social_account_id') IS NOT NULL
     AND jsonb_typeof(p_payload -> 'linked_target_social_account_id') <> 'string' THEN
    RAISE EXCEPTION 'linked_target_social_account_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  IF (p_payload -> 'source_social_account_id') IS NOT NULL
     AND jsonb_typeof(p_payload -> 'source_social_account_id') <> 'string' THEN
    RAISE EXCEPTION 'source_social_account_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  IF (p_payload -> 'intended_social_profile_id') IS NOT NULL
     AND jsonb_typeof(p_payload -> 'intended_social_profile_id') <> 'string' THEN
    RAISE EXCEPTION 'intended_social_profile_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;

  IF v_intent IN ('reconnect', 'rebind') THEN
    IF p_payload -> 'target_social_account_id' IS NULL THEN
      RAISE EXCEPTION
        'a % attempt requires an explicit owned target_social_account_id', v_intent
        USING ERRCODE = 'MOA01';
    END IF;
    IF p_payload -> 'source_social_account_id' IS NOT NULL THEN
      RAISE EXCEPTION
        'a % attempt must not name a source account', v_intent
        USING ERRCODE = 'MOA01';
    END IF;
    v_target := public.meta_oauth_attempt_uuid(
      p_payload ->> 'target_social_account_id', 'target_social_account_id');
    IF p_payload -> 'linked_target_social_account_id' IS NOT NULL THEN
      IF v_flow <> 'facebook_page' THEN
        RAISE EXCEPTION
          'linked_target_social_account_id is only valid for a facebook_page attempt'
          USING ERRCODE = 'MOA01';
      END IF;
      v_linked := public.meta_oauth_attempt_uuid(
        p_payload ->> 'linked_target_social_account_id',
        'linked_target_social_account_id');
    END IF;
  ELSIF v_intent = 'add_to_existing_grant' THEN
    IF p_payload -> 'source_social_account_id' IS NULL THEN
      RAISE EXCEPTION
        'an add_to_existing_grant attempt requires an explicit owned source_social_account_id'
        USING ERRCODE = 'MOA01';
    END IF;
    IF p_payload -> 'linked_target_social_account_id' IS NOT NULL
       OR p_payload -> 'target_social_account_id' IS NOT NULL THEN
      RAISE EXCEPTION
        'an add_to_existing_grant attempt must not name a target account'
        USING ERRCODE = 'MOA01';
    END IF;
    v_source := public.meta_oauth_attempt_uuid(
      p_payload ->> 'source_social_account_id', 'source_social_account_id');
  ELSE
    IF p_payload -> 'target_social_account_id' IS NOT NULL
       OR p_payload -> 'linked_target_social_account_id' IS NOT NULL
       OR p_payload -> 'source_social_account_id' IS NOT NULL THEN
      RAISE EXCEPTION
        'a connect_new attempt must not name a target or a source account'
        USING ERRCODE = 'MOA01';
    END IF;
  END IF;

  IF (p_payload -> 'intended_social_profile_id') IS NOT NULL THEN
    v_profile := public.meta_oauth_attempt_uuid(
      p_payload ->> 'intended_social_profile_id', 'intended_social_profile_id');
    PERFORM public.meta_oauth_attempt_lock_profile(p_user_id, v_profile);
  END IF;

  IF v_target IS NOT NULL THEN
    SELECT sa.platform INTO v_target_platform
      FROM public.social_accounts AS sa
     WHERE sa.id = v_target AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the reconnect target % is not owned by the given user', v_target
        USING ERRCODE = 'MOA02';
    END IF;
    IF v_flow = 'facebook_page' THEN
      IF v_target_platform <> 'facebook' THEN
        RAISE EXCEPTION
          'the facebook_page target % is not a Facebook Page account', v_target
          USING ERRCODE = 'MOA02';
      END IF;
    ELSIF v_target_platform <> 'instagram' THEN
      RAISE EXCEPTION
        'the reconnect target % is not an Instagram account', v_target
        USING ERRCODE = 'MOA02';
    END IF;
  END IF;

  IF v_linked IS NOT NULL THEN
    IF v_linked = v_target THEN
      RAISE EXCEPTION
        'the linked target must be a different account from the page target'
        USING ERRCODE = 'MOA01';
    END IF;
    SELECT sa.platform INTO v_linked_platform
      FROM public.social_accounts AS sa
     WHERE sa.id = v_linked AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the linked target % is not owned by the given user', v_linked
        USING ERRCODE = 'MOA02';
    END IF;
    IF v_linked_platform <> 'instagram' THEN
      RAISE EXCEPTION
        'the linked target % is not an Instagram account', v_linked
        USING ERRCODE = 'MOA02';
    END IF;
  END IF;

  IF v_source IS NOT NULL THEN
    SELECT sa.platform INTO v_source_platform
      FROM public.social_accounts AS sa
     WHERE sa.id = v_source AND sa.user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'the grant source % is not owned by the given user', v_source
        USING ERRCODE = 'MOA02';
    END IF;
    IF v_flow IN ('facebook_page', 'instagram_page_linked') THEN
      IF v_source_platform NOT IN ('instagram', 'facebook') THEN
        RAISE EXCEPTION
          'the grant source % is not a Facebook or Instagram account', v_source
          USING ERRCODE = 'MOA02';
      END IF;
    ELSIF v_source_platform <> 'instagram' THEN
      RAISE EXCEPTION
        'the grant source % is not an Instagram account', v_source
        USING ERRCODE = 'MOA02';
    END IF;
  END IF;

  v_now := clock_timestamp();
  v_target_capture := NULL;
  v_linked_capture := NULL;
  v_source_capture := NULL;
  v_grant := NULL;

  IF v_target IS NOT NULL THEN
    v_target_capture := public.meta_oauth_attempt_capture_account(p_user_id, v_target);
    IF (v_target_capture ->> 'binding_present')::BOOLEAN IS TRUE THEN
      v_grant := public.meta_oauth_attempt_capture_grant(
        p_user_id, (v_target_capture ->> 'binding_credential_id')::UUID);
    END IF;
  END IF;

  IF v_linked IS NOT NULL THEN
    v_linked_capture := public.meta_oauth_attempt_capture_account(p_user_id, v_linked);
    IF (v_linked_capture ->> 'binding_present')::BOOLEAN IS TRUE THEN
      IF v_grant IS NOT NULL
         AND (v_grant ->> 'credential_id')
             IS DISTINCT FROM (v_linked_capture ->> 'binding_credential_id') THEN
        RAISE EXCEPTION
          'the page target and the linked Instagram account are not on the same captured grant'
          USING ERRCODE = 'MOA07';
      END IF;
      v_grant := public.meta_oauth_attempt_capture_grant(
        p_user_id, (v_linked_capture ->> 'binding_credential_id')::UUID);
    END IF;
  END IF;

  IF v_source IS NOT NULL THEN
    v_source_capture := public.meta_oauth_attempt_capture_account(p_user_id, v_source);
    IF NOT (v_source_capture ->> 'binding_present')::BOOLEAN IS TRUE THEN
      RAISE EXCEPTION
        'the grant source % carries no facebook user credential binding; there is no grant to extend'
        , v_source
        USING ERRCODE = 'MOA02';
    END IF;
    v_grant := public.meta_oauth_attempt_capture_grant(
      p_user_id, (v_source_capture ->> 'binding_credential_id')::UUID);
  END IF;

  -- A key that is absent reads as SQL NULL, which is what the commit path
  -- tests. A key that is present with a JSON null would not.
  v_capture := jsonb_build_object(
    'capture_version', 1,
    'captured_at', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  IF v_target_capture IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object('target', v_target_capture);
  END IF;
  IF v_linked_capture IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object('linked_target', v_linked_capture);
  END IF;
  IF v_source_capture IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object('source', v_source_capture);
  END IF;
  IF v_grant IS NOT NULL THEN
    v_capture := v_capture || jsonb_build_object('grant', v_grant);
  END IF;

  v_nonce := public.meta_oauth_attempt_random_hex();
  v_digest := public.meta_oauth_attempt_digest(v_nonce);

  BEGIN
    INSERT INTO public.meta_oauth_attempts (
      user_id, flow, intent,
      target_social_account_id, source_social_account_id,
      intended_social_profile_id,
      capture_version, captured_at, capture, nonce_digest, status,
      callback_deadline, picker_deadline,
      linked_target_social_account_id
    ) VALUES (
      p_user_id, v_flow, v_intent,
      v_target, v_source, v_profile,
      1, v_now, v_capture, v_digest, 'authorized',
      v_now + interval '10 minutes', v_now + interval '15 minutes',
      v_linked
    )
    RETURNING id INTO v_attempt;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION
        'the referenced account or profile was removed while the attempt was being created'
        USING ERRCODE = 'MOA02';
  END;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'flow', v_flow,
    'intent', v_intent,
    'user_id', p_user_id,
    'target_social_account_id', v_target,
    'linked_target_social_account_id', v_linked,
    'source_social_account_id', v_source,
    'intended_social_profile_id', v_profile,
    'capture_version', 1,
    'captured_at', v_now,
    -- The nonce is returned ONCE and is never stored. The server puts it
    -- in the signed state; the database keeps only its digest.
    'nonce', v_nonce,
    'nonce_digest', v_digest,
    'state', jsonb_build_object(
      'attempt_id', v_attempt,
      'nonce', v_nonce,
      'flow', v_flow
    ),
    'callback_deadline', v_now + interval '10 minutes',
    'picker_deadline', v_now + interval '15 minutes',
    'capture', v_capture
  );
END;
$function$;

COMMENT ON FUNCTION public.begin_meta_oauth_attempt(UUID, JSONB) IS
  'Starts a Meta OAuth attempt. Validates the owned target, source and '
  'profile, captures the coherent authority BEFORE the provider is '
  'contacted, and returns the attempt id, a one-time nonce and the '
  'server-signed-state material. Never adopts authority and never returns a '
  'browser version.';

-- ---------------------------------------------------------------------------
-- 8. claim_meta_oauth_callback.
--
--    Atomically claim one unexpired, unclaimed attempt for this owner, this
--    flow and this nonce, BEFORE the provider token exchange. The original
--    capture is never refreshed. A duplicate callback cannot reach a second
--    exchange. An interrupted claim needs a fresh authorization: there is
--    deliberately no exchange-recovery path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_meta_oauth_callback(
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
  v_nonce TEXT;
  v_flow TEXT;
  v_status TEXT;
  v_digest TEXT;
  v_claim TEXT;
  v_now TIMESTAMPTZ;
  v_deadline TIMESTAMPTZ;
  v_picker TIMESTAMPTZ;
  v_capture JSONB;
  v_attempt_flow TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MOA01';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'p_payload must be a JSON object' USING ERRCODE = 'MOA01';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('attempt_id', 'nonce', 'flow') THEN
      RAISE EXCEPTION 'unsupported payload key: %', v_key USING ERRCODE = 'MOA01';
    END IF;
  END LOOP;
  IF jsonb_typeof(p_payload -> 'attempt_id') <> 'string' THEN
    RAISE EXCEPTION 'attempt_id must be a uuid string' USING ERRCODE = 'MOA01';
  END IF;
  v_attempt := public.meta_oauth_attempt_uuid(p_payload ->> 'attempt_id', 'attempt_id');
  v_nonce := public.meta_oauth_attempt_identifier(
    p_payload ->> 'nonce', 'nonce', 256);
  IF jsonb_typeof(p_payload -> 'flow') <> 'string' THEN
    RAISE EXCEPTION 'flow is required' USING ERRCODE = 'MOA01';
  END IF;
  v_flow := p_payload ->> 'flow';

  -- The attempt lock is taken FIRST and on its own. No accepted credential,
  -- capability or job writer ever acquires an attempt, so this cannot
  -- deadlock against them.
  SELECT a.status, a.nonce_digest, a.callback_deadline, a.picker_deadline,
         a.capture, a.flow
    INTO v_status, v_digest, v_deadline, v_picker, v_capture, v_attempt_flow
    FROM public.meta_oauth_attempts AS a
   WHERE a.id = v_attempt
     AND a.user_id = p_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % is not owned by the given user', v_attempt
      USING ERRCODE = 'MOA02';
  END IF;

  IF v_status <> 'authorized' THEN
    RAISE EXCEPTION
      'oauth attempt % is already claimed and cannot be claimed again (status=%)',
      v_attempt, v_status
      USING ERRCODE = 'MOA03';
  END IF;

  IF v_digest IS DISTINCT FROM public.meta_oauth_attempt_digest(v_nonce) THEN
    RAISE EXCEPTION
      'the nonce does not match the oauth attempt %', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  IF v_attempt_flow IS DISTINCT FROM v_flow THEN
    RAISE EXCEPTION
      'the flow does not match the oauth attempt %', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  -- The live clock, not the transaction timestamp.
  v_now := clock_timestamp();
  IF v_now >= v_deadline THEN
    RAISE EXCEPTION
      'oauth attempt % expired before its callback was claimed', v_attempt
      USING ERRCODE = 'MOA08';
  END IF;

  v_claim := public.meta_oauth_attempt_random_hex();

  UPDATE public.meta_oauth_attempts AS a
     SET status = 'claimed',
         claim_token = v_claim,
         claimed_at = v_now,
         updated_at = now()
   WHERE a.id = v_attempt
     AND a.user_id = p_user_id
     AND a.status = 'authorized';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % was claimed concurrently', v_attempt
      USING ERRCODE = 'MOA03';
  END IF;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'flow', v_flow,
    'claim_token', v_claim,
    'claimed_at', v_now,
    'callback_deadline', v_deadline,
    'picker_deadline', v_picker,
    'capture', v_capture
  );
END;
$function$;

COMMENT ON FUNCTION public.claim_meta_oauth_callback(UUID, JSONB) IS
  'Atomically claims one unexpired, unclaimed oauth attempt for this owner, '
  'flow and nonce, before the provider token exchange. The original capture '
  'is never refreshed. A duplicate callback is refused.';

-- ---------------------------------------------------------------------------
-- 9. complete_meta_oauth_callback.
--
--    Require the exact claim and an unexpired attempt, validate the
--    service-provided verified candidates, persist the pending stash ONCE
--    and move the attempt to selection-ready. A replay cannot overwrite or
--    replace the stash.
-- ---------------------------------------------------------------------------
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
        'page_token_expires_at', 'page_token_expires_in'
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
  'A replay cannot overwrite or replace the stash.';

-- ---------------------------------------------------------------------------
-- 10. read_meta_oauth_attempt.
--
--     The nonsecret picker reader. It returns each candidate with its
--     stable selection key and the selection keys already committed. It
--     never returns a token.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_meta_oauth_attempt(
  p_user_id UUID,
  p_pending_selection_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_attempt UUID;
  v_flow TEXT;
  v_intent TEXT;
  v_profile UUID;
  v_picker TIMESTAMPTZ;
  v_expires_at TIMESTAMPTZ;
  v_candidates JSONB;
  v_committed TEXT[];
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = 'MOA01';
  END IF;

  SELECT ps.meta_oauth_attempt_id, ps.ig_candidates_json, ps.expires_at
    INTO v_attempt, v_candidates, v_expires_at
    FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id = p_pending_selection_id
     AND ps.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'pending selection % is not owned by the given user', p_pending_selection_id
      USING ERRCODE = 'MOA02';
  END IF;

  IF v_attempt IS NULL THEN
    RAISE EXCEPTION
      'pending selection % does not belong to an oauth attempt', p_pending_selection_id
      USING ERRCODE = 'MOA04';
  END IF;

  SELECT a.flow, a.intent, a.intended_social_profile_id, a.picker_deadline
    INTO v_flow, v_intent, v_profile, v_picker
    FROM public.meta_oauth_attempts AS a
   WHERE a.id = v_attempt AND a.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'oauth attempt % is not owned by the given user', v_attempt
      USING ERRCODE = 'MOA02';
  END IF;

  SELECT COALESCE(array_agg(r.selection_key ORDER BY r.selection_key), ARRAY[]::TEXT[])
    INTO v_committed
    FROM public.meta_oauth_attempt_receipts AS r
   WHERE r.attempt_id = v_attempt AND r.user_id = p_user_id;

  -- An expired attempt is not a picker. The nonsecret identifiers stay;
  -- the selectable candidates do not.
  IF clock_timestamp() >= v_picker
     OR (v_expires_at IS NOT NULL AND clock_timestamp() >= v_expires_at) THEN
    RETURN jsonb_build_object(
      'attempt_id', v_attempt,
      'flow', v_flow,
      'intent', v_intent,
      'social_profile_id', v_profile,
      'picker_deadline', v_picker,
      'expires_at', v_expires_at,
      'status', 'expired',
      'expired', true,
      'committed_selection_keys', v_committed,
      'candidates', '[]'::JSONB
    );
  END IF;

  RETURN jsonb_build_object(
    'attempt_id', v_attempt,
    'flow', v_flow,
    'intent', v_intent,
    'social_profile_id', v_profile,
    'picker_deadline', v_picker,
    'expires_at', v_expires_at,
    'committed_selection_keys', v_committed,
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
        FROM jsonb_array_elements(v_candidates) AS e(value)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.read_meta_oauth_attempt(UUID, UUID) IS
  'Nonsecret reader for the picker. Returns the attempt, each candidate with '
  'its stable selection key and the selection keys already committed. Never '
  'returns a token, a code or a raw provider response.';

-- One owned operational account. A named id is the captured target and keeps
-- its provider identity. A null id is create-only: a natural-key collision
-- is a typed reconnect refusal, never an adoption.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_upsert_operational_account(
  p_user_id UUID,
  p_existing_id UUID,
  p_platform TEXT,
  p_platform_user_id TEXT,
  p_username TEXT,
  p_avatar TEXT,
  p_token TEXT,
  p_expires_at TIMESTAMPTZ,
  p_profile UUID,
  p_ig_auth_type TEXT
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_account UUID;
  v_live_identity TEXT;
BEGIN
  IF p_existing_id IS NOT NULL THEN
    UPDATE public.social_accounts AS sa
       SET platform_username = CASE WHEN p_username IS NULL
                                     THEN sa.platform_username ELSE p_username END,
           avatar_url = CASE WHEN p_avatar IS NULL THEN sa.avatar_url ELSE p_avatar END,
           access_token = p_token,
           token_expires_at = p_expires_at,
           is_active = true,
           social_profile_id = CASE WHEN p_profile IS NULL
                                     THEN sa.social_profile_id ELSE p_profile END,
           needs_reauth = false,
           failure_count = 0,
           last_refresh_error = NULL,
           ig_auth_type = COALESCE(p_ig_auth_type, sa.ig_auth_type),
           updated_at = now()
     WHERE sa.id = p_existing_id
       AND sa.user_id = p_user_id
       AND sa.platform = p_platform
       AND sa.platform_user_id = p_platform_user_id
    RETURNING sa.id INTO v_account;
    IF NOT FOUND THEN
      SELECT sa.platform_user_id INTO v_live_identity
        FROM public.social_accounts AS sa
       WHERE sa.id = p_existing_id AND sa.user_id = p_user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'the captured reconnect target no longer exists'
          USING ERRCODE = 'MOA07';
      END IF;
      RAISE EXCEPTION
        'the verified provider identity does not match the captured reconnect target'
        USING ERRCODE = 'MOA07';
    END IF;
    RETURN v_account;
  END IF;

  BEGIN
    INSERT INTO public.social_accounts (
      user_id, platform, platform_user_id, platform_username, avatar_url,
      access_token, token_expires_at, is_active, social_profile_id,
      needs_reauth, failure_count, last_refresh_error, ig_auth_type,
      connected_at, updated_at
    ) VALUES (
      p_user_id, p_platform, p_platform_user_id, p_username, p_avatar,
      p_token, p_expires_at, true, p_profile,
      false, 0, NULL, COALESCE(p_ig_auth_type, 'facebook_page'),
      now(), now()
    )
    RETURNING id INTO v_account;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION
        'an account with this provider identity already exists; reconnect it explicitly'
        USING ERRCODE = 'MOA05';
  END;
  RETURN v_account;
END;
$function$;

-- The Instagram capability generation this selection itself advances.
-- Facebook Page accounts do not get an Instagram capability row.
CREATE OR REPLACE FUNCTION public.meta_oauth_attempt_bump_instagram_capability(
  p_user_id UUID,
  p_account UUID,
  p_login_kind TEXT,
  p_operation TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_generation BIGINT;
  v_next BIGINT;
BEGIN
  SELECT c.credential_generation
    INTO v_generation
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_account AND c.user_id = p_user_id;

  IF v_generation IS NULL THEN
    INSERT INTO public.instagram_account_capabilities (
      social_account_id, user_id, platform, login_kind, permission_read_state,
      granted_scopes, credential_generation, credential_updated_at,
      generation_reason, created_at, updated_at
    ) VALUES (
      p_account, p_user_id, 'instagram', p_login_kind, 'unknown',
      ARRAY[]::TEXT[], 0, now(), 'oauth_lifecycle_commit', now(), now()
    );
    v_generation := 0;
  END IF;

  UPDATE public.instagram_account_capabilities AS c
     SET login_kind = p_login_kind,
         permission_read_state = 'unknown',
         granted_scopes = ARRAY[]::TEXT[],
         scopes_read_at = NULL,
         last_read_failed_at = NULL,
         last_read_error_code = NULL,
         credential_generation = c.credential_generation + 1,
         credential_updated_at = now(),
         generation_reason = 'oauth_lifecycle_commit',
         reconnected_at = CASE WHEN p_operation = 'reconnected'
                               THEN now() ELSE c.reconnected_at END,
         updated_at = now()
   WHERE c.social_account_id = p_account
     AND c.user_id = p_user_id
     AND c.credential_generation = v_generation
  RETURNING c.credential_generation INTO v_next;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the capability generation of the account moved while the selection was committed'
      USING ERRCODE = 'MOA07';
  END IF;
  RETURN v_next;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 11. commit_meta_oauth_selection.
--
--     The atomic transition. One verified candidate from the attempt's own
--     stash, applied in one transaction: create or reactivate the account,
--     write the operational token, bind or rebind the shared Facebook User
--     credential, advance the fences and the capability generation, reset
--     stale permission evidence, record the nonsecret receipt and consume
--     the selected secret.
-- ---------------------------------------------------------------------------
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
  'the selected secret. An identical retry returns the same receipt with '
  'ZERO mutations; a conflicting retry refuses.';

-- ---------------------------------------------------------------------------
-- 12. purge_expired_meta_oauth_pending.
--
--     The cleanup later operations call. It is service-only and bounded.
--     There is no scheduler in this migration. Expired protected rows and
--     expired legacy rows are deleted in separate statements, so a protected
--     refusal cannot roll the legacy delete back. Attempts and receipts stay.
--     Accounts and history are not touched.
--
--     A later TypeScript writer must reject a pending row whose
--     meta_oauth_attempt_id is not null BEFORE any provider or account
--     mutation, on every legacy writer path, regardless of mode. This
--     function does not close that read-caller path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_meta_oauth_pending(
  p_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_attempt UUID;
  v_protected INTEGER := 0;
  v_legacy INTEGER := 0;
  v_attempts INTEGER := 0;
  v_removed INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = 'MOA01';
  END IF;

  FOR v_attempt IN
    SELECT a.id
      FROM public.meta_oauth_attempts AS a
     WHERE a.pending_selection_id IS NOT NULL
       AND a.picker_deadline <= clock_timestamp()
       AND a.status IN ('authorized', 'claimed', 'selection_ready')
     ORDER BY a.picker_deadline, a.id
     LIMIT p_limit
     FOR UPDATE
  LOOP
    PERFORM set_config('postora.meta_oauth_purge', v_attempt::TEXT, true);
    DELETE FROM public.oauth_pending_instagram_selections AS ps
     WHERE ps.meta_oauth_attempt_id = v_attempt
       AND ps.expires_at <= clock_timestamp();
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    v_protected := v_protected + v_removed;
    DELETE FROM public.oauth_pending_facebook_selections AS ps
     WHERE ps.meta_oauth_attempt_id = v_attempt
       AND ps.expires_at <= clock_timestamp();
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    v_protected := v_protected + v_removed;
    UPDATE public.meta_oauth_attempts AS a
       SET status = 'expired',
           pending_selection_id = NULL,
           updated_at = now()
     WHERE a.id = v_attempt;
    v_attempts := v_attempts + 1;
    PERFORM set_config('postora.meta_oauth_purge', '', true);
  END LOOP;

  DELETE FROM public.oauth_pending_instagram_selections AS ps
   WHERE ps.id IN (
     SELECT p.id
       FROM public.oauth_pending_instagram_selections AS p
      WHERE p.meta_oauth_attempt_id IS NULL
        AND p.expires_at <= clock_timestamp()
      ORDER BY p.expires_at, p.id
      LIMIT p_limit
   );
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_legacy := v_legacy + v_removed;

  DELETE FROM public.oauth_pending_facebook_selections AS ps
   WHERE ps.id IN (
     SELECT p.id
       FROM public.oauth_pending_facebook_selections AS p
      WHERE p.meta_oauth_attempt_id IS NULL
        AND p.expires_at <= clock_timestamp()
      ORDER BY p.expires_at, p.id
      LIMIT p_limit
   );
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  v_legacy := v_legacy + v_removed;

  RETURN jsonb_build_object(
    'protected_rows_removed', v_protected,
    'legacy_rows_removed', v_legacy,
    'attempts_expired', v_attempts
  );
END;
$function$;

COMMENT ON FUNCTION public.purge_expired_meta_oauth_pending(INTEGER) IS
  'Service-only bounded deletion of expired Meta pending stashes. Protected '
  'rows and legacy rows are deleted separately. The attempt and its receipts '
  'are retained with status expired. Later operations call this; there is no '
  'scheduler here.';

-- ---------------------------------------------------------------------------
-- 13. Privileges.
--
--     The stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
--     anon, authenticated, so every REVOKE below is load-bearing, not
--     decoration. Nothing new here is reachable by a browser role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.meta_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_oauth_attempt_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.meta_oauth_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meta_oauth_attempt_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meta_oauth_attempts FROM service_role;
REVOKE ALL ON public.meta_oauth_attempt_receipts FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.meta_oauth_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.meta_oauth_attempt_receipts TO service_role;

REVOKE ALL ON FUNCTION public.meta_oauth_attempt_digest(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_random_hex() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_identifier(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_uuid(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_object(JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_selection_key(TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_lock_profile(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_capture_account(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_capture_grant(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_live_grant_members(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_progression_accounts(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_timestamptz(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_anchor_expiry(TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_lock_owner(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_lock_accounts(UUID, UUID[], UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_require_captured_account(UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_assert_live_expiries(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_assert_deadline(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_require_members(UUID, UUID, BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_invalidate_grant(UUID, UUID, JSONB, UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_upsert_operational_account(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_bump_instagram_capability(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_guard_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.meta_oauth_attempt_guard_pending_row() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_digest(TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_random_hex() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_identifier(TEXT, TEXT, INTEGER) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_uuid(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_object(JSONB, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_selection_key(TEXT, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_lock_profile(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_capture_account(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_capture_grant(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_live_grant_members(UUID, UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_progression_accounts(JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_timestamptz(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_anchor_expiry(TEXT, TEXT, TIMESTAMPTZ, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_lock_owner(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_lock_accounts(UUID, UUID[], UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_require_captured_account(UUID, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_assert_live_expiries(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_assert_deadline(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_require_members(UUID, UUID, BIGINT, TEXT, JSONB) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_invalidate_grant(UUID, UUID, JSONB, UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_upsert_operational_account(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_bump_instagram_capability(UUID, UUID, TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_guard_immutable() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.meta_oauth_attempt_guard_pending_row() TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.begin_meta_oauth_attempt(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_meta_oauth_callback(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_meta_oauth_callback(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_meta_oauth_selection(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_meta_oauth_attempt(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_meta_oauth_pending(INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_meta_oauth_attempt(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_meta_oauth_callback(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_meta_oauth_callback(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_meta_oauth_selection(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_meta_oauth_attempt(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_meta_oauth_pending(INTEGER) TO service_role;

-- The accepted Phase 1 internals this contract reuses. The grants are
-- idempotent and keep the reuse explicit.
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_lock_scope(UUID[], UUID[]) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_allocate_connection_version(UUID, UUID, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_commit_connection_version(UUID, UUID, BIGINT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.facebook_user_credential_sync_instagram_linkage(UUID, UUID, UUID) TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- 14. Assert the boundary this migration claims, before it commits.
--
--     A migration that reports success while the boundary is not in place is
--     worse than one that fails.
-- ---------------------------------------------------------------------------
DO $assert_boundary$
DECLARE
  t_name text;
  p_name text;
  f_sig regprocedure;
  v_attempt_column record;
BEGIN
  -- 13.1. The attempt tables exist, are ordinary tables, and RLS is on.
  FOREACH t_name IN ARRAY ARRAY[
    'meta_oauth_attempts',
    'meta_oauth_attempt_receipts'
  ] LOOP
    ASSERT (
      SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('RLS is enabled on public.%s', t_name);

    ASSERT NOT EXISTS (
      SELECT 1
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t_name
    ), format('no browser policy exists on public.%s', t_name);

    FOREACH p_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER', 'MAINTAIN'
    ] LOOP
      ASSERT NOT has_table_privilege('anon', format('public.%s', t_name), p_name),
        format('anon holds no %s privilege on public.%s', p_name, t_name);
      ASSERT NOT has_table_privilege('authenticated', format('public.%s', t_name), p_name),
        format('authenticated holds no %s privilege on public.%s', p_name, t_name);
    END LOOP;

    FOREACH p_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      ASSERT has_table_privilege('service_role', format('public.%s', t_name), p_name),
        format('service_role keeps %s on public.%s', p_name, t_name);
    END LOOP;
  END LOOP;

  -- 13.2. The appended attempt reference is nullable, has no default and
  --       is the LAST column of each pending table. The legacy shape is
  --       otherwise untouched.
  FOREACH t_name IN ARRAY ARRAY[
    'oauth_pending_facebook_selections',
    'oauth_pending_instagram_selections'
  ] LOOP
    SELECT a.attnotnull, a.atthasdef, a.attnum
      INTO v_attempt_column
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = t_name
       AND a.attname = 'meta_oauth_attempt_id';

    ASSERT FOUND,
      format('public.%s carries the attempt reference', t_name);
    ASSERT v_attempt_column.attnotnull = false,
      format('public.%s.meta_oauth_attempt_id is nullable', t_name);
    ASSERT v_attempt_column.atthasdef = false,
      format('public.%s.meta_oauth_attempt_id has no default', t_name);

    ASSERT (
      SELECT max(a.attnum)
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = t_name
         AND a.attnum > 0
         AND NOT a.attisdropped
    ) = v_attempt_column.attnum,
      format('public.%s.meta_oauth_attempt_id is the appended last column', t_name);

    ASSERT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = 'public'
         AND r.relname = t_name
         AND c.contype = 'f'
         AND c.conkey = ARRAY[
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = t_name
              AND a.attname = 'meta_oauth_attempt_id'),
           (SELECT attnum FROM pg_attribute a
             JOIN pg_class cc ON cc.oid = a.attrelid
             JOIN pg_namespace nn ON nn.oid = cc.relnamespace
            WHERE nn.nspname = 'public' AND cc.relname = t_name
              AND a.attname = 'user_id')
         ]::smallint[]
    ), format('public.%s carries the owner-matching attempt foreign key', t_name);
  END LOOP;

  -- 13.3. The public RPC surface is service-only.
  FOREACH f_sig IN ARRAY ARRAY[
    'public.begin_meta_oauth_attempt(uuid,jsonb)',
    'public.claim_meta_oauth_callback(uuid,jsonb)',
    'public.complete_meta_oauth_callback(uuid,jsonb)',
    'public.commit_meta_oauth_selection(uuid,jsonb)',
    'public.read_meta_oauth_attempt(uuid,uuid)',
    'public.purge_expired_meta_oauth_pending(integer)'
  ]::regprocedure[] LOOP
    ASSERT has_function_privilege('service_role', f_sig, 'EXECUTE'),
      format('service_role may execute %s', f_sig);
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('anon may not execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('authenticated may not execute %s', f_sig);
  END LOOP;

  -- 13.4. No browser-reachable SECURITY DEFINER function reaches the new
  --        relations besides the five service-only lifecycle RPCs.
  FOR f_sig IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND (
         p.prosrc ILIKE '%meta_oauth_attempts%'
         OR p.prosrc ILIKE '%meta_oauth_attempt_receipts%'
       )
       AND p.proname NOT IN (
         'begin_meta_oauth_attempt', 'claim_meta_oauth_callback',
         'complete_meta_oauth_callback', 'commit_meta_oauth_selection',
         'read_meta_oauth_attempt', 'purge_expired_meta_oauth_pending'
       )
  LOOP
    ASSERT NOT has_function_privilege('anon', f_sig, 'EXECUTE'),
      format('anon may not execute %s', f_sig);
    ASSERT NOT has_function_privilege('authenticated', f_sig, 'EXECUTE'),
      format('authenticated may not execute %s', f_sig);
  END LOOP;

  -- 13.5. The pending stashes keep their legacy secret columns.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'oauth_pending_facebook_selections'
       AND column_name = 'provider_token'
  ), 'the Facebook pending stash still carries its provider token column';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'oauth_pending_instagram_selections'
       AND column_name = 'long_lived_token'
  ), 'the Instagram pending stash still carries its long lived token column';

  RAISE NOTICE
    'meta oauth attempt lifecycle: verified. attempt tables are service-only with no policy,'
    ' the pending stashes carry a nullable owner-matching attempt reference, and the six'
    ' lifecycle RPCs are service-only.';
END
$assert_boundary$;

COMMENT ON COLUMN public.oauth_pending_facebook_selections.meta_oauth_attempt_id IS
  'The OAuth attempt that owns this stash row. NULL for a legacy row, which '
  'keeps the legacy writer behaviour exactly. A non-null value is an owner-'
  'matching composite reference, and only that attempt may write or consume '
  'the row.';

COMMENT ON COLUMN public.oauth_pending_instagram_selections.meta_oauth_attempt_id IS
  'The OAuth attempt that owns this stash row. NULL for a legacy row, which '
  'keeps the legacy writer behaviour exactly. A non-null value is an owner-'
  'matching composite reference, and only that attempt may write or consume '
  'the row.';

COMMIT;
