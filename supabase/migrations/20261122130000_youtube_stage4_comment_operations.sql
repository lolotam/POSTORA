-- ===========================================================================
-- 20261122130000_youtube_stage4_comment_operations.sql
--
-- YouTube Stage 4 (comments and moderation) - the durable write receipt,
-- the binding generation, the digest keys and the rollout authority.
--
-- Spec:  docs/specs/2026-11-22-youtube-stage4-comments.md
-- Plan:  docs/plans/2026-11-22-youtube-stage4-comments.md
--
-- APPLY AS supabase_admin, the migration role of this stack. It owns every
-- function below; postgres is not a superuser here and a REVOKE by a
-- non-owner is a WARNING that changes nothing.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS
--
--   1. `social_accounts.binding_generation`, a trigger-maintained counter
--      that names the CONNECTION a receipt was created under.
--   2. `youtube_comment_operations`, the durable receipt of one deliberate
--      write: one row per submit, one state machine, one attempt.
--   3. `youtube_comment_digest_keys`, the HMAC keys the Edge handler uses to
--      fingerprint an intent and a logical comment, versioned and never
--      silently retired.
--   4. Six service-only functions: the rollout evaluator, the digest-key
--      reader, the claim, the mark, the settle and the status.
--
--   The migration is ADDITIVE. It changes no existing table shape, adds no
--   column to any other table, replaces no existing function body, and
--   creates no schedule.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS NOT
--
--   * Not an activation. The rollout key is NOT seeded, so every capability
--     is off and Stage 4 is dark after this migration lands.
--   * Not a grant change. No stored scope, `needs_reauth`, `failure_count` or
--     account health is touched here.
--   * Not a public surface. Both new tables have RLS on, no policies and no
--     grants to `anon` or `authenticated`. The six functions are
--     SECURITY DEFINER with a pinned search_path, revoked from PUBLIC, anon
--     and authenticated, and granted to the service role alone.
--
-- ---------------------------------------------------------------------------
-- THE BINDING GENERATION (spec 6.2, amended)
--
--   The generation names the CONNECTION a receipt belongs to. It must not
--   move when the trusted refresh rotates a token, and it MUST move when
--   anything else changes the credentials or the identity of the row.
--
--   DETECTING THE TRUSTED REFRESH. The design revision first proposed
--   "the statement is running inside a SECURITY DEFINER function, so
--   `current_user` is the migration owner role and not `authenticated`,
--   `anon` or `service_role`". That is NOT a positive identification:
--
--     * every function on this stack is owned by `supabase_admin`, so
--       `current_user` is `supabase_admin` inside ALL of them, including any
--       future one that nobody has reviewed;
--     * a catalog scan can list candidate writers, but a list is not an
--       authority - it says what MIGHT write, not what MAY write;
--     * `service_role` reaches the database directly through PostgREST, so a
--       "not service_role" test excludes only the AUTHENTICATED path and
--       leaves the direct service-role write unclassified.
--
--   So this migration uses an EXCLUSIVE, NARROWLY PRIVILEGED AUTHORITY
--   instead: a dedicated NOLOGIN role, `youtube_stage4_refresh`, which owns
--   EXACTLY the two trusted refresh functions and nothing else. Inside those
--   two functions `current_user` is that role; everywhere else it is
--   `authenticated`, `anon`, `service_role`, `supabase_admin` or a caller.
--   The role cannot log in, is a member of no role, and holds no role that
--   is a member of it, so no other statement can ever execute as it.
--
--   The two functions keep their bodies. What changes is their OWNER, so
--   their effective role becomes the narrow authority instead of the
--   superuser that owns everything else on this stack. Their grants are
--   restated below, and the existing `youtube_token_refresh.sql` and
--   `youtube_refresh_lease.sql` suites - which exercise both of them - stay
--   green, which is the compatibility proof.
--
--   A future migration that has to REPLACE either body must first take the
--   ownership back:
--
--     ALTER FUNCTION public.store_youtube_refreshed_token(
--       uuid, text, text, timestamptz, text, timestamptz
--     ) OWNER TO supabase_admin;
--     -- CREATE OR REPLACE ... here ...
--     ALTER FUNCTION public.store_youtube_refreshed_token(
--       uuid, text, text, timestamptz, text, timestamptz
--     ) OWNER TO youtube_stage4_refresh;
--
--   A future migration that adds a THIRD trusted refresh writer must own it
--   with the same role and extend the allow-list test in
--   `supabase/tests/youtube_comment_operations.sql`, which fails when the
--   set of credential writers stops being exactly the expected set.
--
-- ---------------------------------------------------------------------------
-- THE RECEIPT (spec 7)
--
--   One row per deliberate submit. The row is the durable intent: if the
--   claim cannot be recorded, nothing is dispatched.
--
--   `claimed`      the claim is held; nothing has been sent.
--   `dispatched`   the mark committed. THE AUTHORISATION BOUNDARY. From
--                  this instant the operation is never sent again by anyone
--                  under any key, and its row is never deleted.
--   `confirmed`    the request was accepted, with evidence about THIS
--                  request.
--   `refused`      the request was definitely not applied.
--   `indeterminate` the outcome is unknown. PERMANENT for create, reply and
--                  any reject. Never retried, swept, pruned or cleared.
--
--   The logical digest covers `(channel_id, video_id, canonical parent,
--   normalised text)` and nothing else, so a second submit of the same
--   logical comment is refused under any key, on any generation, on a
--   re-created account row. The intent digest covers the whole intent, so
--   one key reused for a different intent is a conflict.
--
--   The digest keys live in SQL and are versioned. A claim carries the
--   logical digest under EVERY retained version, so evidence written under
--   an old key still blocks. A version referenced by any row cannot be
--   removed.
--
-- ---------------------------------------------------------------------------
-- THE ROLLOUT (spec 13)
--
--   One private `app_settings` key, `youtube_comments_stage4_rollout`, holds
--   the per-account, per-capability admission:
--
--     {
--       "version": 1,
--       "accounts": {
--         "<social_accounts.id>": { "read": true, "held": false,
--                                   "write": false, "ban": false }
--       }
--     }
--
--   It is NOT seeded by this migration. Absent means everything off. There
--   is no wildcard and no "all accounts" mode: two accounts in one policy
--   are independent, so enabling `ban` for one does nothing for the other.
--   A missing key, an unknown version, a malformed document, a missing
--   account, a missing capability or a non-boolean capability all DENY.
--   A failed READ is an error, never a deny that looks like "off".
--
--   The capability prerequisites are structural: `held` needs `read`,
--   `write` needs `read`, and `ban` needs `write`.
--
--   The evaluator is the single authority, and it is consulted at every read
--   action, at the claim and the mark of every write, at the ban
--   confirmation, and at any reconciliation read. `youtube_comment_op_status`
--   is deliberately NOT behind the policy: with every capability off, or the
--   key removed, an owner can still read the local receipt of an operation
--   under the CURRENT binding.
--
-- ---------------------------------------------------------------------------
-- THE LOCK ORDER (do not invert this)
--
--   1. social_accounts FOR UPDATE (the owner-scoped account row),
--   2. youtube_comment_operations FOR UPDATE (the owner's own row),
--   3. the advisory lock on (owner, channel, logical digest).
--
--   The account row comes first everywhere, so a claim, a mark and a settle
--   can never deadlock against each other.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The narrow refresh authority.
-- ===========================================================================

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'youtube_stage4_refresh') THEN
    CREATE ROLE youtube_stage4_refresh
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  ELSE
    -- A prior run may have created the role without BYPASSRLS. Make sure the
    -- narrow authority can read and write through RLS on the two tables it
    -- owns the refresh bodies for.
    ALTER ROLE youtube_stage4_refresh BYPASSRLS;
  END IF;
END
$role$;

ALTER ROLE youtube_stage4_refresh BYPASSRLS;

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on the
-- containing schema. The grant is taken for the ALTER and withdrawn again
-- immediately, so the role ends up owning two functions and nothing else.
GRANT CREATE ON SCHEMA public TO youtube_stage4_refresh;

DO $reown$
DECLARE
  v_missing text;
