-- ===========================================================================
-- Task 7 prerequisite - competitor collection results.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   Task 7 ("Competitor watchlist application and sync"), section 5.3
--   ("Sync lifecycle and provider contracts") and the acceptance list
--   A10-A13 / H3.
--
-- APPLY AS supabase_admin. It owns the functions below; postgres is not a
-- superuser on this stack and a REVOKE by a non-owner is a WARNING that
-- changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   Two narrowly named, service-only functions that the
--   `competitor-snapshot-sync` worker calls:
--
--     1. persist_competitor_collection_result(job, token, generation, payload)
--        - the ATOMIC result write. One profile snapshot, at most thirty
--          distinct media snapshots, the durable operation rows, the
--          watchlist status and the job outcome all commit together or not
--          at all.
--
--     2. list_due_competitor_collection_targets(limit, cursor)
--        - the bounded, ordered, cursor-paged read of the watchlist entries
--          that are due for a collection attempt. The scheduled enqueue path
--          uses it; it never scans an unbounded queue.
--
-- WHY THIS EXISTS AT ALL
--
--   The accepted job contract (20261026150000) can persist a competitor
--   profile/media snapshot and can complete a job, but it cannot express
--   what Task 7 needs:
--
--     * Every provider-result write in the accepted contract goes through
--       ig_collection_load_fenced_job(..., require_context => true, ...).
--       A competitor job with no viewer therefore cannot record ANY
--       outcome, not even the failure that explains why there is no
--       viewer. A job whose only truth is "no usable viewer" would sit in
--       'leased' until its lease expired and then be reclaimed, forever,
--       without ever explaining itself to the owner.
--
--     * The accepted completion only updates the job row. It never
--       publishes the watchlist status, never advances last_synced_at and
--       never sets the weekly next_retry_at of an unavailable target. The
--       owner would keep seeing 'pending' for a competitor that was
--       collected every single day.
--
--     * The accepted snapshot write and the accepted completion are two
--       separate calls, so a crash between them leaves snapshots without a
--       job outcome, or a job outcome without snapshots.
--
--   This migration adds the missing atomic operation. It does not relax,
--   replace or edit any accepted function.
--
-- THE FENCE
--
--   The result write reuses the accepted fence. The base load runs with
--   require_context => false, which locks the parents, the watchlist and the
--   job row, and then checks, in one transaction:
--
--     1. the job exists,
--     2. the claim token matches the job's live lease,
--     3. the lease is still in the future by clock_timestamp(),
--     4. the quoted job generation is the job's current generation,
--     5. the target is still the same owned, active watchlist row.
--
--   An OFFICIAL result additionally runs the accepted fence a second time
--   with require_context => true, which is the existing, tested rule that a
--   provider result needs a bound viewer whose live credential generation,
--   login kind and permission-read state still match the captured context.
--
--   An APIFY result, and any failure outcome, may run without a viewer,
--   because a viewerless attempt has no Instagram credential and inventing
--   one would be a lie. When the job DOES carry a captured context, the same
--   require_context => true load runs for EVERY outcome, so a reconnect
--   between the capture and the write refuses the write. A context is never
--   fabricated. The lease is re-checked by the wall clock after the writes
--   and before anything is published.
--
--   The owner, the watchlist entry and the capture day are DERIVED from the
--   job row. The payload carries no owner, no watchlist id and no capture
--   day, and an attempt to carry one is refused.
--
-- THE ATOMICITY
--
--   One statement, one transaction:
--
--     1. the snapshot rows are written (profile first, then media),
--     2. the durable operation rows are recorded for the current
--        generation,
--     3. any operation of this generation that is still open is closed out
--        as 'unavailable' with the reason 'superseded_by_capture',
--     4. the watchlist row is published (status, source, last_synced_at) or
--        failed (status, last_error, next_retry_at),
--     5. the job row is completed.
--
--   If any step raises, every step is rolled back. There is no state in
--   which the watchlist says 'ok' and the snapshots are missing, and there is
--   no state in which the job says 'completed' and the watchlist is still
--   'pending'.
--
-- THE FAILURE OUTCOMES
--
--   'unavailable' is the CONFIRMED-inaccessible-target outcome. It is the
--   only outcome that sets the weekly gate: the watchlist entry gets
--   next_retry_at = now() + 7 days and status 'unavailable', and the job
--   records the same weekly due date. A transient viewer, token, scope or
--   provider failure NEVER sets that gate - it uses 'retry', which leaves
--   next_retry_at alone so the entry is attempted again.
--
--   'unavailable' and 'retry' both leave the historical snapshots and
--   last_synced_at untouched. A failed attempt never erases what was
--   captured before it.
--
-- REPLAY SAFETY
--
--   Every outcome releases the lease in the same transaction, so a second
--   call with the same claim - for example a worker whose reply was lost
--   after the commit - is refused by the fence; it never writes twice. The
--   worker does not retry a write whose outcome it could not read.
--
--   A LATER claim of the same capture day (a forced re-sync, or a retry
--   after a refused write) upserts the same rows. The snapshot rows keep
--   their FIRST captured_at on conflict, so the capture instant does not
--   drift forward, and the watchlist's last_synced_at is read back from
--   that row instead of being set to "now". The operation rows are unique
--   per (job, generation, operation key), so one generation cannot record
--   a second operation for the same capture.
--
-- GRANTS
--
--   Service role only. These functions are the write path for a worker
--   that runs under the service role, and every ownership decision is made
--   in SQL from the job row, so no browser role may call them. This stack
--   carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS, so the
--   REVOKEs are load-bearing.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. persist_competitor_collection_result
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.persist_competitor_collection_result(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint,
  p_payload        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job         public.instagram_collection_jobs%ROWTYPE;
  v_outcome     text;
  v_source      text;
  v_reason      text;
  v_error       text;
  v_item        jsonb;
  v_metrics     jsonb;
  v_key         text;
  v_media_id    text;
  v_product     text;
  v_media_type  text;
  v_thumb       text;
  v_caption     text;
  v_permalink   text;
  v_published   timestamptz;
  v_seen_ids    text[] := ARRAY[]::text[];
  v_media_count integer;
  v_written     integer := 0;
  v_captured_at timestamptz;
  v_backoff     interval;
  v_weekly      interval := interval '7 days';
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- --- The payload shape -------------------------------------------------
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'IG_COMPETITOR_RESULT_INVALID: the payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  -- The payload carries no owner, no watchlist id and no capture day: those
  -- are derived from the job row. An unexpected key is refused rather than
  -- ignored, so an attempt to steer the write is a loud failure.
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF v_key NOT IN ('outcome', 'source', 'reason_code', 'error_message',
                     'profile', 'media') THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: % is not an accepted payload key', v_key
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_outcome := lower(public.ig_collection_text(p_payload, 'outcome', 32));

  IF v_outcome IS NULL OR v_outcome NOT IN ('completed', 'unavailable', 'retry') THEN
    RAISE EXCEPTION
      'IG_COMPETITOR_RESULT_INVALID: the outcome must be completed, unavailable or retry'
      USING ERRCODE = '22023';
  END IF;

  IF v_outcome IN ('unavailable', 'retry') THEN
    v_reason := public.ig_collection_reason_code(p_payload ->> 'reason_code');

    IF v_reason IS NULL THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_REASON_REQUIRED: a failed outcome needs a reason code'
        USING ERRCODE = '22023';
    END IF;

    v_error := public.ig_collection_text(p_payload, 'error_message', 1000);

    -- 'unavailable' is the weekly "the target cannot be analysed" verdict.
    -- Only the target-confirming reason may open it; a token, scope,
    -- throttle or transport failure is about the VIEWER and must stay a
    -- retry.
    IF v_outcome = 'unavailable' AND v_reason <> 'target_unavailable' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: only target_unavailable may set the weekly unavailable outcome'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_outcome = 'completed' THEN
    v_source := lower(public.ig_collection_text(p_payload, 'source', 32));

    IF v_source IS NULL OR v_source NOT IN ('official', 'apify') THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: a completed outcome needs source official or apify'
        USING ERRCODE = '22023';
    END IF;

    -- IS DISTINCT FROM, not <>: an ABSENT key yields SQL NULL, and NULL <> x
    -- is NULL, which would let a payload with no profile through.
    IF jsonb_typeof(p_payload -> 'profile') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: a completed outcome needs a profile object'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_payload -> 'media') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: a completed outcome needs a media array'
        USING ERRCODE = '22023';
    END IF;

    v_media_count := jsonb_array_length(p_payload -> 'media');

    IF v_media_count > 30 THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_TOO_MANY_MEDIA: at most 30 media rows per capture'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- --- The base fence ----------------------------------------------------
  -- Context is not required yet: a failure with no viewer is a legitimate
  -- outcome and it must be recordable.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, false, NULL);

  IF v_job.target_kind <> 'competitor' THEN
    RAISE EXCEPTION
      'IG_COMPETITOR_RESULT_NOT_APPLICABLE: this function only completes competitor work'
      USING ERRCODE = '22023';
  END IF;

  -- --- The context rules -------------------------------------------------
  IF v_outcome = 'completed' AND v_source = 'official' THEN
    -- An official result is a Meta Business Discovery result. It needs the
    -- trusted live context: the accepted require_context rule.
    v_job := public.ig_collection_load_fenced_job(
      p_job_id, p_claim_token, p_job_generation, true, NULL);
  ELSIF v_job.context_viewer_social_account_id IS NOT NULL
     OR v_job.context_credential_generation IS NOT NULL THEN
    -- A captured context exists. It is honoured for EVERY outcome, failures
    -- included: a reconnect between the capture and this write refuses the
    -- write, exactly as the accepted result policy fences every outcome.
    -- Only a truly viewerless attempt skips it, and none is fabricated.
    v_job := public.ig_collection_load_fenced_job(
      p_job_id, p_claim_token, p_job_generation, true, NULL);
  END IF;

  -- The lease is checked again here, after the payload validation and after
  -- the parent locks were waited out inside the fence.
  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  IF v_outcome = 'completed' THEN
    -- ---------------------------------------------------------------------
    -- The capture.
    -- ---------------------------------------------------------------------
    v_metrics := COALESCE(p_payload -> 'profile' -> 'metrics', '{}'::jsonb);

    IF jsonb_typeof(v_metrics) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INVALID: the profile metrics must be an object'
        USING ERRCODE = '22023';
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(v_metrics) LOOP
      IF v_key NOT IN ('followers_count', 'media_count') THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: % is not an accepted profile metric', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    INSERT INTO public.competitor_profile_snapshots AS t (
      watchlist_id, user_id, captured_on, captured_at, capture_timezone,
      followers_count, media_count, source, status
    )
    VALUES (
      v_job.watchlist_id, v_job.user_id, v_job.captured_on, now(), 'Asia/Kuwait',
      public.ig_collection_metric_int(v_metrics, 'followers_count'),
      public.ig_collection_metric_int(v_metrics, 'media_count'),
      v_source, 'ok'
    )
    ON CONFLICT (watchlist_id, captured_on) DO UPDATE
       SET followers_count = EXCLUDED.followers_count,
           media_count     = EXCLUDED.media_count,
           source          = EXCLUDED.source,
           status          = EXCLUDED.status;

    -- The capture instant of the day. A replay keeps the FIRST one, so the
    -- freshness stamp does not drift forward on a repeated write.
    SELECT s.captured_at INTO v_captured_at
      FROM public.competitor_profile_snapshots AS s
     WHERE s.watchlist_id = v_job.watchlist_id
       AND s.captured_on = v_job.captured_on;

    PERFORM public.ig_collection_record_operation(
      p_job_id, v_job.user_id, v_job.job_generation,
      'profile', 'profile', NULL, NULL, 'success', NULL);

    v_written := 1;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload -> 'media') LOOP
      IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: every media item must be an object'
          USING ERRCODE = '22023';
      END IF;

      FOR v_key IN SELECT jsonb_object_keys(v_item) LOOP
        IF v_key NOT IN ('ig_media_id', 'media_product_type', 'media_type',
                         'thumbnail_url', 'caption', 'permalink',
                         'published_at', 'metrics') THEN
          RAISE EXCEPTION
            'IG_COMPETITOR_RESULT_INVALID: % is not an accepted media key', v_key
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

      v_media_id   := public.ig_collection_text(v_item, 'ig_media_id', 255);
      v_product    := public.ig_collection_text(v_item, 'media_product_type', 32);
      v_media_type := public.ig_collection_text(v_item, 'media_type', 32);
      v_thumb      := public.ig_collection_text(v_item, 'thumbnail_url', 2000);
      v_caption    := public.ig_collection_text(v_item, 'caption', 2000);
      v_permalink  := public.ig_collection_text(v_item, 'permalink', 2000);

      -- The publication instant. The accepted helper raises its own typed
      -- error for a value that is not a string, but a string that is not a
      -- timestamp raises a raw cast error. Both are converted into the one
      -- typed refusal of this function, so a malformed capture never
      -- surfaces a raw database error.
      BEGIN
        v_published := public.ig_collection_timestamp(v_item, 'published_at');
      EXCEPTION WHEN others THEN
        IF SQLERRM LIKE '%IG_COLLECTION_TIMESTAMP_INVALID%' THEN
          RAISE;
        END IF;
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: a media item needs a valid published_at'
          USING ERRCODE = '22023';
      END;

      IF v_media_id IS NULL OR btrim(v_media_id) = '' THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: a media item needs an ig_media_id'
          USING ERRCODE = '22023';
      END IF;

      IF v_media_id = ANY (v_seen_ids) THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_DUPLICATE_MEDIA: % appears twice in one capture', v_media_id
          USING ERRCODE = '22023';
      END IF;

      v_seen_ids := v_seen_ids || v_media_id;

      IF v_published IS NULL THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: a media item needs a published_at'
          USING ERRCODE = '22023';
      END IF;

      IF v_product IS NOT NULL AND v_product NOT IN ('FEED', 'REELS', 'STORY', 'AD') THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: % is not a known media product type', v_product
          USING ERRCODE = '22023';
      END IF;

      IF v_media_type IS NOT NULL AND v_media_type NOT IN ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM') THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: % is not a known media type', v_media_type
          USING ERRCODE = '22023';
      END IF;

      v_metrics := COALESCE(v_item -> 'metrics', '{}'::jsonb);

      IF jsonb_typeof(v_metrics) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_RESULT_INVALID: the media metrics must be an object'
          USING ERRCODE = '22023';
      END IF;

      FOR v_key IN SELECT jsonb_object_keys(v_metrics) LOOP
        IF v_key NOT IN ('like_count', 'comments_count', 'view_count') THEN
          RAISE EXCEPTION
            'IG_COMPETITOR_RESULT_INVALID: % is not an accepted media metric', v_key
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

      INSERT INTO public.competitor_media_snapshots AS t (
        watchlist_id, user_id, ig_media_id, captured_on, captured_at,
        capture_timezone, media_product_type, media_type, thumbnail_url,
        caption, permalink, published_at, like_count, comments_count,
        view_count, source, status
      )
      VALUES (
        v_job.watchlist_id, v_job.user_id, v_media_id, v_job.captured_on, now(),
        'Asia/Kuwait', v_product, v_media_type, v_thumb, v_caption, v_permalink,
        v_published,
        public.ig_collection_metric_int(v_metrics, 'like_count'),
        public.ig_collection_metric_int(v_metrics, 'comments_count'),
        public.ig_collection_metric_int(v_metrics, 'view_count'),
        v_source, 'ok'
      )
      ON CONFLICT (watchlist_id, ig_media_id, captured_on) DO UPDATE
         SET media_product_type = EXCLUDED.media_product_type,
             media_type         = EXCLUDED.media_type,
             thumbnail_url      = EXCLUDED.thumbnail_url,
             caption            = EXCLUDED.caption,
             permalink          = EXCLUDED.permalink,
             published_at       = EXCLUDED.published_at,
             like_count         = EXCLUDED.like_count,
             comments_count     = EXCLUDED.comments_count,
             view_count         = EXCLUDED.view_count,
             source             = EXCLUDED.source,
             status             = EXCLUDED.status;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'media:' || v_media_id, 'media', NULL, NULL, 'success', NULL);

      v_written := v_written + 1;
    END LOOP;

    -- Any operation of THIS generation that is still open belongs to an
    -- earlier, incomplete attempt of the same capture. The capture above is
    -- the complete one, so the stale operation is closed as unavailable
    -- rather than left open, which would make the generation look
    -- unfinished forever.
    UPDATE public.instagram_collection_job_operations AS o
       SET state        = 'unavailable',
           reason_code  = 'superseded_by_capture',
           retry_at     = NULL,
           completed_at = now(),
           updated_at   = now()
     WHERE o.job_id = p_job_id
       AND o.job_generation = v_job.job_generation
       AND o.state IN ('pending', 'failed');

    IF EXISTS (
      SELECT 1
        FROM public.instagram_collection_job_operations AS o
       WHERE o.job_id = p_job_id
         AND o.job_generation = v_job.job_generation
         AND o.state IN ('pending', 'failed')
    ) THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_RESULT_INCOMPLETE: the capture left an operation open'
        USING ERRCODE = '22023';
    END IF;

    -- The snapshot writes above can wait on row locks. The lease check
    -- before them is not the one that counts: re-read the wall clock before
    -- anything is published, so an expired worker's result rolls back
    -- instead of being accepted.
    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

    -- ---------------------------------------------------------------------
    -- The watchlist publication.
    -- ---------------------------------------------------------------------
    UPDATE public.competitor_watchlist AS w
       SET status         = 'ok',
           last_error     = NULL,
           last_error_code = NULL,
           last_synced_at = v_captured_at,
           next_retry_at  = NULL,
           source         = v_source,
           updated_at     = now()
     WHERE w.id = v_job.watchlist_id
       AND w.user_id = v_job.user_id
       AND w.is_active;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'IG_COLLECTION_TARGET_INACTIVE: the watchlist entry is no longer active'
        USING ERRCODE = '22023';
    END IF;

    -- ---------------------------------------------------------------------
    -- The job outcome.
    -- ---------------------------------------------------------------------
    UPDATE public.instagram_collection_jobs AS j
       SET status           = 'completed',
           last_success_at   = now(),
           last_attempt_at   = now(),
           last_reason_code  = NULL,
           retry_at          = NULL,
           lease_token       = NULL,
           lease_expires_at  = NULL,
           updated_at        = now()
     WHERE j.id = p_job_id;

    RETURN jsonb_build_object(
      'job_id', p_job_id,
      'job_generation', v_job.job_generation,
      'outcome', 'completed',
      'source', v_source,
      'watchlist_id', v_job.watchlist_id,
      'captured_on', v_job.captured_on,
      'written', v_written,
      'media_count', v_media_count,
      'captured_at', v_captured_at
    );
  END IF;

  -- -----------------------------------------------------------------------
  -- The failure outcomes.
  --
  -- No snapshot is written, no captured_at moves and last_synced_at is not
  -- touched. The historical capture stays exactly as it was.
  -- -----------------------------------------------------------------------
  PERFORM public.ig_collection_record_operation(
    p_job_id, v_job.user_id, v_job.job_generation,
    'profile', 'profile', NULL, NULL, 'failed', v_reason);

  -- The same post-write wall-clock check as the capture path.
  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  IF v_outcome = 'unavailable' THEN
    -- The confirmed-inaccessible-target outcome. This is the ONLY outcome
    -- that sets the weekly gate.
    UPDATE public.competitor_watchlist AS w
       SET status         = 'unavailable',
           last_error     = left(COALESCE(v_error, v_reason), 1000),
           last_error_code = v_reason,
           next_retry_at  = now() + v_weekly,
           updated_at     = now()
     WHERE w.id = v_job.watchlist_id
       AND w.user_id = v_job.user_id
       AND w.is_active;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'IG_COLLECTION_TARGET_INACTIVE: the watchlist entry is no longer active'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.instagram_collection_jobs AS j
       SET status          = 'unavailable',
           due_at          = now() + v_weekly,
           retry_at        = now() + v_weekly,
           last_reason_code = v_reason,
           last_attempt_at = now(),
           lease_token     = NULL,
           lease_expires_at = NULL,
           updated_at      = now()
     WHERE j.id = p_job_id;

    RETURN jsonb_build_object(
      'job_id', p_job_id,
      'job_generation', v_job.job_generation,
      'outcome', 'unavailable',
      'reason_code', v_reason,
      'watchlist_id', v_job.watchlist_id,
      'next_retry_at', now() + v_weekly
    );
  END IF;

  -- 'retry': a transient failure. The entry stays eligible for the next
  -- attempt; the weekly gate is deliberately NOT set.
  v_backoff := public.ig_collection_backoff_interval(v_job.attempts)
               + make_interval(secs => (random() * 60)::integer);

  UPDATE public.competitor_watchlist AS w
     SET status         = 'error',
         last_error     = left(COALESCE(v_error, v_reason), 1000),
         last_error_code = v_reason,
         next_retry_at  = NULL,
         updated_at     = now()
   WHERE w.id = v_job.watchlist_id
     AND w.user_id = v_job.user_id
     AND w.is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_INACTIVE: the watchlist entry is no longer active'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.instagram_collection_jobs AS j
     SET status          = 'retry',
         due_at          = now() + v_backoff,
         retry_at        = now() + v_backoff,
         last_reason_code = v_reason,
         last_attempt_at = now(),
         lease_token     = NULL,
         lease_expires_at = NULL,
         updated_at      = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'outcome', 'retry',
    'reason_code', v_reason,
    'watchlist_id', v_job.watchlist_id,
    'next_retry_at', now() + v_backoff
  );
