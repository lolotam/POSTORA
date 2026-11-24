-- ===========================================================================
-- 20261124120000_youtube_stage4_key_integrity_rollback.sql
--
-- Rolls back the SQL half of YouTube Stage 4 follow-up PR 2. NOT a migration:
-- it lives outside supabase/migrations/ on purpose (the harness applies every
-- file in that directory). Procedure and the note about the watermark value:
-- docs/runbooks/youtube-stage4-pr2-migration.md.
--
-- APPLY AS supabase_admin, with ON_ERROR_STOP on. One transaction. It changes
-- no receipt and no key. It restores the three function bodies of
-- 20261122130000 (copied verbatim, byte for byte, from that file), recreates
-- the guard trigger as BEFORE UPDATE OR DELETE, drops the foreign key, the
-- CHECK and the index, and drops the watermark table (the record of deleted
-- version numbers goes with it: note last_version BEFORE rolling back).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. The three function bodies of 20261122130000.
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
    -- conflict. A version the caller sent no digest for cannot be verified.
    v_intent_cmp := COALESCE(
      p_intent_digests ->> v_existing.intent_key_version::text,
      CASE WHEN v_existing.intent_key_version = v_active THEN p_intent_digest END);

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
      IF p_intent_digests IS NOT NULL
         AND btrim(COALESCE(p_intent_digests ->> v_active::text, '')) = '' THEN
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
  -- A caller that sent a digest map without the locked version is refused
  -- before anything is stored; the answer is the existing temporary
  -- 'upstream', the caller keeps its key, and a retry recomputes under the
  -- new version. (A caller that sends no map keeps the single-digest form.)
  IF p_intent_digests IS NULL THEN
    v_intent_new := p_intent_digest;
  ELSE
    v_intent_new := p_intent_digests ->> v_active::text;
    IF v_intent_new IS NULL OR btrim(v_intent_new) = '' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'upstream');
    END IF;
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
  're-bound row. The attempt token is returned to the claim winner alone.';

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

  SELECT * INTO v_op
    FROM public.youtube_comment_operations
   WHERE owner_id = p_owner_id
     AND operation_id = p_operation_id;
  v_op_id := v_op.id;

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
  'is what a disconnect or a reconnect produces. It reads no provider.';

CREATE OR REPLACE FUNCTION public.youtube_stage4_guard_digest_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Key maintenance is serialised: two sessions that each remove a different
  -- active key would otherwise each see the other one still standing.
  PERFORM pg_advisory_xact_lock(hashtextextended('youtube_stage4_digest_keys', 0));

  IF TG_OP = 'DELETE' THEN
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
  'any receipt cannot be deleted, the last active version can be neither '
  'deleted nor retired, a version cannot be renumbered and its key bytes '
  'never change. Maintenance is serialised by an advisory lock.';

-- 2. The guard trigger fires on UPDATE and DELETE again, not on INSERT.
DROP TRIGGER IF EXISTS trg_youtube_comment_digest_keys_guard
  ON public.youtube_comment_digest_keys;

CREATE TRIGGER trg_youtube_comment_digest_keys_guard
  BEFORE UPDATE OR DELETE ON public.youtube_comment_digest_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.youtube_stage4_guard_digest_keys();

-- 3. The foreign key, the CHECK and the index.
ALTER TABLE public.youtube_comment_operations
  DROP CONSTRAINT IF EXISTS youtube_comment_operations_intent_key_version_fkey;
ALTER TABLE public.youtube_comment_operations
  DROP CONSTRAINT IF EXISTS youtube_comment_operations_key_versions_check;
DROP INDEX IF EXISTS public.youtube_comment_operations_intent_key_version_idx;

-- 4. The watermark table.
DROP TABLE IF EXISTS public.youtube_comment_digest_key_watermark;

COMMIT;