BEGIN
  -- Both functions must already exist. Their absence means the baseline is
  -- not what this migration was written against, and guessing is not an
  -- option: the generation authority depends on them.
  SELECT string_agg(name, ', ')
    INTO v_missing
    FROM unnest(ARRAY[
      'store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)',
      'store_youtube_refreshed_token_with_lease(uuid,uuid,text,timestamptz,text,text[])'
    ]) AS name
   WHERE to_regprocedure('public.' || name) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'the trusted refresh functions are missing: %', v_missing;
  END IF;

  EXECUTE 'ALTER FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz) OWNER TO youtube_stage4_refresh';
  EXECUTE 'ALTER FUNCTION public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[]) OWNER TO youtube_stage4_refresh';
END
$reown$;

REVOKE CREATE ON SCHEMA public FROM youtube_stage4_refresh;

-- The narrow role now holds exactly what the two trusted bodies need:
-- the account row they read and write, and the lease row the lease variant
-- reads, updates and closes. It cannot log in, and it is granted to nobody.
-- USAGE on the public schema is needed so the function bodies can resolve
-- `public.social_accounts%ROWTYPE` and the qualified table names.
GRANT USAGE ON SCHEMA public TO youtube_stage4_refresh;
-- UPDATE is limited to the columns the two bodies actually write; the
-- identity columns (platform_user_id, auth_provider, connection_id, is_active,
-- user_id, ...) are not writable by this role at all.
GRANT SELECT ON public.social_accounts TO youtube_stage4_refresh;
GRANT UPDATE (access_token, refresh_token, token_expires_at, needs_reauth,
              failure_count, last_refresh_error, account_metadata, updated_at)
  ON public.social_accounts TO youtube_stage4_refresh;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.youtube_token_refresh_leases
  TO youtube_stage4_refresh;

-- The EXECUTE surface is restated so the ownership change cannot have
-- widened it. The service role is the only caller; the browser never is.
REVOKE ALL ON FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_youtube_refreshed_token(uuid, text, text, timestamptz, text, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_youtube_refreshed_token_with_lease(uuid, uuid, text, timestamptz, text, text[])
  TO service_role;

COMMENT ON ROLE youtube_stage4_refresh IS
  'Exclusive narrowly privileged authority for the YouTube trusted refresh path. '
  'It owns EXACTLY public.store_youtube_refreshed_token and '
  'public.store_youtube_refreshed_token_with_lease, so the binding-generation '
  'trigger can identify the trusted refresh writer positively by current_user '
  'instead of by a shared owner role. NOLOGIN, member of no role, granted to '
  'no role: no statement other than those two function bodies can ever '
  'execute as it.';

-- ===========================================================================
-- 2. The binding generation.
-- ===========================================================================

ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS binding_generation bigint NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.social_accounts.binding_generation IS
  'Connection generation of a YouTube account row. Advanced by exactly one '
  'when the identity columns change, or when the credential columns change '
  'outside the trusted refresh authority (youtube_stage4_refresh). Kept when '
  'the trusted refresh rotates the credentials. Maintained by the trigger '
  'trg_social_accounts_youtube_binding_generation; a client-supplied value is '
  'always overwritten.';

-- The trigger assigns NEW.binding_generation and reads NO other relation.
-- It is SECURITY INVOKER on purpose: `current_user` inside it is the role
-- that ran the UPDATE, which is the only thing that identifies the writer.
CREATE OR REPLACE FUNCTION public.youtube_stage4_assign_binding_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_identity_changed boolean := false;
  v_credential_changed boolean := false;
  v_trusted_refresh boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A client-supplied generation is overwritten in every case.
    NEW.binding_generation := 1;
    RETURN NEW;
  END IF;

  IF NEW.platform <> 'youtube' AND OLD.platform <> 'youtube' THEN
    -- A non-YouTube row never changes.
    NEW.binding_generation := OLD.binding_generation;
    RETURN NEW;
  END IF;

  v_identity_changed :=
       NEW.user_id          IS DISTINCT FROM OLD.user_id
    OR NEW.platform         IS DISTINCT FROM OLD.platform
    OR NEW.platform_user_id IS DISTINCT FROM OLD.platform_user_id
    OR NEW.auth_provider    IS DISTINCT FROM OLD.auth_provider
    OR NEW.connection_id    IS DISTINCT FROM OLD.connection_id
    OR NEW.connected_at     IS DISTINCT FROM OLD.connected_at
    OR NEW.is_active        IS DISTINCT FROM OLD.is_active;

  v_credential_changed :=
       NEW.access_token  IS DISTINCT FROM OLD.access_token
    OR NEW.refresh_token IS DISTINCT FROM OLD.refresh_token;

  IF v_identity_changed THEN
    -- An identity change is a new binding for EVERY caller, with no
    -- exception: even the trusted refresh authority cannot preserve it,
    -- because the refresh authority is not allowed to change an identity.
    NEW.binding_generation := OLD.binding_generation + 1;
    RETURN NEW;
  END IF;

  IF v_credential_changed THEN
    -- The ONLY writer that may preserve the generation is the exclusive
    -- narrow authority that owns the two trusted refresh functions. A
    -- browser write, a direct service-role write and any other function
    -- advance the generation.
    v_trusted_refresh := (current_user = 'youtube_stage4_refresh');
    IF v_trusted_refresh THEN
      NEW.binding_generation := OLD.binding_generation;
    ELSE
      NEW.binding_generation := OLD.binding_generation + 1;
    END IF;
    RETURN NEW;
  END IF;

  -- Metadata, health, expiry and timestamp writes keep the binding.
  NEW.binding_generation := OLD.binding_generation;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.youtube_stage4_assign_binding_generation() IS
  'Trigger function: assigns NEW.binding_generation on social_accounts. '
  'SECURITY INVOKER, so current_user is the role that ran the UPDATE - the '
  'only positive identification of the trusted refresh writer. An identity '
  'change always advances the generation; a credential change advances it '
  'unless current_user is youtube_stage4_refresh, the exclusive narrow '
  'authority that owns exactly the two trusted refresh functions. Reads no '
  'other relation.';

DROP TRIGGER IF EXISTS trg_social_accounts_youtube_binding_generation
  ON public.social_accounts;

CREATE TRIGGER trg_social_accounts_youtube_binding_generation
  BEFORE INSERT OR UPDATE ON public.social_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.youtube_stage4_assign_binding_generation();

COMMENT ON TRIGGER trg_social_accounts_youtube_binding_generation
  ON public.social_accounts IS
  'Maintains social_accounts.binding_generation. It is independent of '
  'trg_social_accounts_youtube_credential_revoke_refresh_lease, and both '
  'keep working in either firing order.';

-- ===========================================================================
-- 3. The digest keys.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.youtube_comment_digest_keys (
  version    integer PRIMARY KEY,
  key        bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT youtube_comment_digest_keys_version_positive CHECK (version > 0)
);

COMMENT ON TABLE public.youtube_comment_digest_keys IS
  'Versioned HMAC keys for the Stage 4 intent and logical digests. Private: '
  'RLS on, no policies, no client grants, no grant to the service role. The '
  'keys are read only through youtube_comment_digest_keys().';

ALTER TABLE public.youtube_comment_digest_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_comment_digest_keys FROM PUBLIC, anon, authenticated, service_role;

-- Version 1 is generated here from core functions only: sha256() over two
-- gen_random_uuid() values. No extension is assumed.
INSERT INTO public.youtube_comment_digest_keys (version, key)
VALUES (1, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')))
ON CONFLICT (version) DO NOTHING;

-- A version that any receipt still references cannot be removed, and the
-- active version cannot be removed at all. This is the "rotation adds a
-- version and never deletes one while any row references it" rule, made
-- structural instead of a convention.
CREATE OR REPLACE FUNCTION public.youtube_stage4_guard_digest_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.youtube_comment_operations
       WHERE digest_key_version = OLD.version
    ) THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: digest key version % is still referenced by a receipt',
        OLD.version;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.youtube_comment_digest_keys
       WHERE retired_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: the last active digest key cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION
      'youtube_stage4_guard_digest_keys: a digest key version cannot be changed';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.youtube_stage4_guard_digest_keys() IS
  'Trigger function on youtube_comment_digest_keys. A version referenced by '
  'any receipt cannot be deleted, the last active version cannot be deleted, '
  'and a version cannot be renumbered.';

DROP TRIGGER IF EXISTS trg_youtube_comment_digest_keys_guard
  ON public.youtube_comment_digest_keys;

CREATE TRIGGER trg_youtube_comment_digest_keys_guard
  BEFORE UPDATE OR DELETE ON public.youtube_comment_digest_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.youtube_stage4_guard_digest_keys();

-- ===========================================================================
-- 4. The receipt table.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.youtube_comment_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id       uuid NOT NULL,
  social_account_id  uuid REFERENCES public.social_accounts(id) ON DELETE SET NULL,
  account_ref        uuid NOT NULL,
  channel_id         text NOT NULL,
  binding_generation bigint NOT NULL,
  auth_provider      text NOT NULL DEFAULT 'native',
  action             text NOT NULL,
  video_id           text,
  thread_id          text,
  parent_comment_id  text,
  comment_id         text,
  author_channel_id  text,
  moderation_status  text,
  ban_author         boolean NOT NULL DEFAULT false,
  intent_digest      text NOT NULL,
  logical_digest     text,
  digest_key_version integer NOT NULL,
  state              text NOT NULL,
  attempt_token      uuid NOT NULL,
  reason             text,
  provider_class     text,
  request_id         text,
  result_thread_id   text,
  result_comment_id  text,
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  dispatched_at      timestamptz,
  settled_at         timestamptz,

  CONSTRAINT youtube_comment_operations_owner_operation_key
    UNIQUE (owner_id, operation_id),
  CONSTRAINT youtube_comment_operations_action_check
    CHECK (action IN ('create_thread', 'reply', 'edit', 'moderate')),
  CONSTRAINT youtube_comment_operations_state_check
    CHECK (state IN ('claimed', 'dispatched', 'confirmed', 'refused', 'indeterminate')),
  CONSTRAINT youtube_comment_operations_provider_check
    CHECK (provider_class IS NULL OR provider_class IN ('http_4xx', 'http_5xx', 'network', 'timeout', 'none')),
  CONSTRAINT youtube_comment_operations_auth_provider_check
    CHECK (auth_provider = 'native'),
  CONSTRAINT youtube_comment_operations_ban_check
    CHECK (
      NOT ban_author
      OR (
        action = 'moderate'
        AND moderation_status = 'rejected'
        AND author_channel_id IS NOT NULL
        AND btrim(author_channel_id) <> ''
      )
    ),
  CONSTRAINT youtube_comment_operations_create_thread_check
    CHECK (
      action <> 'create_thread'
      OR (
        video_id IS NOT NULL AND btrim(video_id) <> ''
        AND thread_id IS NULL
        AND parent_comment_id IS NULL
        AND comment_id IS NULL
        AND logical_digest IS NOT NULL
      )
    ),
  CONSTRAINT youtube_comment_operations_reply_check
    CHECK (
      action <> 'reply'
      OR (
        video_id IS NOT NULL AND btrim(video_id) <> ''
        AND parent_comment_id IS NOT NULL AND btrim(parent_comment_id) <> ''
        AND comment_id IS NULL
        AND logical_digest IS NOT NULL
      )
    ),
  CONSTRAINT youtube_comment_operations_edit_check
    CHECK (
      action <> 'edit'
      OR (
        video_id IS NOT NULL AND btrim(video_id) <> ''
        AND comment_id IS NOT NULL AND btrim(comment_id) <> ''
        AND logical_digest IS NULL
      )
    ),
  CONSTRAINT youtube_comment_operations_moderate_check
    CHECK (
      action <> 'moderate'
      OR (
        video_id IS NOT NULL AND btrim(video_id) <> ''
        AND comment_id IS NOT NULL AND btrim(comment_id) <> ''
        AND moderation_status IS NOT NULL
        AND moderation_status IN ('published', 'heldForReview', 'rejected')
        AND logical_digest IS NULL
      )
    ),
  -- The logical digest exists only for the two actions that can create a
  -- public comment. Every other action carries NULL.
  CONSTRAINT youtube_comment_operations_logical_digest_check
    CHECK (
      (action IN ('create_thread', 'reply') AND logical_digest IS NOT NULL)
      OR (action NOT IN ('create_thread', 'reply') AND logical_digest IS NULL)
    ),
  -- A dispatch is only ever recorded with a dispatch time, and a settled
  -- state is only ever recorded with a settlement time.
  CONSTRAINT youtube_comment_operations_dispatch_check
    CHECK (state <> 'dispatched' OR dispatched_at IS NOT NULL),
  CONSTRAINT youtube_comment_operations_settled_check
    CHECK (
      state NOT IN ('confirmed', 'refused', 'indeterminate')
      OR settled_at IS NOT NULL
    )
);

