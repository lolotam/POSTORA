-- ===========================================================================
-- 20261124120000_youtube_stage4_key_integrity.sql
--
-- YouTube Stage 4, follow-up PR 2 - the second migration. It closes four holes
-- the first one (20261122130000) left open. Plan:
-- docs/plans/2026-11-24-youtube-stage4-pr2.md, tracking issue #470.
--
-- APPLY AS supabase_admin, the migration role of this stack (it owns the three
-- Stage 4 functions replaced below; CREATE OR REPLACE keeps owner and grants
-- only when the owner runs it). Rollback:
-- docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql,
-- procedure: docs/runbooks/youtube-stage4-pr2-migration.md.
--
--   K1  a foreign key on the receipts' intent key version (and a CHECK that
--       ties the digest key version to it), so a key version that a committed
--       receipt references cannot be deleted even by a session whose snapshot
--       predates that receipt;
--   K2  a watermark of the highest key version ever issued, so a deleted
--       version number is never issued again;
--   K3  the status read locks the account row first, so a rebind racing a
--       winning settlement is seen;
--   K4  the claim requires the digest map: a missing or non-object map is
--       invalid_request and the single-digest fallbacks are removed.
--
-- COMPATIBILITY. Every function keeps its signature and is replaced with
-- CREATE OR REPLACE, so this file can be applied to production BEFORE the edge
-- code that goes with this PR is merged: the edge code of 93acd4be sends the
-- digest map at all four claim sites, and no handler change depends on this
-- file. After a SQL-only rollback the new edge code runs on the old SQL.
--
-- IDEMPOTENT. One transaction; a second application changes nothing. A local
-- lock_timeout makes it fail fast instead of queueing behind a long
-- transaction on the receipt table.
--
-- NOT TOUCHED (asserted by the self-check at the end): the role
-- youtube_stage4_refresh and the three token store functions it owns, the
-- rollout functions and key (no row is inserted for it), mark_dispatched and
-- settle, and app_settings.
--
-- A consequence worth knowing: the key table's guard trigger now also fires on
-- INSERT, and a BEFORE INSERT trigger runs before conflict detection, so
-- INSERT ... ON CONFLICT DO NOTHING on an existing version raises instead of
-- skipping. The only such statement is the version 1 seed of 20261122130000,
-- which never runs again.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The key table is locked FIRST, before any statement touches the receipts or
-- the watermark, so a concurrent key insert waits at the table and holds no
-- lock this migration needs. The seed below then reads maxima no insert can
-- change.
LOCK TABLE public.youtube_comment_digest_keys IN SHARE ROW EXCLUSIVE MODE;

-- ===========================================================================
-- 0. The pre-check. The constraints below are added only to data that already
-- satisfies them; a violating row stops the migration with a clear message
-- instead of failing half-way. (Production has no receipts: the rollout key is
-- absent, so no claim can pass the rollout check.)
-- ===========================================================================
DO $precheck$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.youtube_comment_operations AS o
     WHERE NOT EXISTS (
       SELECT 1 FROM public.youtube_comment_digest_keys AS k WHERE k.version = o.intent_key_version)
  ) THEN
    RAISE EXCEPTION
      '20261124120000: a receipt references an intent key version that has no key row';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.youtube_comment_operations AS o
     WHERE NOT (
       (o.action IN ('create_thread', 'reply') AND o.digest_key_version = o.intent_key_version)
       OR (o.action IN ('edit', 'moderate') AND o.digest_key_version = 0))
  ) THEN
    RAISE EXCEPTION
      '20261124120000: a receipt breaks the key version rule (create_thread and reply: digest key version = intent key version; edit and moderate: 0)';
  END IF;
END
$precheck$;

-- ===========================================================================
-- K1. The foreign key and the version CHECK.
-- ===========================================================================