END;
$function$;

COMMENT ON FUNCTION public.persist_competitor_collection_result(uuid, uuid, bigint, jsonb) IS
  'The atomic competitor result write. Derives the owner, the watchlist entry '
  'and the capture day from the job row, writes at most one profile and '
  'thirty distinct media snapshots with a verified source, records the '
  'durable operation rows, publishes the watchlist status (ok / unavailable '
  'with the weekly gate / error) and completes the job - all in one '
  'transaction. An official result requires the trusted live viewer context; '
  'an apify result may run without one but never fabricates one. A failure '
  'leaves the historical snapshots and last_synced_at untouched.';

-- ===========================================================================
-- 2. list_due_competitor_collection_targets
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.list_due_competitor_collection_targets(
  p_limit        integer DEFAULT 50,
  p_after_due_at timestamptz DEFAULT NULL,
  p_after_id     uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_limit integer;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF (p_after_due_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION
      'IG_COMPETITOR_CURSOR_INVALID: the cursor needs both a due date and an id, or neither'
      USING ERRCODE = '22023';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 0), 1), 50);

  RETURN QUERY
  SELECT jsonb_build_object(
    'user_id', w.user_id,
    'watchlist_id', w.id,
    'username', w.username,
    'due_at', COALESCE(w.next_retry_at, w.created_at)
  )
    FROM public.competitor_watchlist AS w
   WHERE w.is_active
     AND (w.next_retry_at IS NULL OR w.next_retry_at <= now())
     AND (
       p_after_due_at IS NULL
       OR (COALESCE(w.next_retry_at, w.created_at), w.id) > (p_after_due_at, p_after_id)
     )
   ORDER BY COALESCE(w.next_retry_at, w.created_at) ASC, w.id ASC
   LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.list_due_competitor_collection_targets(integer, timestamptz, uuid) IS
  'The bounded, ordered, cursor-paged read of the watchlist entries that are '
  'due for a collection attempt. An entry is due when it is active and it '
  'has no weekly gate, or its weekly gate has passed. The ordering is by the '
  'due instant and then the id, so a cursor walks the whole list instead of '
  'always returning the same first page. The caller passes the last row it '
  'processed as the next cursor.';

-- The ordering expression is the same one the read uses, so the page walk
-- is index-backed instead of a sort over the whole table.
CREATE INDEX IF NOT EXISTS idx_competitor_watchlist_collection_due
  ON public.competitor_watchlist (COALESCE(next_retry_at, created_at), id)
  WHERE is_active;

COMMENT ON INDEX public.idx_competitor_watchlist_collection_due IS
  'Supports the ordered, cursor-paged due-watchlist read used by the '
  'scheduled competitor enqueue.';

-- ===========================================================================
-- 3. Grants.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.persist_competitor_collection_result(uuid, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_due_competitor_collection_targets(integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_competitor_collection_result(uuid, uuid, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_competitor_collection_targets(integer, timestamptz, uuid) TO service_role;

COMMIT;
