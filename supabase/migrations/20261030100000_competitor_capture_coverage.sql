-- ===========================================================================
-- Task 8 / M1 - competitor capture coverage.
--
-- Plan: docs/plans/2026-10-30-competitor-ui-and-retention.md
--   Task 1 ("Persist competitor capture coverage without changing provider
--   budgets") and the migration inventory row M1.
--
-- Spec: docs/specs/2026-10-30-competitor-ui-and-retention.md
--   §4 "Actual storage" and §6 "Weekly inventory".
--
-- APPLY AS supabase_admin. It owns the function below; postgres is not a
-- superuser on this stack and a REVOKE by a non-owner is a WARNING that
-- changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   Two additive objects:
--
--     1. public.competitor_capture_coverage
--        - one row per (watchlist entry, capture day). It records WHAT THE
--          CAPTURE ACTUALLY SAW of the target's feed: how far the walk got,
--          whether it reached the end, whether the returned rows were
--          ordered by a verified contract, and why it stopped early.
--
--     2. public.persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)
--        - the atomic result write, version 2. It keeps the v1 signature and
--          the v1 fence, adds the coverage evidence to a successful payload
--          and writes the profile snapshot, the media snapshots AND the
--          coverage row in ONE transaction.
--
-- WHY THE COVERAGE IS NEEDED AT ALL
--
--   A successful capture is NOT evidence of a complete weekly inventory.
--   The v1 writer records what was fetched and drops the provider's
--   `truncated` flag on the floor, so a capture that stopped at the thirty
--   row cap is indistinguishable from one that read the whole feed.
--
--   The reporting rules need the difference:
--
--     * Thirty lifetime posts of which three fall in the week CAN establish
--       the week, because the oldest returned timestamp reaches the start of
--       the window AND the ordering is verified.
--     * Thirty posts ALL inside the week with more possible posts is a
--       partial window.
--     * A cursor older than the window does not by itself invalidate the
--       window.
--
--   None of that can be decided from the snapshots alone, so the evidence
--   has to be stored next to them.
--
-- WHAT IS NOT IN THIS TABLE
--
--   No provider cursor URL, no credential, no profile identity field and no
--   provider text. The row is evidence about a feed, not a copy of the
--   provider's answer.
--
-- NEVER BACKFILLED
--
--   There is no backfill here and there must never be one. A snapshot that
--   was captured before this table existed has NO coverage row, and the
--   absence means UNKNOWN, not "complete" and not "empty". A fabricated
--   coverage row would be a lie about a capture nobody observed.
--
-- THE VERSIONED WRITER
--
--   v1 (persist_competitor_collection_result) stays callable and unchanged.
--   v2 is a SEPARATE function, not a replaced one, so a deployment that
--   still runs the old worker keeps working while the new one is rolled
--   out. The two write the same snapshots; only v2 writes coverage.
--
--   A v2 payload for a successful capture REQUIRES the coverage object. A
--   v1 payload without coverage is refused by v2 rather than accepted with
--   an invented "unknown" coverage, because a successful capture always
--   produced evidence and the absence of it is a broken caller, not a
--   capture without evidence.
--
--   The v2 receipt carries a `version` key. The store refuses a receipt
--   whose version is not 2, so a v1 receipt can never be read as a v2
--   success.
--
-- THE FENCE
--
--   v2 reuses the accepted fence exactly as v1 does: the same
--   ig_collection_load_fenced_job, the same parent->job lock order (the
--   accounts, then the watchlist, then the job row), the same lease
--   re-checks and the same viewer-context rules. The prior freshness is
--   read AFTER that fence, so a write can never observe or overwrite a
--   prior state it has not locked.
--
-- BOUNDED COMPLETION IS NOT FULL INVENTORY
--
--   A capture that hit a cap still FINISHES its bounded job. It is not
--   left in 'partial', because 'partial' is a claimable status: the job
--   would be re-claimed immediately and the same impossible-to-expand
--   window would be retried forever. Instead the job completes, its
--   last_partial_at advances and its last_success_at is PRESERVED: the
--   prior full-success time is the truthful answer to "when was the
--   inventory last complete", and a capped capture does not move it.
--
--   The two facts are independent, and the coverage row keeps them apart:
--   `exhausted` says the walk reached the end of the feed, and
--   `ordering_verified` says the provider's order is a tested contract.
--   A complete inventory with an unverified order is a complete inventory.
--
-- GRANTS
--
--   Service role only, exactly like v1. Every ownership decision is made in
--   SQL from the job row, so no browser role may call the writer. The
--   coverage table is owner-READABLE (SELECT on their own rows) and
--   service-WRITABLE, like the two snapshot tables it sits beside.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. competitor_capture_coverage
-- ===========================================================================
--
-- One row per (watchlist entry, capture day).
--
-- The identity is the watched entry and the day, not the job: a forced
-- re-collection of the same day is the SAME day's coverage, and it
-- replaces the earlier evidence. The generation is carried on the row so a
-- later capture can be told from an earlier one.
--