COMMENT ON TABLE public.youtube_comment_operations IS
  'The durable receipt of one deliberate YouTube comment write. Private: '
  'RLS on, no policies, no client grants. Reached only through the '
  'service-only functions. Never stores comment text, tokens, provider '
  'bodies, cursors, handles or display names.';

ALTER TABLE public.youtube_comment_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_comment_operations FROM PUBLIC, anon, authenticated, service_role;

-- The unresolved fence. A partial unique index over the OWNER and the
-- CHANNEL, not over the account row, so it survives a hard delete and a
-- re-created connection of the same channel.
CREATE UNIQUE INDEX IF NOT EXISTS youtube_comment_operations_unresolved_fence
  ON public.youtube_comment_operations (owner_id, channel_id, digest_key_version, logical_digest)
  WHERE action IN ('create_thread', 'reply')
    AND state IN ('claimed', 'dispatched', 'indeterminate');

-- The recent-confirmation fence lookup.
CREATE INDEX IF NOT EXISTS youtube_comment_operations_logical_lookup
  ON public.youtube_comment_operations (owner_id, channel_id, logical_digest, state, settled_at DESC);

-- The status lookup.
CREATE INDEX IF NOT EXISTS youtube_comment_operations_status_lookup
  ON public.youtube_comment_operations (owner_id, operation_id);

-- The stale-claim sweep and the prune.
CREATE INDEX IF NOT EXISTS youtube_comment_operations_state_lookup
  ON public.youtube_comment_operations (owner_id, state, claimed_at);

-- The account rows a receipt points at.
CREATE INDEX IF NOT EXISTS youtube_comment_operations_account_lookup
  ON public.youtube_comment_operations (owner_id, social_account_id);

-- ===========================================================================
-- 5. The rollout authority.
-- ===========================================================================

-- The policy key is private. The existing read allow-list already keeps an
-- ordinary client away from it (it is not in the list and it is not
-- `feature_`-prefixed), but that is a LIST, not a boundary: one more entry
-- in that list would publish the pilot. A RESTRICTIVE policy makes it
-- structural. The admin escape is deliberate - an admin IS the trusted
-- configuration path - and the service role bypasses RLS entirely.
DROP POLICY IF EXISTS app_settings_youtube_stage4_rollout_private ON public.app_settings;

CREATE POLICY app_settings_youtube_stage4_rollout_private
  ON public.app_settings
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (
    key <> 'youtube_comments_stage4_rollout'
    OR public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    key <> 'youtube_comments_stage4_rollout'
    OR public.has_role(auth.uid(), 'admin')
  );

-- The effective state of the rollout, read ONCE per call.
--
--   status = ok               the configuration is readable and valid
--   status = tile_disabled    the tile flag `feature_youtube_comments` is
--                              missing or false
--   status = rollout_missing  the private rollout key is absent
--   status = rollout_invalid  the rollout key is malformed
--
-- A failed READ is an ERROR, never a status: `settings_unavailable` is
-- raised so the caller can tell "off" from "unreadable".
CREATE OR REPLACE FUNCTION public.youtube_comments_stage4_rollout_state()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tile       jsonb := NULL;
  v_tile_found boolean := false;
  v_tile_failed boolean := false;
  v_policy     jsonb := NULL;
  v_policy_found boolean := false;
  v_policy_failed boolean := false;
  v_status     text := 'ok';
  v_accounts   jsonb := '{}'::jsonb;
  v_account_id text;
  v_entry      jsonb;
  v_caps       jsonb;
  v_cap_key    text;
  v_cap_value  jsonb;
  v_keys       text[];