-- Tie the two version columns together, so the foreign key on the intent key
-- version covers the digest key version as well. digest_key_version cannot
-- carry a foreign key of its own: edit and moderate receipts store 0 there
-- (see the claim).
DO $k1$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.youtube_comment_operations'::regclass
       AND conname = 'youtube_comment_operations_key_versions_check'
  ) THEN
    ALTER TABLE public.youtube_comment_operations
      ADD CONSTRAINT youtube_comment_operations_key_versions_check
      CHECK (
        (action IN ('create_thread', 'reply') AND digest_key_version = intent_key_version)
        OR (action IN ('edit', 'moderate') AND digest_key_version = 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.youtube_comment_operations'::regclass
       AND conname = 'youtube_comment_operations_intent_key_version_fkey'
  ) THEN
    ALTER TABLE public.youtube_comment_operations
      ADD CONSTRAINT youtube_comment_operations_intent_key_version_fkey
      FOREIGN KEY (intent_key_version)
      REFERENCES public.youtube_comment_digest_keys (version)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END
$k1$;

-- The referencing side of the foreign key is indexed: the RESTRICT check that
-- runs on a key delete must not scan the receipts.
CREATE INDEX IF NOT EXISTS youtube_comment_operations_intent_key_version_idx
  ON public.youtube_comment_operations (intent_key_version);

-- ===========================================================================
-- K2. The watermark: the highest key version ever issued.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.youtube_comment_digest_key_watermark (
  singleton    boolean PRIMARY KEY DEFAULT true,
  last_version integer NOT NULL,
  CONSTRAINT youtube_comment_digest_key_watermark_singleton CHECK (singleton),
  CONSTRAINT youtube_comment_digest_key_watermark_version_check CHECK (last_version >= 0)
);

COMMENT ON TABLE public.youtube_comment_digest_key_watermark IS
  'One row: the highest digest key version ever issued (deleted ones included). '
  'Private: RLS on, no policies, no client grants, no grant to the service '
  'role; only the digest key guard trigger writes it.';

ALTER TABLE public.youtube_comment_digest_key_watermark ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_comment_digest_key_watermark
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.youtube_stage4_guard_digest_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_last integer;
BEGIN
  -- Key maintenance is serialised: two sessions that each remove a different
  -- active key would otherwise each see the other one still standing.
  PERFORM pg_advisory_xact_lock(hashtextextended('youtube_stage4_digest_keys', 0));

  -- Under REPEATABLE READ two retirements serialised by the advisory lock
  -- could each still see the other key active and leave no active key at all.
  IF TG_OP IN ('UPDATE', 'DELETE') AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'youtube_stage4_guard_digest_keys: digest key maintenance must run under READ COMMITTED (the last-active-key check reads the current state)';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A version number, once issued, is never issued again: a new version must
    -- be above EVERY version ever issued, deleted ones included. The watermark
    -- row is locked, so two sessions inserting the same new number cannot both
    -- pass, and a rolled-back insert moves nothing.
    SELECT w.last_version INTO v_last
      FROM public.youtube_comment_digest_key_watermark AS w
     WHERE w.singleton
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: the digest key watermark row is missing';
    END IF;

    IF NEW.version <= v_last THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: digest key version % was already issued; the next allowed version is %',
        NEW.version, v_last + 1;
    END IF;

    UPDATE public.youtube_comment_digest_key_watermark
       SET last_version = NEW.version
     WHERE singleton;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- An early, readable error. The foreign key on the receipts' intent key
    -- version is the AUTHORITY: this EXISTS runs in the caller's snapshot, and
    -- a REPEATABLE READ session that took its snapshot before a claim
    -- committed does not see that claim's receipt.
    IF EXISTS (
      SELECT 1 FROM public.youtube_comment_operations
       WHERE digest_key_version = OLD.version
          OR intent_key_version = OLD.version
    ) THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: digest key version % is still referenced by a receipt',
        OLD.version;
    END IF;
    -- A BEFORE DELETE trigger still sees the row being deleted, so it is
    -- excluded: another active key must remain.
    IF OLD.retired_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.youtube_comment_digest_keys AS k
       WHERE k.retired_at IS NULL
         AND k.version <> OLD.version
    ) THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: the last active digest key cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.version <> OLD.version THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: a digest key version cannot be changed';
    END IF;
    -- The bytes are what every stored digest was computed with. Replacing
    -- them under an existing version turns every retry into a conflict and
    -- blinds the duplicate fence.
    IF NEW.key IS DISTINCT FROM OLD.key THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: the key material of a version cannot be changed; rotate by inserting a new version';
    END IF;
    IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.youtube_comment_digest_keys AS k
       WHERE k.retired_at IS NULL
         AND k.version <> OLD.version
    ) THEN
      RAISE EXCEPTION
        'youtube_stage4_guard_digest_keys: the last active digest key cannot be retired';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.youtube_stage4_guard_digest_keys() IS
  'Trigger function on youtube_comment_digest_keys. A version referenced by '
  'any receipt cannot be deleted (the foreign key is the authority, this is the '
  'readable early error), the last active version can be neither deleted nor '
  'retired, a version cannot be renumbered, its key bytes never change, and an '
  'inserted version must be above every version ever issued '
  '(youtube_comment_digest_key_watermark). Maintenance is serialised by an '
  'advisory lock, and UPDATE/DELETE key maintenance is refused outside READ '
  'COMMITTED.';