CREATE TABLE public.competitor_capture_coverage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id       uuid NOT NULL,
  user_id            uuid NOT NULL,
  captured_on        date NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL,
  job_generation     bigint NOT NULL,
  capture_started_at timestamptz NOT NULL,
  capture_ended_at   timestamptz NOT NULL,
  -- The oldest publication instant the capture actually returned. It is
  -- NULL for a genuinely empty feed and never a substitute instant.
  oldest_returned_at timestamptz,
  -- Whether the provider's row order is a tested, version-compatible
  -- contract. It is FALSE by default and stays false until such a contract
  -- exists: a sorted array is not a verified order.
  ordering_verified  boolean NOT NULL DEFAULT false,
  -- Whether there was MORE to fetch: the provider offered a next page in
  -- its last response. NULL when the provider has no such notion.
  cursor_present     boolean,
  -- Whether the walk reached the end of the feed.
  exhausted          boolean NOT NULL,
  -- Whether the media window was capped.
  truncated          boolean NOT NULL,
  -- Why the walk stopped early. A closed, bounded set of codes.
  gap_reason         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- The ownership binding. A coverage row cannot name a watchlist entry
  -- owned by somebody else.
  CONSTRAINT competitor_capture_coverage_owner_fkey
    FOREIGN KEY (watchlist_id, user_id)
    REFERENCES public.competitor_watchlist (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT competitor_capture_coverage_capture_key
    UNIQUE (watchlist_id, captured_on),

  CONSTRAINT competitor_capture_coverage_source_chk
    CHECK (source IN ('official', 'apify')),

  CONSTRAINT competitor_capture_coverage_generation_chk
    CHECK (job_generation >= 1),

  -- The capture window is a window: it cannot end before it started.
  CONSTRAINT competitor_capture_coverage_window_chk
    CHECK (capture_started_at <= capture_ended_at),

  -- Every instant is finite. 'infinity' is a valid timestamptz literal and
  -- is not evidence of anything.
  CONSTRAINT competitor_capture_coverage_finite_chk
    CHECK (
      isfinite(captured_at)
      AND isfinite(capture_started_at)
      AND isfinite(capture_ended_at)
      AND (oldest_returned_at IS NULL OR isfinite(oldest_returned_at))
    ),

  -- The gap reason is a closed set of lower-case codes. A free-text reason
  -- would eventually carry provider text.
  CONSTRAINT competitor_capture_coverage_gap_reason_chk
    CHECK (gap_reason IS NULL OR gap_reason IN (
      'media_cap_reached',
      'page_cap_reached',
      'cursor_unusable',
      'cursor_loop',
      'duplicate_media',
      'usage_budget_stop'
    )),

  -- An exhausted walk has no gap, and an incomplete walk names one. The
  -- booleans are explicit: "complete" is never a default.
  CONSTRAINT competitor_capture_coverage_gap_consistency_chk
    CHECK ((gap_reason IS NULL) = exhausted),

  -- A capped capture always says why it was capped.
  CONSTRAINT competitor_capture_coverage_truncation_consistency_chk
    CHECK (NOT truncated OR gap_reason IS NOT NULL)
);

CREATE INDEX idx_competitor_capture_coverage_owner_captured
  ON public.competitor_capture_coverage (user_id, captured_on DESC);
CREATE INDEX idx_competitor_capture_coverage_watchlist_captured
  ON public.competitor_capture_coverage (watchlist_id, captured_on DESC);