BEGIN
  -- --- the tile flag -------------------------------------------------------
  BEGIN
    SELECT s.value INTO v_tile
      FROM public.app_settings AS s
     WHERE s.key = 'feature_youtube_comments';
    v_tile_found := FOUND;
  EXCEPTION WHEN others THEN
    v_tile_failed := true;
  END;

  IF v_tile_failed THEN
    RAISE EXCEPTION
      'youtube_comments_stage4_rollout_state: the tile flag cannot be read'
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_tile_found OR jsonb_typeof(v_tile) <> 'boolean' OR v_tile <> 'true'::jsonb THEN
    RETURN jsonb_build_object(
      'status', 'tile_disabled',
      'reason', 'tile_disabled',
      'tile_enabled', false,
      'accounts', '{}'::jsonb
    );
  END IF;

  -- --- the private rollout key --------------------------------------------
  BEGIN
    SELECT s.value INTO v_policy
      FROM public.app_settings AS s
     WHERE s.key = 'youtube_comments_stage4_rollout';
    v_policy_found := FOUND;
  EXCEPTION WHEN others THEN
    v_policy_failed := true;
  END;

  IF v_policy_failed THEN
    RAISE EXCEPTION
      'youtube_comments_stage4_rollout_state: the rollout policy cannot be read'
      USING ERRCODE = '55000';
  END IF;

  IF NOT v_policy_found THEN
    -- A MISSING policy means off. Everybody is off.
    RETURN jsonb_build_object(
      'status', 'rollout_missing',
      'reason', 'rollout_missing',
      'tile_enabled', true,
      'accounts', '{}'::jsonb
    );
  END IF;

  -- --- the shape -----------------------------------------------------------
  IF jsonb_typeof(v_policy) <> 'object' THEN
    RETURN jsonb_build_object(
      'status', 'rollout_invalid', 'reason', 'rollout_invalid',
      'tile_enabled', true, 'accounts', '{}'::jsonb);
  END IF;

  IF jsonb_typeof(v_policy -> 'version') <> 'number'
     OR (v_policy ->> 'version')::numeric <> 1 THEN
    RETURN jsonb_build_object(
      'status', 'rollout_invalid', 'reason', 'rollout_invalid',
      'tile_enabled', true, 'accounts', '{}'::jsonb);
  END IF;

  IF jsonb_typeof(v_policy -> 'accounts') <> 'object' THEN
    RETURN jsonb_build_object(
      'status', 'rollout_invalid', 'reason', 'rollout_invalid',
      'tile_enabled', true, 'accounts', '{}'::jsonb);
  END IF;

  -- Every entry is validated. A malformed entry invalidates the WHOLE
  -- document: a policy that is partly readable is not a policy.
  FOR v_account_id, v_entry IN
    SELECT e.key, e.value
      FROM jsonb_each(v_policy -> 'accounts') AS e(key, value)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object' THEN
      RETURN jsonb_build_object(
        'status', 'rollout_invalid', 'reason', 'rollout_invalid',
        'tile_enabled', true, 'accounts', '{}'::jsonb);
    END IF;

    SELECT array_agg(k ORDER BY k) INTO v_keys
      FROM jsonb_object_keys(v_entry) AS k;

    IF v_keys IS DISTINCT FROM ARRAY['ban', 'held', 'read', 'write'] THEN
      RETURN jsonb_build_object(
        'status', 'rollout_invalid', 'reason', 'rollout_invalid',
        'tile_enabled', true, 'accounts', '{}'::jsonb);
    END IF;

    v_caps := '{}'::jsonb;
    FOREACH v_cap_key IN ARRAY ARRAY['read', 'held', 'write', 'ban'] LOOP
      v_cap_value := v_entry -> v_cap_key;
      IF v_cap_value IS NULL THEN
        -- A MISSING capability is false, not invalid.
        v_caps := v_caps || jsonb_build_object(v_cap_key, false);
      ELSIF jsonb_typeof(v_cap_value) = 'boolean' THEN
        v_caps := v_caps || jsonb_build_object(v_cap_key, v_cap_value);
      ELSE
        RETURN jsonb_build_object(
          'status', 'rollout_invalid', 'reason', 'rollout_invalid',
          'tile_enabled', true, 'accounts', '{}'::jsonb);
      END IF;
    END LOOP;

    v_accounts := v_accounts || jsonb_build_object(v_account_id, v_caps);
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'reason', NULL,
    'tile_enabled', true,
    'accounts', v_accounts
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comments_stage4_rollout_state() IS
  'Reads the tile flag and the private rollout key exactly once and returns '
  'the effective admission state: the status, the reason and the per-account '
  'capabilities. A missing tile flag refuses with tile_disabled, a missing '
  'rollout key refuses with rollout_missing, a malformed document refuses '
  'with rollout_invalid, and an unreadable configuration RAISES so an error '
  'is never mistaken for "off".';

-- The per-account, per-capability decision. Every capability carries a
-- reason, so the interface renders controls from this and nothing else.
CREATE OR REPLACE FUNCTION public.youtube_comments_stage4_capability_status(
  p_account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state   jsonb;
  v_status  text;
  v_account public.social_accounts%ROWTYPE;
  v_caps    jsonb;
  v_read    boolean := false;
  v_held    boolean := false;
  v_write   boolean := false;
  v_ban     boolean := false;
  v_reason  text;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'read', jsonb_build_object('allowed', false, 'reason', 'invalid_request'),
      'held', jsonb_build_object('allowed', false, 'reason', 'invalid_request'),
      'write', jsonb_build_object('allowed', false, 'reason', 'invalid_request'),
      'ban', jsonb_build_object('allowed', false, 'reason', 'invalid_request')
    );
  END IF;

  v_state := public.youtube_comments_stage4_rollout_state();
  v_status := v_state ->> 'status';

  IF v_status <> 'ok' THEN
    v_reason := v_state ->> 'reason';
    RETURN jsonb_build_object(
      'read', jsonb_build_object('allowed', false, 'reason', v_reason),
      'held', jsonb_build_object('allowed', false, 'reason', v_reason),
      'write', jsonb_build_object('allowed', false, 'reason', v_reason),
      'ban', jsonb_build_object('allowed', false, 'reason', v_reason)
    );
  END IF;

  -- The account itself. A Composio connection is not a native one, and a
  -- native one that is inactive or needs a re-consent is not usable.
  SELECT * INTO v_account
    FROM public.social_accounts
   WHERE id = p_account_id;

  IF NOT FOUND THEN
    v_reason := 'account_not_found';
  ELSIF v_account.platform <> 'youtube' THEN
    v_reason := 'provider_unsupported';
  ELSIF v_account.auth_provider IS DISTINCT FROM 'native' THEN
    v_reason := 'provider_unsupported';
  ELSIF NOT COALESCE(v_account.is_active, false) THEN
    v_reason := 'account_not_connected';
  ELSIF COALESCE(v_account.needs_reauth, false) THEN
    v_reason := 'account_needs_reauth';
  ELSE
    v_reason := NULL;
  END IF;

  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object(
      'read', jsonb_build_object('allowed', false, 'reason', v_reason),
      'held', jsonb_build_object('allowed', false, 'reason', v_reason),
      'write', jsonb_build_object('allowed', false, 'reason', v_reason),
      'ban', jsonb_build_object('allowed', false, 'reason', v_reason)
    );
  END IF;

  v_caps := v_state -> 'accounts' -> p_account_id::text;

  IF v_caps IS NULL THEN
    v_reason := 'account_not_admitted';
  ELSE
    v_read  := COALESCE((v_caps ->> 'read')::boolean, false);
    v_held  := COALESCE((v_caps ->> 'held')::boolean, false);
    v_write := COALESCE((v_caps ->> 'write')::boolean, false);
    v_ban   := COALESCE((v_caps ->> 'ban')::boolean, false);
  END IF;

  -- The prerequisites are structural. A capability whose prerequisite is
  -- false is false, whatever the document says.
  IF v_held AND NOT v_read THEN v_held := false; END IF;
  IF v_write AND NOT v_read THEN v_write := false; END IF;
  IF v_ban AND NOT v_write THEN v_ban := false; END IF;

  RETURN jsonb_build_object(
    'read', jsonb_build_object(
      'allowed', v_read,
      'reason', CASE WHEN v_read THEN NULL ELSE
        CASE WHEN v_caps IS NULL THEN 'account_not_admitted' ELSE 'capability_off' END
      END),
    'held', jsonb_build_object(
      'allowed', v_held,
      'reason', CASE WHEN v_held THEN NULL ELSE
        CASE
          WHEN v_caps IS NULL THEN 'account_not_admitted'
          WHEN NOT v_read THEN 'prerequisite_missing'
          ELSE 'capability_off'
        END
      END),
    'write', jsonb_build_object(
      'allowed', v_write,
      'reason', CASE WHEN v_write THEN NULL ELSE
        CASE
          WHEN v_caps IS NULL THEN 'account_not_admitted'
          WHEN NOT v_read THEN 'prerequisite_missing'
          ELSE 'capability_off'
        END
      END),
    'ban', jsonb_build_object(
      'allowed', v_ban,
      'reason', CASE WHEN v_ban THEN NULL ELSE
        CASE
          WHEN v_caps IS NULL THEN 'account_not_admitted'
          WHEN NOT v_write THEN 'prerequisite_missing'
          ELSE 'capability_off'
        END
      END)
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comments_stage4_capability_status(uuid) IS
  'The per-account, per-capability admission decision for Stage 4, with a '
  'reason for each. The account itself is checked structurally: a '
  'Composio, inactive or re-consent row is provider_unsupported, '
  'account_not_connected or account_needs_reauth. The capability '
  'prerequisites are structural too: held needs read, write needs read and '
  'ban needs write.';

-- The single yes/no evaluator. Everything else asks this.
CREATE OR REPLACE FUNCTION public.youtube_comments_stage4_admits(
  p_account_id   uuid,
  p_capability   text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_status jsonb;
BEGIN
  IF p_account_id IS NULL OR p_capability IS NULL THEN
    RETURN false;
  END IF;

  IF p_capability NOT IN ('read', 'held', 'write', 'ban') THEN
    RETURN false;
  END IF;

  v_status := public.youtube_comments_stage4_capability_status(p_account_id);
  RETURN COALESCE((v_status -> p_capability ->> 'allowed')::boolean, false);
END;
$function$;

COMMENT ON FUNCTION public.youtube_comments_stage4_admits(uuid, text) IS
  'The single rollout evaluator: may this account use this Stage 4 '
  'capability? Fails closed. An unknown capability, a missing account, a '
  'missing key, a malformed policy, a false capability and a missing '
  'prerequisite all answer false. Admins get no bypass.';

-- ===========================================================================
-- 6. The digest keys reader.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.youtube_comment_digest_keys()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_active integer;
  v_keys   jsonb;
BEGIN
  SELECT k.version INTO v_active
    FROM public.youtube_comment_digest_keys AS k
   WHERE k.retired_at IS NULL
   ORDER BY k.version DESC
   LIMIT 1;

  IF v_active IS NULL THEN
    RETURN jsonb_build_object('active_version', NULL, 'keys', '[]'::jsonb);
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'version', k.version,
           'key', encode(k.key, 'base64')
         ) ORDER BY k.version)
    INTO v_keys
    FROM public.youtube_comment_digest_keys AS k;

  RETURN jsonb_build_object('active_version', v_active, 'keys', v_keys);