DROP TRIGGER IF EXISTS trg_youtube_comment_digest_keys_guard
  ON public.youtube_comment_digest_keys;

-- Seeded with the greatest of the key versions and of the two version columns
-- of the receipts; a second application can only raise it.
INSERT INTO public.youtube_comment_digest_key_watermark (singleton, last_version)
SELECT true,
       GREATEST(
         COALESCE((SELECT max(version) FROM public.youtube_comment_digest_keys), 0),
         COALESCE((SELECT max(intent_key_version) FROM public.youtube_comment_operations), 0),
         COALESCE((SELECT max(digest_key_version) FROM public.youtube_comment_operations), 0))
ON CONFLICT (singleton) DO UPDATE
  SET last_version = GREATEST(
        public.youtube_comment_digest_key_watermark.last_version, EXCLUDED.last_version);

CREATE TRIGGER trg_youtube_comment_digest_keys_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.youtube_comment_digest_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.youtube_stage4_guard_digest_keys();

-- ===========================================================================
-- K4. The claim.
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
  p_request_id          text,
  p_intent_digests      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account   public.social_accounts%ROWTYPE;
  v_intent_cmp text;
  v_intent_new text;
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

  -- The digest map is REQUIRED. It carries the intent digest under every
  -- retained key version, and it alone decides what is stored and what is
  -- compared; the single p_intent_digest argument stays in the signature (the
  -- function keeps its identity, its owner and its grants) and decides
  -- nothing beyond being present. A missing or non-object map is malformed,
  -- and so is a map with a non-string entry. A supplied logical map must be an
  -- object of strings; only SQL NULL means it is omitted (edit and moderate).
  -- All of it is answered before the account is read.
  IF p_intent_digests IS NULL OR jsonb_typeof(p_intent_digests) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_intent_digests) AS e WHERE jsonb_typeof(e.value) <> 'string')
     OR (p_logical_digests IS NOT NULL AND (jsonb_typeof(p_logical_digests) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_each(p_logical_digests) AS e WHERE jsonb_typeof(e.value) <> 'string'))) THEN
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
  -- The active key version, locked FOR SHARE until this claim commits: a
  -- rotation cannot delete it (a delete takes the row lock and then sees the
  -- receipt this claim inserts, so the guard refuses it) between the pick and
  -- the insert. Every claim takes this, whatever its action.
  SELECT k.version INTO v_active
    FROM public.youtube_comment_digest_keys AS k
   WHERE k.retired_at IS NULL
   ORDER BY k.version DESC
   LIMIT 1
   FOR SHARE OF k;

  IF v_active IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO v_existing
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id
   FOR UPDATE;

  IF FOUND THEN
    -- The intent digest is compared under the key version the RECEIPT used,
    -- so a retry of the same key and intent after a rotation is not a
    -- conflict. A version the caller sent no digest for cannot be verified:
    -- that is temporary (the caller recomputes over every retained version),
    -- never a conflict, which a browser would show as a refusal and use to
    -- forget a live operation.
    v_intent_cmp := p_intent_digests ->> v_existing.intent_key_version::text;

    IF v_intent_cmp IS NULL OR btrim(v_intent_cmp) = '' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'upstream');
    END IF;

    IF v_intent_cmp IS DISTINCT FROM v_existing.intent_digest THEN
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
    v_logical := p_logical_digests ->> v_active::text;

    IF v_logical IS NULL OR btrim(v_logical) = '' THEN
      -- Digests computed under an older key (a rotation between the caller
      -- reading the keys and this claim) are a TEMPORARY refusal, exactly as
      -- for edit and moderate: the caller keeps its key and recomputes.
      IF btrim(COALESCE(p_intent_digests ->> v_active::text, '')) = '' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'upstream');
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
    END IF;

    -- The duplicate fence must see EVERY retained key version. A caller whose
    -- digests miss one (it read the keys before a version was added, and a
    -- rotation was later rolled back so that an older version is active
    -- again) cannot be compared against a receipt recorded under that
    -- version: the same text could then be sent twice. It is the temporary
    -- refusal; the caller keeps its key and recomputes over all versions.
    IF EXISTS (
      SELECT 1 FROM public.youtube_comment_digest_keys AS k
       WHERE btrim(COALESCE(p_logical_digests ->> k.version::text, '')) = ''
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'upstream');
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

    -- The fence compares version to version over every RETAINED key version
    -- (not over whatever the caller chose to send), so evidence written under
    -- any key, active or not, still blocks.
    FOR v_version, v_digest IN
      SELECT k.version::text, p_logical_digests ->> k.version::text
        FROM public.youtube_comment_digest_keys AS k
       ORDER BY k.version
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
  -- The stored intent digest is the one for the key version this claim LOCKED
  -- (v_active), never p_intent_digest blindly: a rotation between the caller
  -- computing its digests and this claim would otherwise store a digest of one
  -- version labelled with another, and a retry would read as a false conflict.
  -- A caller whose map lacks the locked version is refused before anything is
  -- stored; the answer is the existing temporary 'upstream', the caller keeps
  -- its key, and a retry recomputes under the new version.
  v_intent_new := p_intent_digests ->> v_active::text;
  IF v_intent_new IS NULL OR btrim(v_intent_new) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'upstream');
  END IF;

  INSERT INTO public.youtube_comment_operations (
    owner_id, operation_id, social_account_id, account_ref, channel_id,
    binding_generation, auth_provider, action, video_id, thread_id,
    parent_comment_id, comment_id, author_channel_id, moderation_status,
    ban_author, intent_digest, intent_key_version, logical_digest, digest_key_version, state,
    attempt_token, request_id, claimed_at
  )
  VALUES (
    p_owner_id, p_operation_id, p_account_id, p_account_id,
    v_account.platform_user_id, v_account.binding_generation, 'native',
    p_action, v_video, v_thread, v_parent, v_comment, v_author, v_status,
    v_ban, v_intent_new, v_active,
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

COMMENT ON FUNCTION public.youtube_comment_op_claim(uuid, uuid, text, bigint, uuid, text, jsonb, text, jsonb, text, text, jsonb) IS
  'Records the durable intent of one deliberate write, in ONE transaction, '
  'under a FOR UPDATE lock on the owner-scoped account row. It requires the '
  'account to be owned, active, stored-native, on the expected channel and on '
  'the expected binding generation, and it re-evaluates the rollout inside '
  'the lock. It then applies the per-key fence and the logical fence. A miss '
  'on the account is not_found, identical for a foreign, an absent and a '
  're-bound row. The attempt token is returned to the claim winner alone. '
  'The digest map p_intent_digests is required (NULL or a non-object is '
  'invalid_request) and alone decides what is stored and compared; '
  'p_intent_digest is kept for the signature and decides nothing, like '
  'p_capability. A retry whose map lacks the receipt''s key version is the '
  'temporary upstream, never a conflict.';

-- ===========================================================================
-- K3. The status.
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
  v_op_id   uuid;
  v_account public.social_accounts%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_account_id IS NULL OR p_operation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  -- 1. A plain, unlocked read that only answers whether the receipt exists.
  -- An operation id with no receipt locks nothing and answers not_found.
  PERFORM 1
     FROM public.youtube_comment_operations
    WHERE owner_id = p_owner_id
      AND operation_id = p_operation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 2. The account row, owner-scoped and locked FOR SHARE, BEFORE the receipt
  -- is read for the answer: the order the claim and the mark already use
  -- (account, then receipt). A rebind or an account delete now waits for this
  -- read, and the winning settlement read back below belongs to a binding that
  -- is still current when the call returns. FOR SHARE does not serialise
  -- concurrent status reads. The lock is held to the end of the call, which is
  -- one short statement.
  SELECT * INTO v_account
    FROM public.social_accounts
   WHERE id = p_account_id
     AND user_id = p_owner_id
   FOR SHARE;

  -- The receipt is readable only under the CURRENT binding. After a
  -- disconnect, a reconnect or a re-creation it answers not_found, for the
  -- same owner too.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 3. The receipt again, now that the binding cannot change. Nothing from the
  -- unlocked read above is used: the receipt can be gone (the 30 day prune,
  -- an owner cascade) between the two reads, and then it is not_found.
  SELECT * INTO v_op
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  v_op_id := v_op.id;

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
  -- The answer is always the row as it stands AFTER the conversion: when a
  -- concurrent settlement won the race the conditional UPDATE matches nothing
  -- and the winning row is read back, so a confirmed result is never reported
  -- as an unknown outcome.
  IF v_op.state = 'dispatched'
     AND v_op.dispatched_at IS NOT NULL
     AND v_op.dispatched_at < clock_timestamp() - interval '90 seconds' THEN
    UPDATE public.youtube_comment_operations
       SET state = 'indeterminate',
           reason = COALESCE(reason, 'no_settlement'),
           settled_at = clock_timestamp()
     WHERE id = v_op_id
       AND state = 'dispatched'
       AND attempt_token = v_op.attempt_token
    RETURNING * INTO v_op;

    IF NOT FOUND THEN
      SELECT * INTO v_op FROM public.youtube_comment_operations WHERE id = v_op_id;
    END IF;
  -- A claim that was never dispatched is closed after 120 s, as the claim does
  -- for the same owner; the status read closes it for the one receipt asked
  -- about, so a reload after a handler that stopped before the mark learns
  -- that nothing was sent instead of waiting for another claim.
  ELSIF v_op.state = 'claimed'
     AND v_op.dispatched_at IS NULL
     AND v_op.claimed_at < clock_timestamp() - interval '120 seconds' THEN
    UPDATE public.youtube_comment_operations
       SET state = 'refused',
           reason = 'abandoned_before_dispatch',
           settled_at = clock_timestamp()
     WHERE id = v_op_id
       AND state = 'claimed'
       AND dispatched_at IS NULL
       AND claimed_at < clock_timestamp() - interval '120 seconds'
    RETURNING * INTO v_op;

    IF NOT FOUND THEN
      SELECT * INTO v_op FROM public.youtube_comment_operations WHERE id = v_op_id;
    END IF;
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
    -- The comment the operation was aimed at, kept apart from the result: an
    -- edit whose settlement failed has no result id, but its target is known.
    'target_comment_id', v_op.comment_id,
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
  'is what a disconnect or a reconnect produces. It reads no provider. It '
  'takes a FOR SHARE lock on the owner-scoped account row once a receipt is '
  'known to exist (account first, receipt second, like the claim and the '
  'mark), so a rebind or an account delete waits for a status read in flight '
  'and the receipt it returns after a lost conversion belongs to a binding '
  'that is still current. An operation id with no receipt locks nothing.';

-- ===========================================================================
-- The boundary self-check. The migration fails rather than shipping a guard
-- that is not there. It checks what it changed and what it promised not to.
-- ===========================================================================
DO $assert_key_integrity$
DECLARE
  v_owner_name text;
  v_writers    text[];
  v_max_seen   integer;
BEGIN
  -- K1: the foreign key exists, is validated and restricts; the CHECK exists and is validated.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.youtube_comment_operations'::regclass
       AND conname = 'youtube_comment_operations_intent_key_version_fkey'
       AND contype = 'f' AND convalidated
       AND confdeltype = 'r' AND confupdtype = 'r'
       AND confrelid = 'public.youtube_comment_digest_keys'::regclass
  ) THEN
    RAISE EXCEPTION 'the receipts must carry a validated ON DELETE RESTRICT foreign key on the intent key version';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.youtube_comment_operations'::regclass
       AND conname = 'youtube_comment_operations_key_versions_check'
       AND contype = 'c' AND convalidated
  ) THEN
    RAISE EXCEPTION 'the receipts must carry the validated key version CHECK';
  END IF;

  -- K2: the trigger fires on INSERT, UPDATE and DELETE, before the row, per row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger AS t
     WHERE t.tgrelid = 'public.youtube_comment_digest_keys'::regclass
       AND t.tgname = 'trg_youtube_comment_digest_keys_guard'
       AND NOT t.tgisinternal
       AND (t.tgtype & 1) <> 0     -- FOR EACH ROW
       AND (t.tgtype & 2) <> 0     -- BEFORE
       AND (t.tgtype & 4) <> 0     -- INSERT
       AND (t.tgtype & 8) <> 0     -- DELETE
       AND (t.tgtype & 16) <> 0    -- UPDATE
  ) THEN
    RAISE EXCEPTION 'the digest key guard must fire BEFORE INSERT OR UPDATE OR DELETE, per row';
  END IF;

  -- K2: the watermark is at or above every version in the key table and in the
  -- receipts. (Not equal: after a delete it is legitimately higher.)
  SELECT GREATEST(
           COALESCE((SELECT max(version) FROM public.youtube_comment_digest_keys), 0),
           COALESCE((SELECT max(intent_key_version) FROM public.youtube_comment_operations), 0),
           COALESCE((SELECT max(digest_key_version) FROM public.youtube_comment_operations), 0))
    INTO v_max_seen;

  IF NOT EXISTS (
    SELECT 1 FROM public.youtube_comment_digest_key_watermark
     WHERE singleton AND last_version >= v_max_seen
  ) THEN
    RAISE EXCEPTION 'the digest key watermark must exist and be at or above every version in use';
  END IF;

  IF (SELECT count(*) FROM public.youtube_comment_digest_key_watermark) <> 1 THEN
    RAISE EXCEPTION 'the digest key watermark must hold exactly one row';
  END IF;

  -- The watermark table is private like the two Stage 4 tables.
  IF NOT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_comment_digest_key_watermark'::regclass) THEN
    RAISE EXCEPTION 'youtube_comment_digest_key_watermark must have RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_comment_digest_key_watermark'
  ) THEN
    RAISE EXCEPTION 'youtube_comment_digest_key_watermark must carry no policy';
  END IF;

  IF has_table_privilege('anon', 'public.youtube_comment_digest_key_watermark', 'SELECT')
     OR has_table_privilege('authenticated', 'public.youtube_comment_digest_key_watermark', 'SELECT')
     OR has_table_privilege('service_role', 'public.youtube_comment_digest_key_watermark', 'SELECT')
     OR has_table_privilege('anon', 'public.youtube_comment_digest_key_watermark', 'INSERT')
     OR has_table_privilege('authenticated', 'public.youtube_comment_digest_key_watermark', 'INSERT')
     OR has_table_privilege('service_role', 'public.youtube_comment_digest_key_watermark', 'INSERT')
     OR has_table_privilege('service_role', 'public.youtube_comment_digest_key_watermark', 'UPDATE') THEN
    RAISE EXCEPTION 'no client role and not the service role may reach youtube_comment_digest_key_watermark';
  END IF;

  -- The replaced functions are SECURITY DEFINER with a pinned search_path.
  IF NOT (SELECT bool_and(COALESCE(p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig), false))
            FROM pg_proc AS p
           WHERE p.oid IN (
             'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text,jsonb)'::regprocedure,
             'public.youtube_comment_op_status(uuid,uuid,uuid)'::regprocedure,
             'public.youtube_stage4_guard_digest_keys()'::regprocedure)) THEN
    RAISE EXCEPTION 'the replaced Stage 4 functions must be SECURITY DEFINER with a pinned search_path';
  END IF;

  -- EXECUTE on the claim and the status: the service role alone.
  IF NOT has_function_privilege('service_role',
       'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.youtube_comment_op_status(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the service role must keep EXECUTE on the claim and the status';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc AS p
     WHERE p.oid IN (
       'public.youtube_comment_op_claim(uuid,uuid,text,bigint,uuid,text,jsonb,text,jsonb,text,text,jsonb)'::regprocedure,
       'public.youtube_comment_op_status(uuid,uuid,uuid)'::regprocedure,
       'public.youtube_stage4_guard_digest_keys()'::regprocedure)
       AND (
         has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS x
            WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'
         )
       )
  ) THEN
    RAISE EXCEPTION 'PUBLIC, anon and authenticated must hold no EXECUTE on the replaced Stage 4 functions';
  END IF;

  -- Not touched: the three token store functions keep their narrow owner.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_writers
    FROM pg_proc AS p
    JOIN pg_roles AS r ON r.oid = p.proowner
   WHERE r.rolname = 'youtube_stage4_refresh';

  IF v_writers IS DISTINCT FROM
     ARRAY['store_youtube_refreshed_token', 'store_youtube_refreshed_token_with_lease',
           'store_youtube_refreshed_token_with_lease_neutral'] THEN
    RAISE EXCEPTION
      'youtube_stage4_refresh must still own EXACTLY the three trusted refresh functions, found: %',
      coalesce(v_writers::text, 'none');
  END IF;

  FOR v_owner_name IN
    SELECT DISTINCT r.rolname
      FROM pg_proc AS p
      JOIN pg_roles AS r ON r.oid = p.proowner
     WHERE p.oid IN (
       'public.store_youtube_refreshed_token(uuid,text,text,timestamptz,text,timestamptz)'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease(uuid,uuid,text,timestamptz,text,text[])'::regprocedure,
       'public.store_youtube_refreshed_token_with_lease_neutral(uuid,uuid,text,timestamptz,text)'::regprocedure)
  LOOP
    IF v_owner_name <> 'youtube_stage4_refresh' THEN
      RAISE EXCEPTION 'the trusted refresh functions must stay owned by youtube_stage4_refresh, found %', v_owner_name;
    END IF;
  END LOOP;
END
$assert_key_integrity$;

COMMIT;