COMMENT ON TABLE public.competitor_capture_coverage IS
  'What one capture actually saw of a tracked competitor''s feed: how far '
  'the walk got, whether it reached the end, whether the returned order is a '
  'verified provider contract, and why it stopped early. One row per '
  '(watchlist entry, capture day). Service-write-only; the owner may SELECT '
  'their own rows. Absence means UNKNOWN: coverage is never backfilled for a '
  'capture that happened before this table existed.';
COMMENT ON COLUMN public.competitor_capture_coverage.ordering_verified IS
  'TRUE only when the provider''s row order is a tested, version-compatible '
  'contract. It defaults to FALSE: a sorted array is not a verified order, '
  'and no such contract has been established for this provider yet.';
COMMENT ON COLUMN public.competitor_capture_coverage.exhausted IS
  'TRUE when the walk reached the end of the provider''s feed. FALSE with a '
  'gap_reason when it stopped early.';
COMMENT ON COLUMN public.competitor_capture_coverage.oldest_returned_at IS
  'The oldest publication instant the capture returned. NULL for a '
  'genuinely empty feed.';

CREATE TRIGGER update_competitor_capture_coverage_updated_at
  BEFORE UPDATE ON public.competitor_capture_coverage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 2. RLS and grants.
-- ===========================================================================
--
-- House convention: RLS on, an explicit owner-read policy and explicit
-- grants that do not depend on environment-specific default privileges.
-- This stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
-- anon, authenticated and service_role, so the REVOKEs are load-bearing.
-- ===========================================================================

ALTER TABLE public.competitor_capture_coverage ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE
  v_saved_search_path text;
  v_owner_qual       text;
BEGIN
  -- CREATE POLICY has no IF NOT EXISTS. A missing policy is created. A
  -- policy of this name whose command, role or predicate differs is a hard
  -- error: skipping it would hide a drifted owner-read rule.
  IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'competitor_capture_coverage'
           AND policyname = 'Owners can read their own rows'
      ) THEN
    CREATE POLICY "Owners can read their own rows"
      ON public.competitor_capture_coverage
      FOR SELECT TO authenticated
      USING (auth.uid() = user_id);
  ELSE
    -- pg_get_expr schema-qualifies auth.uid() only when auth is NOT on
    -- the search_path, and this stack's path includes auth: the same
    -- predicate prints (uid() = user_id) there. The predicate is therefore
    -- read under pg_catalog, where the qualification is stable.
    v_saved_search_path := current_setting('search_path');
    BEGIN
      PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
      SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid)
        INTO v_owner_qual
        FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'competitor_capture_coverage'
         AND p.polname = 'Owners can read their own rows';
      PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('search_path', v_saved_search_path, true);
      RAISE;
    END;

    IF v_owner_qual IS DISTINCT FROM '(auth.uid() = user_id)'
       OR (SELECT cmd FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'competitor_capture_coverage'
              AND policyname = 'Owners can read their own rows') IS DISTINCT FROM 'SELECT'
       OR (SELECT roles FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'competitor_capture_coverage'
              AND policyname = 'Owners can read their own rows') IS DISTINCT FROM '{authenticated}'::name[]
       OR (SELECT permissive FROM pg_catalog.pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'competitor_capture_coverage'
              AND policyname = 'Owners can read their own rows') IS DISTINCT FROM 'PERMISSIVE'::boolean THEN
      RAISE EXCEPTION
        'policy "Owners can read their own rows" on competitor_capture_coverage does not match the owner-read contract (qual = %)',
        coalesce(v_owner_qual, '<null>');
    END IF;
  END IF;
END
$policies$;

REVOKE ALL ON public.competitor_capture_coverage FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.competitor_capture_coverage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitor_capture_coverage TO service_role;