END;
$function$;

COMMENT ON FUNCTION public.youtube_comment_digest_keys() IS
  'Service-only. Returns the active and retained digest keys so the Edge '
  'handler can compute the intent and logical HMACs. A key is never logged '
  'and never returned to a browser.';

-- ===========================================================================
-- 7. The claim.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.youtube_comment_op_claim(
  p_owner_id            uuid,
  p_account_id          uuid,
  p_expected_channel    text,
  p_expected_generation bigint,
  p_operation_id        uuid,
  p_action              text,
  p_targets             jsonb,
  p_intent_digest       text,
  p_logical_digests     jsonb,
  p_capability          text,
  p_request_id          text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account   public.social_accounts%ROWTYPE;
  v_existing  public.youtube_comment_operations%ROWTYPE;
  v_confirmed public.youtube_comment_operations%ROWTYPE;
  v_new       public.youtube_comment_operations%ROWTYPE;
  v_version   text;
  v_digest    text;
  v_active    integer;
  v_logical   text;
  v_lock_key  bigint;
  v_video     text;
  v_thread    text;
  v_parent    text;
  v_comment   text;
  v_author    text;
  v_status    text;
  v_ban       boolean := false;
BEGIN
  -- --- 1. input -----------------------------------------------------------
  IF p_owner_id IS NULL OR p_account_id IS NULL OR p_operation_id IS NULL
     OR p_expected_channel IS NULL OR p_expected_generation IS NULL
     OR p_action IS NULL OR p_intent_digest IS NULL
     OR p_targets IS NULL OR jsonb_typeof(p_targets) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF p_action NOT IN ('create_thread', 'reply', 'edit', 'moderate') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF btrim(p_intent_digest) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  v_video   := p_targets ->> 'video_id';
  v_thread  := p_targets ->> 'thread_id';
  v_parent  := p_targets ->> 'parent_comment_id';
  v_comment := p_targets ->> 'comment_id';
  v_author  := p_targets ->> 'author_channel_id';
  v_status  := p_targets ->> 'moderation_status';
  v_ban     := COALESCE((p_targets ->> 'ban_author')::boolean, false);

  IF p_action IN ('create_thread', 'reply', 'edit', 'moderate')
     AND (v_video IS NULL OR btrim(v_video) = '') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF p_action IN ('edit', 'moderate')
     AND (v_comment IS NULL OR btrim(v_comment) = '') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- A reply acts on its canonical parent, never on a stored comment id: the
  -- receipt CHECK constraint requires comment_id to stay NULL for a reply,
  -- because the comment being replied to is not the comment being created.
  IF p_action = 'reply'
      AND (v_parent IS NULL OR btrim(v_parent) = '') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF p_action = 'moderate' AND v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF v_ban AND (p_action <> 'moderate' OR v_status <> 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- --- 2. the account, locked and owned -----------------------------------
  -- The lock is taken on the OWNER-SCOPED row. A foreign or missing account
  -- is therefore never locked and is answered with the identical refusal.
  SELECT * INTO v_account
    FROM public.social_accounts
   WHERE id = p_account_id
     AND user_id = p_owner_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_account.platform <> 'youtube'
     OR NOT COALESCE(v_account.is_active, false)
     OR v_account.auth_provider IS DISTINCT FROM 'native'
     OR COALESCE(v_account.needs_reauth, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The expected values are the ones every earlier verification step used.
  -- A rebinding between the verification and this claim fails here.
  IF v_account.platform_user_id IS DISTINCT FROM p_expected_channel THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_account.binding_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- --- 3. the rollout -----------------------------------------------------
  -- The required capability is DERIVED from the intent (ban_author), never
  -- taken from the caller: a Reject-and-ban needs 'ban', everything else
  -- 'write'. p_capability is kept for signature compatibility only.
  IF NOT public.youtube_comments_stage4_admits(
       p_account_id, CASE WHEN v_ban THEN 'ban' ELSE 'write' END) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'capability_denied');
  END IF;

  -- --- 4. the stale-claim close and the prune ------------------------------
  -- A claim that was never dispatched and is older than 120 s is closed.
  -- Only a NEVER-DISPATCHED row is ever closed, and only a never-dispatched
  -- refused row is ever pruned.
  UPDATE public.youtube_comment_operations
     SET state = 'refused',
         reason = 'abandoned_before_dispatch',
         settled_at = clock_timestamp()
   WHERE owner_id = p_owner_id
     AND state = 'claimed'
     AND dispatched_at IS NULL
     AND claimed_at < clock_timestamp() - interval '120 seconds';

  DELETE FROM public.youtube_comment_operations
   WHERE id IN (
     SELECT o.id
       FROM public.youtube_comment_operations AS o
      WHERE o.owner_id = p_owner_id
        AND o.state = 'refused'
        AND o.dispatched_at IS NULL
        AND o.settled_at IS NOT NULL
        AND o.settled_at < clock_timestamp() - interval '30 days'
      ORDER BY o.settled_at ASC
      LIMIT 20
   );

  -- --- 5. the per-key fence ------------------------------------------------
  SELECT * INTO v_existing
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.intent_digest IS DISTINCT FROM p_intent_digest THEN
      -- One key, a different intent.
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'conflict', 'state', v_existing.state);
    END IF;

    IF v_existing.binding_generation IS DISTINCT FROM p_expected_generation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    -- The same key, the same intent and the same generation: the existing
    -- state, and NO token. The caller cannot dispatch twice.
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'already_recorded',
      'state', v_existing.state,
      'result_comment_id', v_existing.result_comment_id,
      'result_thread_id', v_existing.result_thread_id
    );
  END IF;

  -- --- 6. the logical fence ------------------------------------------------
  IF p_action IN ('create_thread', 'reply') THEN
    SELECT k.version INTO v_active
      FROM public.youtube_comment_digest_keys AS k
     WHERE k.retired_at IS NULL
     ORDER BY k.version DESC
     LIMIT 1;

    IF v_active IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
    END IF;

    v_logical := p_logical_digests ->> v_active::text;

    IF v_logical IS NULL OR btrim(v_logical) = '' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
    END IF;

    -- The advisory lock serialises two concurrent claims of the SAME logical
    -- operation. It is transaction-scoped, so it is released when the claim
    -- commits or rolls back. It is NOT the only serialisation: every claim
    -- first holds FOR UPDATE on its own owner-scoped account row, and
    -- social_accounts is unique on (user_id, platform, platform_user_id), so
    -- two claims for one owner and channel always contend on the SAME account
    -- row, whichever digest key version each one picked during a rotation.
    v_lock_key := hashtextextended(
      p_owner_id::text || ':' || v_account.platform_user_id || ':' || v_logical, 0);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- The fence compares version to version, so evidence written under an
    -- older key still blocks.
    FOR v_version, v_digest IN
      SELECT e.key, e.value FROM jsonb_each_text(p_logical_digests) AS e(key, value)
    LOOP
      SELECT * INTO v_confirmed
        FROM public.youtube_comment_operations
       WHERE owner_id = p_owner_id
         AND channel_id = v_account.platform_user_id
         AND digest_key_version = v_version::integer
         AND logical_digest = v_digest
         AND action IN ('create_thread', 'reply')
         AND state IN ('claimed', 'dispatched', 'indeterminate')
       LIMIT 1;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'ok', false, 'reason', 'possible_duplicate', 'state', v_confirmed.state);
      END IF;

      SELECT * INTO v_confirmed
        FROM public.youtube_comment_operations
       WHERE owner_id = p_owner_id
         AND channel_id = v_account.platform_user_id
         AND digest_key_version = v_version::integer
         AND logical_digest = v_digest
         AND action IN ('create_thread', 'reply')
         AND state = 'confirmed'
         AND settled_at IS NOT NULL
         AND settled_at > clock_timestamp() - interval '10 minutes'
       LIMIT 1;

      IF FOUND THEN
        -- Under the SAME live binding the refusal carries the confirmed
        -- comment id, so the interface can show the comment. Across a
        -- binding change it is the bare reason.
        IF v_confirmed.account_ref = p_account_id
           AND v_confirmed.binding_generation = p_expected_generation THEN
          RETURN jsonb_build_object(
            'ok', false,
            'reason', 'recently_posted',
            'result_comment_id', v_confirmed.result_comment_id,
            'result_thread_id', v_confirmed.result_thread_id
          );
        END IF;

        RETURN jsonb_build_object('ok', false, 'reason', 'recently_posted');
      END IF;
    END LOOP;
  END IF;

  -- --- 7. the receipt ------------------------------------------------------
  INSERT INTO public.youtube_comment_operations (
    owner_id, operation_id, social_account_id, account_ref, channel_id,
    binding_generation, auth_provider, action, video_id, thread_id,
    parent_comment_id, comment_id, author_channel_id, moderation_status,
    ban_author, intent_digest, logical_digest, digest_key_version, state,
    attempt_token, request_id, claimed_at
  )
  VALUES (
    p_owner_id, p_operation_id, p_account_id, p_account_id,
    v_account.platform_user_id, v_account.binding_generation, 'native',
    p_action, v_video, v_thread, v_parent, v_comment, v_author, v_status,
    v_ban, p_intent_digest,
    CASE WHEN p_action IN ('create_thread', 'reply') THEN v_logical ELSE NULL END,
    CASE WHEN p_action IN ('create_thread', 'reply') THEN v_active ELSE 0 END,
    'claimed', gen_random_uuid(), left(COALESCE(p_request_id, ''), 200),
    clock_timestamp()
  )
  RETURNING * INTO v_new;

  RETURN jsonb_build_object(
    'ok', true,
    'state', v_new.state,
    'attempt_token', v_new.attempt_token,
    'operation_id', v_new.operation_id,
    'account_ref', v_new.account_ref,
    'channel_id', v_new.channel_id,
    'binding_generation', v_new.binding_generation,
    'digest_key_version', v_new.digest_key_version
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comment_op_claim(uuid, uuid, text, bigint, uuid, text, jsonb, text, jsonb, text, text) IS
  'Records the durable intent of one deliberate write, in ONE transaction, '
  'under a FOR UPDATE lock on the owner-scoped account row. It requires the '
  'account to be owned, active, stored-native, on the expected channel and on '
  'the expected binding generation, and it re-evaluates the rollout inside '
  'the lock. It then applies the per-key fence and the logical fence. A miss '
  'on the account is not_found, identical for a foreign, an absent and a '
  're-bound row. The attempt token is returned to the claim winner alone.';

-- ===========================================================================
-- 8. The mark. The authorisation boundary.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.youtube_comment_op_mark_dispatched(
  p_owner_id            uuid,
  p_operation_id        uuid,
  p_attempt_token       uuid,
  p_expected_channel    text,
  p_expected_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account  public.social_accounts%ROWTYPE;
  v_op       public.youtube_comment_operations%ROWTYPE;
  v_reason   text;
  v_account_found boolean := false;
BEGIN
  IF p_owner_id IS NULL OR p_operation_id IS NULL OR p_attempt_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- The account row first, then the receipt: the same order the claim uses.
  -- A deleted account (the receipt's social_account_id went NULL, or the row
  -- belongs to another owner) selects nothing, and v_account_found records
  -- that BEFORE the receipt select overwrites FOUND.
  SELECT * INTO v_account
    FROM public.social_accounts
   WHERE id = (SELECT o.social_account_id FROM public.youtube_comment_operations AS o
                WHERE o.owner_id = p_owner_id AND o.operation_id = p_operation_id)
     AND user_id = p_owner_id
   FOR UPDATE;
  v_account_found := FOUND;

  SELECT * INTO v_op
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The token is checked BEFORE anything can change the row. A spoofed token
  -- must never be able to close a legitimate operation.
  IF v_op.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token');
  END IF;

  IF v_op.state = 'dispatched' THEN
    -- The mark is idempotent for the holder of the token.
    RETURN jsonb_build_object('ok', true, 'state', 'dispatched', 'already', true);
  END IF;

  IF v_op.state <> 'claimed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state', 'state', v_op.state);
  END IF;

  -- The same predicate as the claim. A disconnect, a reconnect, a gate
  -- change or a capability change between the claim and the mark stops the
  -- operation here, BEFORE anything is sent. A hard-deleted account is the
  -- ultimate disconnect: the v_account record is all-NULL then, every
  -- comparison below reads as NULL, so the explicit found flag must refuse.
  v_reason := NULL;

  IF NOT v_account_found THEN
    v_reason := 'binding_changed';
  ELSIF v_account.platform <> 'youtube'
     OR NOT COALESCE(v_account.is_active, false)
     OR v_account.auth_provider IS DISTINCT FROM 'native'
     OR COALESCE(v_account.needs_reauth, false) THEN
    v_reason := 'binding_changed';
  ELSIF v_account.platform_user_id IS DISTINCT FROM p_expected_channel THEN
    v_reason := 'binding_changed';
  ELSIF v_account.binding_generation IS DISTINCT FROM p_expected_generation THEN
    v_reason := 'binding_changed';
  -- The values stored on the receipt are authoritative too: the live row must
  -- still be the very binding the claim recorded.
  ELSIF v_account.platform_user_id IS DISTINCT FROM v_op.channel_id
     OR v_account.binding_generation IS DISTINCT FROM v_op.binding_generation
     OR v_account.id IS DISTINCT FROM v_op.account_ref THEN
    v_reason := 'binding_changed';
  ELSIF NOT public.youtube_comments_stage4_admits(
         v_account.id,
         CASE WHEN v_op.ban_author THEN 'ban' ELSE 'write' END) THEN
    v_reason := 'capability_denied';
  END IF;

  IF v_reason IS NOT NULL THEN
    -- The operation is closed as never sent.
    UPDATE public.youtube_comment_operations
       SET state = 'refused',
           reason = v_reason,
           settled_at = clock_timestamp()
     WHERE id = v_op.id
       AND state = 'claimed'
       AND attempt_token = p_attempt_token;

    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'state', 'refused');
  END IF;

  -- The compare-and-set. Its committed result is the FINAL AUTHORISATION to
  -- send: from this instant the operation is never sent again by anyone
  -- under any key.
  UPDATE public.youtube_comment_operations
     SET state = 'dispatched',
         dispatched_at = clock_timestamp()
   WHERE id = v_op.id
     AND state = 'claimed'
     AND attempt_token = p_attempt_token
   RETURNING * INTO v_op;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'state', v_op.state,
    'dispatched_at', v_op.dispatched_at
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comment_op_mark_dispatched(uuid, uuid, uuid, text, bigint) IS
  'The authorisation boundary. It locks the account and the receipt in the '
  'claim order, verifies the attempt token FIRST so a spoofed token can '
  'never change the row, then re-checks the owner, the platform, the '
  'activity, the stored provider, the expected channel, the expected binding '
  'generation and the rollout capability. A failed precondition closes the '
  'receipt as refused without anything having been sent. A committed '
  'claimed -> dispatched transition IS the final authorisation to send.';

