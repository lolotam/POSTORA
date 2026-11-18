-- The recovery reads what the owner can write, and it locks what it settles.
--
-- WHY THIS EXISTS. Four findings about the YouTube recovery, all of them in
-- the same shape: a value that the CUSTOMER can write, or a row that another
-- worker can write at the same time, was read as if it were trustworthy.
--
--   1. The rollup fence failed OPEN. The fence asks whether this attempt
--      already rolled the parent up. A marker that is missing leaves the test
--      NULL, and NULL skipped the refusal, so a post that was cancelled or
--      superseded could be closed by an attempt that had proved nothing.
--      The fence now fails closed.
--
--   2. The candidate was cast without a guard. The candidate lives in
--      `posts.metadata`, and the owner can write that column: one malformed
--      value raised inside the recovery and took the whole reconciler down
--      with it, so every session behind it starved. The shape is checked
--      before it is read, and an unusable candidate is refused instead.
--
--   3. The terminal scan selected sessions that can never be classified. A
--      session without an attempt is refused with 'stale_attempt' and changes
--      nothing, so it was selected again on every pass and starved the
--      sessions that CAN be settled. The sibling scan already left them out.
--
--   4. The disconnect settled a session it had not locked. The receipt was
--      derived from a snapshot taken without a lock, so a completion that
--      landed in between was overwritten by a failure. The session is now
--      taken through the shared lock helper -- the same order every other
--      writer shares -- and the receipt is read under it.
--
-- This migration is a REWRITE of four functions. It adds no table, no column
-- and no contract: the outcomes, the reasons and the answers are the same
-- ones, read from data that can be trusted.
--
-- ---------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION public.recover_youtube_upload_fanout(
  p_session_id uuid,
  p_lease_token uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_candidate jsonb;
  v_candidate_attempt timestamptz;
  v_rollup_attempt timestamptz;
  v_targets uuid[];
  v_retained uuid[];
  v_rows uuid[];
  v_unknown uuid[];
  v_removed uuid[] := ARRAY[]::uuid[];
  v_attempt timestamptz;
  v_closed jsonb;
  v_new_row uuid;
  v_platform text;
  r_target record;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'invalid_arguments');
  END IF;

  SELECT * INTO v_session FROM public.youtube_upload_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'session_not_found');
  END IF;

  -- THE AUTHORITY
  -- -------------
  -- The lease is not the authority here: the SESSION is.
  --
  -- A session that reached a terminal state was settled by the worker that
  -- owned it, and the settlement is what made the public row terminal. The
  -- scope below is read from the database, not from the caller, so a caller
  -- that arrives late, or twice, can only cause the closure that the database
  -- already implies.
  --
  -- A caller that owns a live lease is allowed in as well, so the closure may
  -- run BEFORE the settlement. The continuation does exactly that: the pending
  -- YouTube row is what keeps the generic sweeper from reading the absence of a
  -- sibling row as a proof, so the scope has to be settled while that row is
  -- still pending.
  IF NOT (
    v_session.state IN ('uploaded', 'failed', 'reconcile')
    OR (
      v_session.lease_token IS NOT DISTINCT FROM p_lease_token
      AND v_session.lease_expires_at IS NOT NULL
      AND v_session.lease_expires_at > clock_timestamp()
    )
  ) THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'lease_stale');
  END IF;

  -- The parent is locked first, and the attempt must still be the running
  -- one. A cancelled or superseded post keeps its own outcome.
  SELECT * INTO v_post FROM public.posts WHERE id = v_session.post_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'post_not_found');
  END IF;
  v_attempt := v_session.attempt_started_at;
  -- A session that carries NO attempt cannot be compared with the post, so the
  -- closure leaves it alone: the fence that would say whether the attempt is
  -- still the running one is the one that is missing.
  IF v_attempt IS NULL OR v_post.processing_started_at IS DISTINCT FROM v_attempt THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'stale_attempt');
  END IF;
  IF v_post.status <> 'processing' THEN
    -- The parent may already have been rolled up by THIS attempt's own
    -- closure. That is the same authority every other settlement path reads,
    -- and it is what makes the closure repeatable: a second call finds the
    -- scope it froze and changes nothing.
    --
    -- A post that was cancelled or superseded does not carry those markers,
    -- so it is still refused.
    --
    -- The markers are read through a guarded cast, and the fence is tested
    -- with IS NOT TRUE. A marker that is missing or malformed leaves the
    -- test NULL, and NULL would have let a post that is NOT processing
    -- through: the fence failed open. It fails closed now.
    v_rollup_attempt := CASE
      WHEN (v_post.metadata ->> 'settlement_rollup_processing_started_at')
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]'
      THEN (v_post.metadata ->> 'settlement_rollup_processing_started_at')::timestamptz
      ELSE NULL
    END;
    IF (
      v_post.status IN ('completed', 'failed')
      AND v_post.metadata ->> 'settlement_rollup_status' = v_post.status
      AND v_rollup_attempt = v_attempt
    ) IS NOT TRUE THEN
      RETURN jsonb_build_object('recovered', false, 'reason', 'post_not_processing');
    END IF;
  END IF;

  --
  -- THE CANDIDATE IS NOT TRUSTED
  --
  -- The candidate lives in `posts.metadata`, and the owner can write that
  -- column. Its shape is therefore checked BEFORE anything is read out of it.
  -- A value that is not a timestamp, an array or a uuid is refused here, and
  -- refused means refused: it never raises, because one poisoned row would
  -- otherwise take the whole reconciler down with it and starve every
  -- session behind it.
  v_candidate := v_post.metadata -> 'legacy_notification_candidate';
  v_candidate_attempt := CASE
    WHEN (v_candidate ->> 'attempt_started_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]'
    THEN (v_candidate ->> 'attempt_started_at')::timestamptz
    ELSE NULL
  END;

  IF v_candidate IS NULL
     OR jsonb_typeof(v_candidate) <> 'object'
     OR v_candidate_attempt IS DISTINCT FROM v_attempt THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'no_candidate_for_attempt');
  END IF;

  IF (jsonb_typeof(v_candidate -> 'target_account_ids') IS NOT NULL
      AND jsonb_typeof(v_candidate -> 'target_account_ids') <> 'array')
     OR (jsonb_typeof(v_candidate -> 'retained_platform_post_ids') IS NOT NULL
         AND jsonb_typeof(v_candidate -> 'retained_platform_post_ids') <> 'array')
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(coalesce(v_candidate -> 'target_account_ids', '[]'::jsonb)) x
        WHERE x !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(coalesce(v_candidate -> 'retained_platform_post_ids', '[]'::jsonb)) x
        WHERE x !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     ) THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'no_candidate_for_attempt');
  END IF;

  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_targets
    FROM jsonb_array_elements_text(coalesce(v_candidate -> 'target_account_ids', '[]'::jsonb)) x;
  SELECT coalesce(array_agg(x::uuid), ARRAY[]::uuid[]) INTO v_retained
    FROM jsonb_array_elements_text(coalesce(v_candidate -> 'retained_platform_post_ids', '[]'::jsonb)) x;
  IF cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('recovered', false, 'reason', 'no_target_scope');
  END IF;

  -- THE QUIESCENCE BOUNDARY
  -- -----------------------
  -- The worker that owns this attempt may still be publishing to the
  -- destinations that have no row yet. Closing the fanout now would freeze a
  -- scope that is about to change, so the recovery waits until that worker
  -- cannot write any more. The reconciler calls this again, so the wait is
  -- bounded and the post is not held open for ever.
  IF v_post.processing_started_at IS NOT NULL
     AND now() < v_post.processing_started_at + public.youtube_upload_attempt_quiet_after() THEN
    IF (v_candidate ->> 'fanout_state') IS DISTINCT FROM 'youtube_upload_attempt_running' THEN
      v_candidate := v_candidate || jsonb_build_object(
        'fanout_state', 'youtube_upload_attempt_running',
        'fanout_recovered_at', now(),
        'fanout_recovery_reason', 'the worker of this attempt may still be publishing, so the fanout scope is not closed yet'
      );
      UPDATE public.posts
         SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
       WHERE id = v_post.id;
    END IF;
    RETURN jsonb_build_object(
      'recovered', false,
      'reason', 'attempt_may_still_be_running',
      'quiet_after', v_post.processing_started_at + public.youtube_upload_attempt_quiet_after()
    );
  END IF;

  -- The rows this attempt owns, for its own destinations.
  SELECT coalesce(array_agg(pp.id ORDER BY pp.id), ARRAY[]::uuid[]) INTO v_rows
    FROM public.platform_posts pp
   WHERE pp.post_id = v_post.id
     AND pp.social_account_id = ANY(v_targets)
     AND (
       pp.created_at >= v_attempt
       OR (
         CASE WHEN (pp.response_data #>> '{deferred,attempt_started_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]'
              THEN (pp.response_data #>> '{deferred,attempt_started_at}')::timestamptz
              ELSE NULL END = v_attempt
       )
     );

  -- A destination with no row has an UNKNOWN outcome. It did not necessarily
  -- never start: the other platforms write their row after the provider call,
  -- so the worker may have published and died before it recorded the receipt.
  v_unknown := ARRAY[]::uuid[];
  FOR r_target IN SELECT unnest(v_targets) AS account_id LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_posts pp
       WHERE pp.id = ANY(v_rows) AND pp.social_account_id = r_target.account_id
    ) THEN
      v_unknown := array_append(v_unknown, r_target.account_id);
    END IF;
  END LOOP;

  IF cardinality(v_unknown) > 0 THEN
    -- Each unknown destination is terminalised with a NON-RETRYABLE reason, so
    -- the scope becomes complete and the fanout can close, and so a retry can
    -- never publish a second time to a destination whose outcome is unknown.
    FOR r_target IN SELECT unnest(v_unknown) AS account_id LOOP
      SELECT sa.platform INTO v_platform
        FROM public.social_accounts sa
       WHERE sa.id = r_target.account_id
         AND sa.user_id = v_post.user_id;

      IF v_platform IS NULL THEN
        -- The account is gone or belongs to somebody else. It cannot be
        -- published to, so there is nothing to close -- but it IS still a
        -- destination of this attempt, and the closure reads the scope it
        -- froze. A scope that names a destination without a result row is
        -- refused, so the account leaves the scope IN THIS TRANSACTION.
        --
        -- The record of the unknown outcome stays: the account may have been
        -- published to before it was disconnected, and that is a possible side
        -- effect nobody may forget.
        v_removed := array_append(v_removed, r_target.account_id);
        CONTINUE;
      END IF;

      v_new_row := public.partner_close_ambiguous_destination(v_post.id, r_target.account_id, v_platform);
      IF v_new_row IS NOT NULL THEN
        v_rows := array_append(v_rows, v_new_row);
      END IF;
    END LOOP;

    -- THE SCOPE AND THE CLOSURE HAVE TO AGREE
    --
    -- The scope is the list of destinations this attempt owns, and the
    -- closure is refused when one of them has no result row. A destination
    -- that cannot be published to any more leaves the scope here, so the
    -- closure can run, and the unknown outcome of that destination stays
    -- recorded in the candidate.
    IF cardinality(v_removed) > 0 THEN
      v_candidate := v_candidate || jsonb_build_object(
        'target_account_ids', (
          SELECT coalesce(jsonb_agg(x), '[]'::jsonb)
            FROM jsonb_array_elements_text(v_candidate -> 'target_account_ids') x
           WHERE NOT (x::uuid = ANY(v_removed))
        )
      );
    END IF;

    v_candidate := v_candidate || jsonb_build_object(
      'fanout_state', 'youtube_upload_unknown_scope',
      'fanout_unknown_account_ids', to_jsonb(v_unknown),
      'fanout_recovered_at', now(),
      'fanout_recovery_reason', 'these destinations have no result row, so their outcome is unknown and they are not retried automatically'
    );
    UPDATE public.posts
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacy_notification_candidate}', v_candidate, true)
     WHERE id = v_post.id;
  END IF;

  v_closed := public.close_post_fanout(
    v_post.id,
    v_attempt,
    v_candidate -> 'content_fence',
    v_rows,
    v_retained
  );

  RETURN jsonb_build_object(
    'recovered', coalesce((v_closed ->> 'closed')::boolean, false),
    'reason', v_closed ->> 'error',
    'closed', v_closed,
    'unknown_account_ids', to_jsonb(v_unknown)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_youtube_upload_fanouts(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_cancelled integer := 0;
  v_attempted integer := 0;
  v_recovered integer := 0;
  v_result jsonb;
  v_terminal jsonb;
  r_session record;
BEGIN
  v_limit := least(50, greatest(0, coalesce(p_limit, 5)));

  -- The pending rows of cancelled posts.
  --
  -- A session that is already terminal is closed as well: a worker that died
  -- between the release and the settlement leaves a terminal session with a
  -- pending row, and the continuation cannot settle it because it refuses a
  -- post that is no longer being processed.
  FOR r_session IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('open', 'uploaded', 'failed', 'expired', 'reconcile')
       AND ys.platform_post_id IS NOT NULL
       AND p.status IN ('pending', 'failed', 'scheduled')
       AND p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at
       AND EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.id = ys.platform_post_id
            AND pp.status = 'pending'
       )
     ORDER BY ys.updated_at, ys.id
     LIMIT v_limit
  LOOP
    v_result := public.youtube_upload_terminalize_cancelled(r_session.id);
    IF coalesce((v_result ->> 'terminalized')::boolean, false) THEN
      v_cancelled := v_cancelled + 1;
    END IF;
  END LOOP;

  -- The terminal sessions whose public row is still pending.
  --
  -- This is the window a worker that died between the release and the
  -- settlement leaves: the session is terminal and the row is pending, so the
  -- post waits for an outcome that never comes.
  v_terminal := public.recover_youtube_upload_terminal_results(v_limit);

  -- The fanouts a dead worker left open. The session has to be terminal,
  -- because that is the authority the closure itself accepts, and the attempt
  -- has to be quiet, because a live worker is about to write the row the
  -- scope is missing.
  FOR r_session IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('uploaded', 'failed', 'reconcile')
       AND p.status = 'processing'
       AND p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at
       AND p.metadata ? 'legacy_notification_candidate'
       AND CASE WHEN (p.metadata #>> '{legacy_notification_candidate,attempt_started_at}')
                      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]'
                 THEN (p.metadata #>> '{legacy_notification_candidate,attempt_started_at}')::timestamptz
                 ELSE NULL END
           IS NOT DISTINCT FROM ys.attempt_started_at
       AND (p.metadata #>> '{legacy_notification_candidate,fanout_closed}') IS DISTINCT FROM 'true'
       AND p.processing_started_at + public.youtube_upload_attempt_quiet_after() <= now()
     ORDER BY p.processing_started_at, ys.id
     LIMIT v_limit
  LOOP
    v_attempted := v_attempted + 1;
    v_result := public.recover_youtube_upload_fanout(r_session.id, NULL);
    IF coalesce((v_result ->> 'recovered')::boolean, false) THEN
      v_recovered := v_recovered + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'cancelled_rows', v_cancelled,
    'terminal_rows', v_terminal,
    'fanouts_attempted', v_attempted,
    'fanouts_recovered', v_recovered
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_youtube_upload_terminal_results(p_limit integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_candidate record;
  v_result jsonb;
  v_examined integer := 0;
  v_settled integer := 0;
  v_manual integer := 0;
BEGIN
  v_limit := least(50, greatest(0, coalesce(p_limit, 5)));

  FOR v_candidate IN
    SELECT ys.id
      FROM public.youtube_upload_sessions ys
      JOIN public.posts p ON p.id = ys.post_id
     WHERE ys.state IN ('failed', 'expired', 'reconcile')
       AND ys.platform_post_id IS NOT NULL
       -- A worker that still holds the lease is about to settle the row
       -- itself: the release keeps the lease on purpose.
       AND (ys.lease_expires_at IS NULL OR ys.lease_expires_at <= clock_timestamp())
       -- The authority of the classification, in the query as well: the post
       -- must still be processing and the attempt must still be the running
       -- one, so a cancelled or superseded post keeps its own outcome.
       AND p.status = 'processing'
       --
      -- A session that carries NO attempt cannot be classified: the
      -- classifier refuses it with 'stale_attempt' and changes nothing, so
      -- it would be selected again on the next pass and starve the sessions
      -- that CAN be settled. The sibling scan leaves them out for the same
      -- reason.
      AND ys.attempt_started_at IS NOT NULL
      AND p.processing_started_at IS NOT DISTINCT FROM ys.attempt_started_at
       AND EXISTS (
         SELECT 1 FROM public.platform_posts pp
          WHERE pp.id = ys.platform_post_id
            AND pp.status = 'pending'
       )
     ORDER BY ys.updated_at, ys.id
     LIMIT v_limit
  LOOP
    v_examined := v_examined + 1;
    v_result := public.youtube_upload_classify_terminal(v_candidate.id);
    IF coalesce((v_result ->> 'settled')::boolean, false) THEN
      v_settled := v_settled + 1;
    END IF;
    IF (v_result ->> 'reason') = 'youtube_upload_reconcile_required' THEN
      v_manual := v_manual + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'examined', v_examined,
    'settled', v_settled,
    'manual', v_manual
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.terminalize_youtube_upload_sessions_of_account(
  p_social_account_id uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.youtube_upload_sessions%ROWTYPE;
  v_session_id uuid;
  v_count integer := 0;
  v_uncertain boolean;
  v_receipt text;
  v_channel_id text;
BEGIN
  IF p_social_account_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The channel of the account that is going away.
  --
  -- The row is still there: this runs BEFORE the delete. The channel is the
  -- identity that outlives the row, because a reconnect cannot reuse a
  -- deleted id but it does land on the same channel.
  SELECT sa.platform_user_id INTO v_channel_id
    FROM public.social_accounts sa WHERE sa.id = p_social_account_id;

  FOR v_session IN
    SELECT s.id FROM public.youtube_upload_sessions s
     WHERE s.social_account_id = p_social_account_id
       AND s.state IN ('open', 'uploaded', 'expired', 'reconcile', 'failed')
  LOOP
    --
    -- THE SCOPE, IN THE ORDER EVERY WRITER SHARES
    --
    -- The session is taken through the shared helper, so the parent is
    -- locked before it, and the receipt is read again UNDER that lock. The
    -- scan above ran without one: it could read a session that a
    -- continuation completed a moment later, and the settlement below would
    -- then have overwritten that completion with a failure.
    v_session_id := v_session.id;
    IF NOT coalesce((public.youtube_upload_lock_scope(v_session_id) ->> 'locked')::boolean, false) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_session
      FROM public.youtube_upload_sessions
     WHERE id = v_session_id;

    v_receipt := v_session.video_id;

    -- THE OUTCOME OF THIS SESSION
    --
    -- A video may exist when a byte ever reached the provider, when the
    -- provider may already have turned the upload into one, or when the
    -- session was ALREADY marked for a human.
    --
    -- The mark is what keeps a second video off the channel, and a disconnect
    -- must never take it away: a session that was marked for a human before
    -- the disconnect is still marked for a human after it, even when it never
    -- sent a byte.
    v_uncertain := v_session.video_may_exist
      OR v_session.bytes_sent > 0
      OR v_session.state = 'reconcile';

    -- The public row is settled BEFORE the account goes, so the parent does
    -- not wait for a destination that is about to disappear. The row itself
    -- goes with the account: its result belongs to the account.
    IF v_session.platform_post_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.platform_posts pp
       WHERE pp.id = v_session.platform_post_id AND pp.status = 'pending'
    ) THEN
      IF v_receipt IS NOT NULL THEN
        -- THE RECEIPT IS A PROOF, NOT A FAILURE
        --
        -- The provider accepted the video and gave its id, so the video IS on
        -- the channel. Settling the row as a failure would report a
        -- publication that happened as one that did not, would lose the video
        -- id, and would roll the parent up to 'failed' for a post whose video
        -- is published.
        --
        -- So the receipt is settled with the row and the parent keeps the
        -- result it earned. The row goes with the account, as it does for
        -- every platform; the receipt stays on the session, which is the row
        -- that outlives it.
        PERFORM public.partner_settle_platform_post(
          v_session.platform_post_id,
          v_session.post_id,
          v_session.social_account_id,
          'youtube',
          'success',
          v_receipt,
          'https://www.youtube.com/watch?v=' || v_receipt,
          NULL,
          jsonb_build_object(
            'youtube_upload_reason', 'youtube_upload_account_disconnected_after_publish'
          )
        );
      ELSIF v_uncertain THEN
        PERFORM public.partner_settle_platform_post(
          v_session.platform_post_id,
          v_session.post_id,
          v_session.social_account_id,
          'youtube',
          'failed',
          NULL,
          NULL,
          'the account was disconnected before the upload finished',
          jsonb_build_object(
            'youtube_upload_reason', 'youtube_upload_account_disconnected',
            'publish_outcome', 'uncertain',
            'publish_outcome_reason',
              'the account was disconnected while the upload was in flight, so YouTube may already hold a video'
          )
        );
      ELSE
        PERFORM public.partner_settle_platform_post(
          v_session.platform_post_id,
          v_session.post_id,
          v_session.social_account_id,
          'youtube',
          'failed',
          NULL,
          NULL,
          'the account was disconnected before the upload finished',
          jsonb_build_object(
            'youtube_upload_reason', 'youtube_upload_account_disconnected'
          )
        );
      END IF;
    END IF;

    -- The session becomes terminal and keeps its evidence. The URI is a
    -- credential of an account that no longer exists, so it goes.
    --
    -- The marker of an uncertain outcome stays on the session as well, because
    -- the public row goes with the account: the session is the row that
    -- outlives it, and it is what a later admission reads.
    UPDATE public.youtube_upload_sessions
       SET state = CASE WHEN v_receipt IS NOT NULL THEN 'uploaded'
                        WHEN v_uncertain THEN 'reconcile'
                        ELSE 'failed' END,
           last_outcome = CASE WHEN v_uncertain THEN 'youtube_upload_reconcile_required'
                               ELSE last_outcome END,
           session_uri = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           disconnected_channel_id = v_channel_id,
           error = left(CASE WHEN v_receipt IS NOT NULL
                              THEN 'the account was disconnected after the video was published'
                              ELSE 'the account was disconnected before the upload finished'
                         END, 300),
           updated_at = clock_timestamp()
     WHERE id = v_session.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