-- ===========================================================================
-- 3. persist_competitor_collection_result_v2
-- ===========================================================================
--
-- The atomic result write, version 2.
--
-- It is v1 plus the coverage evidence:
--
--   1. the same fence, the same lock order and the same lease re-checks,
--   2. the same profile snapshot and the same media snapshots,
--   3. the coverage row, written in the SAME transaction,
--   4. a versioned receipt the store can tell apart from a v1 receipt.
--
-- The differences that matter:
--
--   * a successful payload REQUIRES a coverage object,
--   * a failed payload MUST NOT carry one (a failed attempt observed no
--     inventory, and a coverage row for it would be a lie),
--   * the job's last_success_at advances only for a complete inventory, and
--     last_partial_at advances for an incomplete one,
--   * the coverage row of an OLDER generation never replaces a newer one.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.persist_competitor_collection_result_v2(
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

  -- The coverage evidence.
  v_coverage            jsonb;
  v_started             timestamptz;
  v_ended               timestamptz;
  v_oldest              timestamptz;
  v_ordering            boolean;
  v_cursor_present      boolean;
  v_exhausted           boolean;
  v_truncated           boolean;
  v_gap                 text;
  v_inventory_complete  boolean;
  v_coverage_captured_at timestamptz;
  v_coverage_generation bigint;

  v_backoff    interval;
  v_weekly     interval := interval '7 days';
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
                     'profile', 'media', 'coverage') THEN
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

    -- A failed attempt observed no inventory. A coverage row for it would
    -- claim an inventory walk that never happened.
    IF p_payload ? 'coverage' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: a failed outcome carries no coverage'
        USING ERRCODE = '22023';
    END IF;

    v_error := public.ig_collection_text(p_payload, 'error_message', 1000);

    -- 'unavailable' is the weekly "the target cannot be analysed" verdict.
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

    -- ---------------------------------------------------------------------
    -- The coverage evidence.
    --
    -- It is REQUIRED for a successful capture. A successful capture always
    -- produced evidence, so a payload without it is a broken caller, not a
    -- capture without evidence.
    -- ---------------------------------------------------------------------
    IF jsonb_typeof(p_payload -> 'coverage') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: a completed outcome needs a coverage object'
        USING ERRCODE = '22023';
    END IF;

    v_coverage := p_payload -> 'coverage';

    FOR v_key IN SELECT jsonb_object_keys(v_coverage) LOOP
      IF v_key NOT IN ('capture_started_at', 'capture_ended_at',
                       'oldest_returned_at', 'ordering_verified',
                       'cursor_present', 'exhausted', 'truncated',
                       'gap_reason') THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_COVERAGE_INVALID: % is not an accepted coverage key', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    FOREACH v_key IN ARRAY ARRAY[
      'capture_started_at', 'capture_ended_at',
      'ordering_verified', 'exhausted', 'truncated'
    ] LOOP
      IF NOT (v_coverage ? v_key) THEN
        RAISE EXCEPTION
          'IG_COMPETITOR_COVERAGE_INVALID: the coverage needs %', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    -- The instants. A string that is not a timestamp raises a raw cast
    -- error, which is converted into the one typed refusal of this
    -- function, so a malformed capture never surfaces a raw database error.
    BEGIN
      v_started := public.ig_collection_timestamp(v_coverage, 'capture_started_at');
      v_ended   := public.ig_collection_timestamp(v_coverage, 'capture_ended_at');
      v_oldest  := public.ig_collection_timestamp(v_coverage, 'oldest_returned_at');
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE '%IG_COLLECTION_TIMESTAMP_INVALID%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: the coverage instants are not usable'
        USING ERRCODE = '22023';
    END;

    IF v_started IS NULL OR v_ended IS NULL THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: the coverage needs a capture start and an end instant'
        USING ERRCODE = '22023';
    END IF;

    IF v_started > v_ended THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: the capture cannot end before it started'
        USING ERRCODE = '22023';
    END IF;

    -- The explicit booleans.
    IF jsonb_typeof(v_coverage -> 'ordering_verified') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: ordering_verified must be a boolean'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_coverage -> 'exhausted') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: exhausted must be a boolean'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_coverage -> 'truncated') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: truncated must be a boolean'
        USING ERRCODE = '22023';
    END IF;

    v_ordering  := (v_coverage ->> 'ordering_verified')::boolean;
    v_exhausted := (v_coverage ->> 'exhausted')::boolean;
    v_truncated := (v_coverage ->> 'truncated')::boolean;

    -- The cursor flag is nullable: "the provider offered a next page" is
    -- unknown for some providers, and unknown is not false.
    IF jsonb_typeof(v_coverage -> 'cursor_present') IS NOT NULL
       AND jsonb_typeof(v_coverage -> 'cursor_present') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: cursor_present must be a boolean or null'
        USING ERRCODE = '22023';
    END IF;

    v_cursor_present := (v_coverage ->> 'cursor_present')::boolean;

    -- The gap reason: a closed set of lower-case codes.
    v_gap := public.ig_collection_reason_code(v_coverage ->> 'gap_reason');

    IF v_gap IS NOT NULL
       AND v_gap NOT IN ('media_cap_reached', 'page_cap_reached', 'cursor_unusable',
                         'cursor_loop', 'duplicate_media', 'usage_budget_stop') THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: % is not a known gap reason', v_gap
        USING ERRCODE = '22023';
    END IF;

    -- An exhausted walk has no gap; an incomplete walk names one.
    IF (v_gap IS NULL) <> v_exhausted THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: an exhausted capture has no gap and an incomplete capture names one'
        USING ERRCODE = '22023';
    END IF;

    -- A capped capture always says why it was capped.
    IF v_truncated AND v_gap IS NULL THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_INVALID: a truncated capture names its gap'
        USING ERRCODE = '22023';
    END IF;

    -- The derived verdict. A complete inventory is an exhausted walk that
    -- was not capped. The VERIFIED ORDER is a separate fact and is not
    -- part of this verdict: a complete set of posts with an unverified
    -- order is still a complete set of posts.
    v_inventory_complete := v_exhausted AND NOT v_truncated AND v_gap IS NULL;
  END IF;

  -- --- The base fence ----------------------------------------------------
  -- Context is not required yet: a failure with no viewer is a legitimate
  -- outcome and it must be recordable.
  --
  -- The fence locks the parents (the accounts, then the watchlist) and then
  -- the job row, in that order. Everything below - including the read of
  -- the prior freshness - happens AFTER it, so a write can never observe or
  -- overwrite a prior state it has not locked.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, false, NULL);

  IF v_job.target_kind <> 'competitor' THEN
    RAISE EXCEPTION
      'IG_COMPETITOR_RESULT_NOT_APPLICABLE: this function only completes competitor work'
      USING ERRCODE = '22023';
  END IF;

  -- --- The context rules -------------------------------------------------
  IF v_outcome = 'completed' AND v_source = 'official' THEN
    v_job := public.ig_collection_load_fenced_job(
      p_job_id, p_claim_token, p_job_generation, true, NULL);
  ELSIF v_job.context_viewer_social_account_id IS NOT NULL
     OR v_job.context_credential_generation IS NOT NULL THEN
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

    -- ---------------------------------------------------------------------
    -- The coverage row.
    --
    -- It is written in the same transaction as the snapshots, so a capture
    -- can never have observations without evidence or evidence without
    -- observations.
    --
    -- The upsert replaces the evidence of the SAME day, but only from a
    -- generation that is not older than the one already stored: a forced
    -- re-collection supersedes the earlier evidence of that day, and a
    -- stale worker can never overwrite a newer one.
    -- ---------------------------------------------------------------------
    INSERT INTO public.competitor_capture_coverage AS t (
      watchlist_id, user_id, captured_on, captured_at, source, job_generation,
      capture_started_at, capture_ended_at, oldest_returned_at,
      ordering_verified, cursor_present, exhausted, truncated, gap_reason
    )
    VALUES (
      v_job.watchlist_id, v_job.user_id, v_job.captured_on, now(), v_source,
      v_job.job_generation, v_started, v_ended, v_oldest,
      v_ordering, v_cursor_present, v_exhausted, v_truncated, v_gap
    )
    ON CONFLICT (watchlist_id, captured_on) DO UPDATE
       SET source             = EXCLUDED.source,
           job_generation     = EXCLUDED.job_generation,
           capture_started_at = EXCLUDED.capture_started_at,
           capture_ended_at   = EXCLUDED.capture_ended_at,
           oldest_returned_at = EXCLUDED.oldest_returned_at,
           ordering_verified  = EXCLUDED.ordering_verified,
           cursor_present     = EXCLUDED.cursor_present,
           exhausted          = EXCLUDED.exhausted,
           truncated          = EXCLUDED.truncated,
           gap_reason         = EXCLUDED.gap_reason,
           updated_at         = now()
     WHERE t.job_generation <= EXCLUDED.job_generation;

    -- The stored coverage, read back under the same locks. The receipt
    -- reports what was STORED, not what was submitted.
    SELECT c.captured_at, c.job_generation
      INTO v_coverage_captured_at, v_coverage_generation
      FROM public.competitor_capture_coverage AS c
     WHERE c.watchlist_id = v_job.watchlist_id
       AND c.captured_on = v_job.captured_on;

    IF v_coverage_captured_at IS NULL THEN
      RAISE EXCEPTION
        'IG_COMPETITOR_COVERAGE_MISSING: the capture stored no coverage'
        USING ERRCODE = '22023';
    END IF;

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
    --
    -- The job COMPLETES: the bounded work finished. What it does NOT do is
    -- claim a complete inventory. A capped capture advances last_partial_at
    -- and PRESERVES the prior last_success_at, because the prior full
    -- success is the truthful answer to "when was the inventory last
    -- complete".
    --
    -- The job is deliberately not left in 'partial': that status is
    -- claimable, so the same impossible-to-expand window would be retried
    -- forever. The future collection cadence is what re-collects.
    -- ---------------------------------------------------------------------
    UPDATE public.instagram_collection_jobs AS j
       SET status           = 'completed',
           last_success_at   = CASE WHEN v_inventory_complete THEN now() ELSE j.last_success_at END,
           last_partial_at   = CASE WHEN v_inventory_complete THEN j.last_partial_at ELSE now() END,
           last_attempt_at   = now(),
           last_reason_code  = NULL,
           retry_at          = NULL,
           lease_token       = NULL,
           lease_expires_at  = NULL,
           updated_at        = now()
     WHERE j.id = p_job_id;

    RETURN jsonb_build_object(
      'version', 2,
      'job_id', p_job_id,
      'job_generation', v_job.job_generation,
      'outcome', 'completed',
      'source', v_source,
      'watchlist_id', v_job.watchlist_id,
      'captured_on', v_job.captured_on,
      'written', v_written,
      'media_count', v_media_count,
      'captured_at', to_char(v_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'coverage', jsonb_build_object(
        'watchlist_id', v_job.watchlist_id,
        'user_id', v_job.user_id,
        'captured_on', v_job.captured_on,
        'captured_at', to_char(v_coverage_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'source', v_source,
        'job_generation', v_coverage_generation,
        -- The instants are rendered in ONE canonical UTC form.
        --
        -- The default timestamptz output depends on the session's DateStyle
        -- and TimeZone, so the same stored instant can print three
        -- different strings. The caller compares these against what it
        -- submitted, and a receipt that prints in a shape the caller
        -- cannot parse would be a false failure. The canonical form is
        -- ISO-8601 in UTC with millisecond precision, which is exactly what
        -- the collector submits.
        'capture_started_at', to_char(v_started AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'capture_ended_at', to_char(v_ended AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'oldest_returned_at', CASE WHEN v_oldest IS NULL THEN NULL
          ELSE to_char(v_oldest AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'ordering_verified', v_ordering,
        'cursor_present', v_cursor_present,
        'exhausted', v_exhausted,
        'truncated', v_truncated,
        'gap_reason', v_gap,
        'inventory_complete', v_inventory_complete)
    );
  END IF;

  -- -----------------------------------------------------------------------
  -- The failure outcomes.
  --
  -- No snapshot is written, no coverage is written, no captured_at moves
  -- and last_synced_at is not touched. The historical capture stays exactly
  -- as it was.
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
      'version', 2,
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
    'version', 2,
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'outcome', 'retry',
    'reason_code', v_reason,
    'watchlist_id', v_job.watchlist_id,
    'next_retry_at', now() + v_backoff
  );
END;
$function$;

COMMENT ON FUNCTION public.persist_competitor_collection_result_v2(uuid, uuid, bigint, jsonb) IS
  'The atomic competitor result write, version 2. Same fence, same lock '
  'order and same lease rules as v1, plus the coverage evidence: a '
  'successful payload REQUIRES a coverage object and the profile snapshot, '
  'the media snapshots and the coverage row commit together. The receipt '
  'carries version = 2 so it can never be confused with a v1 receipt. A '
  'capped capture completes its bounded job, advances last_partial_at and '
  'PRESERVES the prior last_success_at: bounded completion is not full '
  'inventory. The v1 writer stays callable and unchanged.';

-- ===========================================================================
-- 4. Grants.
-- ===========================================================================
--
-- Service role only. These functions are the write path for a worker that
-- runs under the service role, and every ownership decision is made in SQL
-- from the job row, so no browser role may call them. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS, so the REVOKEs are
-- load-bearing.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.persist_competitor_collection_result_v2(uuid, uuid, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_competitor_collection_result_v2(uuid, uuid, bigint, jsonb)
  TO service_role;

COMMIT;