-- ===========================================================================
-- 9. The settle.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.youtube_comment_op_settle(
  p_owner_id          uuid,
  p_operation_id      uuid,
  p_attempt_token     uuid,
  p_outcome           text,
  p_reason            text,
  p_provider_class    text,
  p_result_thread_id  text,
  p_result_comment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_op       public.youtube_comment_operations%ROWTYPE;
  v_new_state text;
BEGIN
  IF p_owner_id IS NULL OR p_operation_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF p_outcome NOT IN ('confirmed', 'refused', 'indeterminate') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  IF p_provider_class IS NOT NULL
     AND p_provider_class NOT IN ('http_4xx', 'http_5xx', 'network', 'timeout', 'none') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO v_op
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The token holder alone may settle. A late settlement is exactly the
  -- original attempt presenting its token.
  IF v_op.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token');
  END IF;

  -- A terminal state is final. A repeated settlement is idempotent.
  IF v_op.state IN ('confirmed', 'refused') THEN
    RETURN jsonb_build_object('ok', true, 'state', v_op.state, 'already', true);
  END IF;

  IF v_op.state = 'claimed' THEN
    -- Nothing was sent, so the only honest settlement is a refusal.
    IF p_outcome <> 'refused' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state', 'state', v_op.state);
    END IF;
    v_new_state := 'refused';
  ELSIF v_op.state = 'dispatched' OR v_op.state = 'indeterminate' THEN
    IF p_outcome = 'refused' AND p_provider_class IS DISTINCT FROM 'http_4xx' THEN
      -- A refusal after a dispatch is accepted only with a 4xx provider
      -- class. A 5xx, a network error, a timeout and a missing class are
      -- all indeterminate: only a DEFINITIVE refusal about THIS request may
      -- be recorded as refused.
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_outcome', 'state', v_op.state);
    END IF;
    v_new_state := p_outcome;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state', 'state', v_op.state);
  END IF;

  UPDATE public.youtube_comment_operations
     SET state = v_new_state,
         reason = left(COALESCE(p_reason, ''), 200),
         provider_class = p_provider_class,
         result_thread_id = left(COALESCE(p_result_thread_id, ''), 200),
         result_comment_id = left(COALESCE(p_result_comment_id, ''), 200),
         settled_at = clock_timestamp()
   WHERE id = v_op.id
     AND attempt_token = p_attempt_token
     AND state IN ('claimed', 'dispatched', 'indeterminate');

  RETURN jsonb_build_object(
    'ok', true,
    'state', v_new_state,
    'result_comment_id', left(COALESCE(p_result_comment_id, ''), 200),
    'result_thread_id', left(COALESCE(p_result_thread_id, ''), 200)
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comment_op_settle(uuid, uuid, uuid, text, text, text, text, text) IS
  'Records the outcome of the attempt, and only for the holder of the '
  'attempt token. A refusal after a dispatch is accepted only with a 4xx '
  'provider class; a 5xx, a network error, a timeout and a missing class are '
  'indeterminate, because only a definitive refusal about THIS request may '
  'be recorded as refused. It does NOT require a live binding: the truth '
  'about a send is recorded even if the account was disconnected in '
  'flight. An indeterminate receipt may still be settled later by the token '
  'holder.';

-- ===========================================================================
-- 10. The status.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.youtube_comment_op_status(
  p_owner_id     uuid,
  p_account_id   uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_op      public.youtube_comment_operations%ROWTYPE;
  v_account public.social_accounts%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_account_id IS NULL OR p_operation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO v_op
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_account
    FROM public.social_accounts
   WHERE id = p_account_id
     AND user_id = p_owner_id;

  -- The receipt is readable only under the CURRENT binding. After a
  -- disconnect, a reconnect or a re-creation it answers not_found, for the
  -- same owner too.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Same generation NUMBER on another account is not the same binding: the
  -- receipt is bound to its own account row (social_account_id goes NULL when
  -- that row is deleted), channel, generation and provider.
  IF v_account.platform <> 'youtube'
     OR NOT COALESCE(v_account.is_active, false)
     OR v_op.social_account_id IS NULL
     OR v_op.social_account_id IS DISTINCT FROM v_account.id
     OR v_op.account_ref IS DISTINCT FROM v_account.id
     OR v_account.platform_user_id IS DISTINCT FROM v_op.channel_id
     OR v_account.auth_provider IS DISTINCT FROM v_op.auth_provider
     OR v_account.binding_generation IS DISTINCT FROM v_op.binding_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The 90 second conversion. A dispatched receipt that was never settled
  -- reads as indeterminate.
  IF v_op.state = 'dispatched'
     AND v_op.dispatched_at IS NOT NULL
     AND v_op.dispatched_at < clock_timestamp() - interval '90 seconds' THEN
    UPDATE public.youtube_comment_operations
       SET state = 'indeterminate',
           reason = COALESCE(reason, 'no_settlement'),
           settled_at = clock_timestamp()
     WHERE id = v_op.id
       AND state = 'dispatched'
       AND attempt_token = v_op.attempt_token;

    v_op.state := 'indeterminate';
    v_op.settled_at := clock_timestamp();
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'operation_id', v_op.operation_id,
    'action', v_op.action,
    'state', v_op.state,
    'reason', v_op.reason,
    'provider_class', v_op.provider_class,
    'moderation_status', v_op.moderation_status,
    'ban_requested', v_op.ban_author,
    'result_thread_id', v_op.result_thread_id,
    'result_comment_id', v_op.result_comment_id,
    'claimed_at', v_op.claimed_at,
    'dispatched_at', v_op.dispatched_at,
    'settled_at', v_op.settled_at,
    'binding_generation', v_op.binding_generation,
    'channel_id', v_op.channel_id
  );
END;
$function$;

COMMENT ON FUNCTION public.youtube_comment_op_status(uuid, uuid, uuid) IS
  'Reads the local receipt of one operation. It is NOT behind the rollout '
  'policy: with every capability off, or the key removed, an owner can still '
  'read the result of an operation under the CURRENT binding. It returns '
  'not_found when the live generation no longer matches the receipt, which '
  'is what a disconnect or a reconnect produces. It reads no provider.';

-- ===========================================================================
-- 11. The grants.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.youtube_comments_stage4_rollout_state()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comments_stage4_rollout_state()
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comments_stage4_capability_status(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comments_stage4_capability_status(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comments_stage4_admits(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comments_stage4_admits(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comment_digest_keys()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comment_digest_keys()
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comment_op_claim(uuid, uuid, text, bigint, uuid, text, jsonb, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comment_op_claim(uuid, uuid, text, bigint, uuid, text, jsonb, text, jsonb, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comment_op_mark_dispatched(uuid, uuid, uuid, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comment_op_mark_dispatched(uuid, uuid, uuid, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comment_op_settle(uuid, uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comment_op_settle(uuid, uuid, uuid, text, text, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_comment_op_status(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_comment_op_status(uuid, uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_stage4_assign_binding_generation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_stage4_assign_binding_generation()
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_stage4_guard_digest_keys()
  FROM PUBLIC, anon, authenticated;

-- The new tables carry no client privilege at all. The service role reaches
-- them only through the functions above.
REVOKE ALL ON public.youtube_comment_operations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.youtube_comment_digest_keys FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 12. The boundary self-check.
--
-- The migration fails rather than shipping an open door or a silently
-- dropped guard.
-- ===========================================================================

DO $assert_boundary$
DECLARE
  v_owner_name text;
  v_writers    text[];
BEGIN
  -- The narrow authority exists, cannot log in, and is not a member of any
  -- role; no role is a member of it either.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'youtube_stage4_refresh'
       AND NOT rolcanlogin
       AND NOT rolsuper
       AND NOT rolcreaterole
       AND NOT rolcreatedb
       AND NOT rolreplication
       AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'youtube_stage4_refresh must exist as a NOLOGIN, non-superuser role';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS m
     JOIN pg_roles AS member ON member.oid = m.member
     JOIN pg_roles AS granted ON granted.oid = m.roleid
     WHERE member.rolname = 'youtube_stage4_refresh'
        OR granted.rolname = 'youtube_stage4_refresh'
  ) THEN
    RAISE EXCEPTION 'youtube_stage4_refresh must be a member of no role and have no member role';
  END IF;

  -- Exactly the two trusted refresh functions are owned by the narrow
  -- authority. A third one would be a new trusted writer.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_writers
    FROM pg_proc AS p
    JOIN pg_roles AS r ON r.oid = p.proowner
   WHERE r.rolname = 'youtube_stage4_refresh';

  IF v_writers IS DISTINCT FROM
     ARRAY['store_youtube_refreshed_token', 'store_youtube_refreshed_token_with_lease'] THEN
    RAISE EXCEPTION
      'youtube_stage4_refresh must own EXACTLY the two trusted refresh functions, found: %',
      coalesce(v_writers::text, 'none');
  END IF;

  -- The narrow authority holds no CREATE on the public schema.
  IF has_schema_privilege('youtube_stage4_refresh', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'youtube_stage4_refresh must not hold CREATE on the public schema';
  END IF;

  -- NOTE on the credential writers. There are MANY legitimate writers of the
  -- credential columns on this stack (OAuth activation, disconnect, Composio
  -- activation, the trusted refresh). The binding-generation authority is
  -- NOT "which function writes the column" but "which role runs the write":
  -- only `youtube_stage4_refresh` preserves the generation, and that role is
  -- NOLOGIN, a member of nothing, and the owner of exactly the two trusted
  -- refresh functions. A catalog scan cannot be the authority and is not
  -- used as one. The proof lives in the trigger body and in the role's
  -- membership, both checked above and below.

  -- The narrow authority owns them, and nobody else may execute them.
  FOR v_owner_name IN
    SELECT DISTINCT r.rolname
      FROM pg_proc AS p
      JOIN pg_roles AS r ON r.oid = p.proowner
     WHERE p.oid IN (
       'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease(uuid,uuid,text,timestamptz,text,text[])'::regprocedure)
  LOOP
    IF v_owner_name <> 'youtube_stage4_refresh' THEN
      RAISE EXCEPTION 'the trusted refresh functions must be owned by youtube_stage4_refresh, found %', v_owner_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS x
     WHERE p.oid IN (
       'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease(uuid,uuid,text,timestamptz,text,text[])'::regprocedure)
       AND x.grantee IN (0,
         (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
         (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ) THEN
    RAISE EXCEPTION 'PUBLIC, anon and authenticated must hold no EXECUTE on the trusted refresh functions';
  END IF;

  -- The generation column and its trigger.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.social_accounts'::regclass
       AND attname = 'binding_generation'
       AND NOT attisdropped
       AND attnotnull
  ) THEN
    RAISE EXCEPTION 'social_accounts.binding_generation must exist and be NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.social_accounts'::regclass
       AND tgname = 'trg_social_accounts_youtube_binding_generation'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the binding generation trigger must exist on social_accounts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger AS t JOIN pg_proc AS p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_binding_generation'
       AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'the binding generation trigger function must be SECURITY INVOKER';
  END IF;

  -- Both new tables: RLS on, no policies, no client grants.
  IF NOT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_comment_operations'::regclass) THEN
    RAISE EXCEPTION 'youtube_comment_operations must have RLS enabled';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_comment_digest_keys'::regclass) THEN
    RAISE EXCEPTION 'youtube_comment_digest_keys must have RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('youtube_comment_operations', 'youtube_comment_digest_keys')
  ) THEN
    RAISE EXCEPTION 'the Stage 4 tables must carry no policy';
  END IF;

  IF has_table_privilege('anon', 'public.youtube_comment_operations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.youtube_comment_operations', 'SELECT')
     OR has_table_privilege('anon', 'public.youtube_comment_operations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.youtube_comment_operations', 'INSERT') THEN
    RAISE EXCEPTION 'browser roles must not reach youtube_comment_operations';
  END IF;

  IF has_table_privilege('anon', 'public.youtube_comment_digest_keys', 'SELECT')
     OR has_table_privilege('authenticated', 'public.youtube_comment_digest_keys', 'SELECT') THEN
    RAISE EXCEPTION 'browser roles must not read youtube_comment_digest_keys';
  END IF;

  -- Every Stage 4 function is SECURITY DEFINER with a pinned search_path.
  IF NOT (SELECT bool_and(COALESCE(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig), false))
            FROM pg_proc AS p
           WHERE p.oid IN (
             'public.youtube_comments_stage4_rollout_state()'::regprocedure,
             'public.youtube_comments_stage4_capability_status(uuid)'::regprocedure,
             'public.youtube_comments_stage4_admits(uuid,text)'::regprocedure,
             'public.youtube_comment_digest_keys()'::regprocedure,
             'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text)'::regprocedure,
             'public.youtube_comment_op_mark_dispatched(uuid,uuid,uuid,text,bigint)'::regprocedure,
             'public.youtube_comment_op_settle(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
             'public.youtube_comment_op_status(uuid,uuid,uuid)'::regprocedure)) THEN
    RAISE EXCEPTION 'every Stage 4 function must be SECURITY DEFINER with a pinned search_path';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS x
     WHERE p.oid IN (
       'public.youtube_comments_stage4_rollout_state()'::regprocedure,
       'public.youtube_comments_stage4_capability_status(uuid)'::regprocedure,
       'public.youtube_comments_stage4_admits(uuid,text)'::regprocedure,
       'public.youtube_comment_digest_keys()'::regprocedure,
       'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text)'::regprocedure,
       'public.youtube_comment_op_mark_dispatched(uuid,uuid,uuid,text,bigint)'::regprocedure,
       'public.youtube_comment_op_settle(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
       'public.youtube_comment_op_status(uuid,uuid,uuid)'::regprocedure)
       AND x.grantee IN (0,
         (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
         (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ) THEN
    RAISE EXCEPTION 'PUBLIC, anon and authenticated must hold no EXECUTE on the Stage 4 functions';
  END IF;

  -- Digest key version 1 exists, and the rollout key is NOT seeded.
  IF NOT EXISTS (
    SELECT 1 FROM public.youtube_comment_digest_keys WHERE version = 1
  ) THEN
    RAISE EXCEPTION 'digest key version 1 must exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_settings WHERE key = 'youtube_comments_stage4_rollout'
  ) THEN
    RAISE EXCEPTION 'the rollout key must not be seeded by this migration';
  END IF;
END
$assert_boundary$;

COMMIT;
