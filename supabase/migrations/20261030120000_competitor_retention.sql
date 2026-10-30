-- ===========================================================================
-- Task 8 / M3 - bounded inactive-history cleanup for tracked competitors.
--
-- Plan: docs/plans/2026-10-30-competitor-ui-and-retention.md
--   Task 7 ("Add bounded inactive-history cleanup primitive") and the
--   migration inventory row M3.
--
-- Spec: docs/specs/2026-10-30-competitor-ui-and-retention.md
--   §7 "Retention and concurrency contract" and the acceptance map rows
--   T8-08 / T8-09.
--
-- APPLY AS supabase_admin. It owns the function below; a REVOKE by a
-- non-owner is a WARNING that changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   One additive index and one service-only function:
--
--     1. idx_competitor_watchlist_retention_eligible
--        - the inactive rows that carry a removal marker, ordered by
--          (removed_at, id). The active list is never a cleanup candidate
--          and is not in this index.
--
--     2. public.run_competitor_retention_batch(integer,integer,boolean)
--        - one BOUNDED slice of the cleanup. It deletes the history of
--          competitors that have been removed for at least 90 elapsed days,
--          child rows first, and it stops at a caller-supplied ceiling.
--
-- WHAT IT IS NOT
--
--   * It is NOT a scheduler. No cron job is created here; that is M4 and it
--     is installed inactive.
--   * It is NOT an owner path. An owner never physically deletes a tracked
--     competitor: the remove/reactivate RPCs stay exactly as they are, and
--     the 90-day promise is made by them, not by this function.
--   * It is NOT enabled. The switch below defaults to false, and the
--     function refuses to mutate anything while it is off, missing or
--     malformed. Bypassing the Edge wrapper cannot enable cleanup.
--
-- THE ELIGIBILITY PREDICATE
--
--   is_active = false
--   AND removed_at IS NOT NULL
--   AND removed_at <= server_now - interval '2160 hours'
--
--   2160 hours is 90 elapsed days. Exactly 90 days is eligible; 89 days
--   and 90 days minus one microsecond are not. The clock is the SERVER's
--   now(): there is no owner argument, no cutoff argument and no time
--   argument, so a caller cannot move the boundary. Eligibility is not a
--   promise of deletion at an exact second - it is the predicate the
--   cleanup runs on.
--
--   The removal marker is the clock. A repeated remove or a label edit does
--   not move it (the watchlist guard trigger preserves it), a reactivation
--   clears it, and a later removal starts a new clock.
--
-- THE BOUNDED DELETION PROTOCOL
--
--   1. The candidates are chosen in (removed_at, id) order and the parent
--      rows are locked FOR UPDATE SKIP LOCKED. Every child is then deleted
--      against the OWNER that the locked parent carries - there is no
--      owner parameter to get wrong.
--   2. The lock order is parent, then job - the same order the collection
--      fence uses (accounts, watchlist, job). A collector therefore cannot
--      deadlock with the cleanup, and a cleanup that holds the parent lock
--      makes a concurrent claim skip the target (NOWAIT) instead of
--      blocking.
--   3. A parent with a LIVE job lease is skipped. An EXPIRED lease confers
--      no write authority, so the abandoned work is deleted with the rest.
--   4. The children go first, in bounded chunks: media snapshots, profile
--      snapshots, coverage rows, job operations, job checkpoints, the jobs
--      themselves, and the per-target request throttle rows. The shared
--      provider throttle buckets are never touched: they are shared state
--      and not the property of one tracked competitor.
--   5. The parent is deleted ONLY after every child relation is empty for
--      that parent. The existing ON DELETE CASCADE foreign keys stay in
--      place as a safety backstop, but they are never the mechanism: a
--      cascade-bearing delete does not run while children remain.
--   6. The final parent delete repeats the owner, inactivity, unchanged
--      marker and cutoff predicates in the same transaction. No batch
--      continues from a stale removal marker.
--
-- THE SWITCH
--
--   public.app_settings['competitor_retention_enabled'] is the master
--   switch, and it is SERVER-CONTROLLED: it is a row an administrator
--   maintains, not a caller argument. The value is a JSON boolean:
--
--     true      -> cleanup may mutate
--     false     -> no mutation
--     missing   -> no mutation (the row is not there)
--     malformed -> no mutation (the value is not a JSON boolean)
--
--   A missing or malformed switch FAILS CLOSED, and the report says which
--   state it was in, so an unreadable switch is loud rather than silent.
--   A dry run stays available while the switch is off: a preview mutates
--   nothing either way.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The eligibility index.
-- ===========================================================================
--
-- The cleanup reads candidates in (removed_at, id) order and never scans
-- the active list. A partial index over the INACTIVE rows only keeps the
-- index small: the active list is the hot one and it is not a candidate.
--
CREATE INDEX idx_competitor_watchlist_retention_eligible
  ON public.competitor_watchlist (removed_at, id)
  WHERE is_active = false AND removed_at IS NOT NULL;

COMMENT ON INDEX public.idx_competitor_watchlist_retention_eligible IS
  'Cleanup candidates only: the inactive watchlist rows that carry a removal '
  'marker, ordered by (removed_at, id). An active row is never a cleanup '
  'candidate and is not in this index.';

-- ===========================================================================
-- 2. The switch.
-- ===========================================================================
--
-- Default OFF. The row is inserted once; an administrator turns the
-- cleanup on by setting the value to true, and only after the migration has
-- been verified and the retention function has booted.
--
INSERT INTO public.app_settings (key, value, description)
VALUES
  ('competitor_retention_enabled', 'false'::jsonb,
   'Master switch for the competitor retention cleanup. false = no cleanup. '
   || 'Set to true only after the M3 migration is verified and the retention '
   || 'function is deployed and booted. Missing or malformed = no cleanup.')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- 3. The bounded batch.
-- ===========================================================================
--
-- One slice of the cleanup. The caller (the retention Edge function, Task 8)
-- decides how many slices to run inside its own time budget; this
-- function's job is to be bounded and idempotent, not to be the scheduler.
--
CREATE OR REPLACE FUNCTION public.run_competitor_retention_batch(
  p_parent_limit integer,
  p_child_limit  integer,
  p_dry_run       boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  -- The server clock. now() is the transaction time, so every row of one
  -- slice is measured against the same instant. There is no caller-supplied
  -- time anywhere in this function.
  v_now    timestamptz := now();
  v_cutoff timestamptz;

  -- The switch.
  v_switch  text;
  v_setting jsonb;

  -- The candidate parents, in (removed_at, id) order.
  v_ids   uuid[] := ARRAY[]::uuid[];
  v_marks timestamptz[] := ARRAY[]::timestamptz[];

  v_cand      record;
  v_owner     uuid;
  v_removed   timestamptz;
  v_active    boolean;
  v_jobs      uuid[];
  v_live      integer;
  v_remaining integer;
  v_budget    integer;
  v_n         integer;

  -- Per-parent counters.
  v_here_media    integer := 0;
  v_here_profile  integer := 0;
  v_here_coverage integer := 0;
  v_here_ops      integer := 0;
  v_here_ckpt     integer := 0;
  v_here_jobs     integer := 0;
  v_here_throttle integer := 0;

  -- Call counters.
  v_considered integer := 0;
  v_deleted    integer := 0;
  v_projected  integer := 0;
  v_skipped_lease integer := 0;
  v_skipped_ineligible integer := 0;

  v_n_media    integer := 0;
  v_n_profile  integer := 0;
  v_n_coverage integer := 0;
  v_n_ops      integer := 0;
  v_n_ckpt     integer := 0;
  v_n_jobs     integer := 0;
  v_n_throttle integer := 0;

  v_has_more boolean := false;
  i          integer;
BEGIN
  -- The caller must be the service role. The GRANT below is the tighter of
  -- the two layers - a browser role cannot reach this function at all -
  -- and this check is the inner shell.
  PERFORM public.ig_collection_assert_service_caller();

  -- The bounds are a contract, not a suggestion: a caller that asks for
  -- an unbounded slice is refused rather than silently clamped, because a
  -- silent clamp would make the reported counts a lie.
  IF p_parent_limit IS NULL OR p_parent_limit < 1 OR p_parent_limit > 50 THEN
    RAISE EXCEPTION
      'COMPETITOR_RETENTION_LIMIT_INVALID: the parent limit must be between 1 and 50'
      USING ERRCODE = '22023';
  END IF;

  IF p_child_limit IS NULL OR p_child_limit < 1 OR p_child_limit > 500 THEN
    RAISE EXCEPTION
      'COMPETITOR_RETENTION_LIMIT_INVALID: the child limit must be between 1 and 500'
      USING ERRCODE = '22023';
  END IF;

  -- A missing dry-run flag is not a decision.
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION
      'COMPETITOR_RETENTION_LIMIT_INVALID: the dry-run flag must be true or false'
      USING ERRCODE = '22023';
  END IF;

  v_cutoff := v_now - interval '2160 hours';

  -- The switch. A missing row and a malformed value both fail closed.
  SELECT s.value INTO v_setting
    FROM public.app_settings AS s
   WHERE s.key = 'competitor_retention_enabled';

  IF v_setting IS NULL THEN
    v_switch := 'missing';
  ELSIF jsonb_typeof(v_setting) = 'boolean' THEN
    IF v_setting::boolean THEN
      v_switch := 'enabled';
    ELSE
      v_switch := 'disabled';
    END IF;
  ELSE
    v_switch := 'malformed';
  END IF;

  IF v_switch = 'enabled' OR p_dry_run THEN
    ---------------------------------------------------------------------
    -- The candidates.
    --
    -- The real path locks the parents FOR UPDATE SKIP LOCKED: a parent
    -- another transaction already holds is skipped rather than waited for,
    -- so two cleanup runs never block each other and a reactivation in
    -- flight is never waited on either.
    --
    -- The dry-run path takes the SAME candidates without locking them. A
    -- preview must not block a writer.
    ---------------------------------------------------------------------
    IF p_dry_run THEN
      SELECT array_agg(b.id ORDER BY b.removed_at, b.id),
             array_agg(b.removed_at ORDER BY b.removed_at, b.id)
        INTO v_ids, v_marks
        FROM (
          SELECT w.id, w.removed_at
            FROM public.competitor_watchlist AS w
           WHERE w.is_active = false
             AND w.removed_at IS NOT NULL
             AND w.removed_at <= v_cutoff
           ORDER BY w.removed_at, w.id
           LIMIT p_parent_limit
        ) AS b;
    ELSE
      FOR v_cand IN
        SELECT w.id, w.removed_at
          FROM public.competitor_watchlist AS w
         WHERE w.is_active = false
           AND w.removed_at IS NOT NULL
           AND w.removed_at <= v_cutoff
         ORDER BY w.removed_at, w.id
         LIMIT p_parent_limit
           FOR UPDATE SKIP LOCKED
      LOOP
        v_ids := v_ids || v_cand.id;
        v_marks := v_marks || v_cand.removed_at;
      END LOOP;
    END IF;

    v_budget := p_child_limit;

    FOR i IN 1..coalesce(array_length(v_ids, 1), 0) LOOP
      v_here_media    := 0;
      v_here_profile  := 0;
      v_here_coverage := 0;
      v_here_ops      := 0;
      v_here_ckpt     := 0;
      v_here_jobs     := 0;
      v_here_throttle := 0;

      v_considered := v_considered + 1;

      -------------------------------------------------------------------
      -- The recheck, under the lock.
      --
      -- The real path already holds the row lock: FOR UPDATE returned the
      -- latest committed version and re-evaluated the qualification on it.
      -- The plain read below therefore returns that same version, and
      -- nothing can move it while this transaction runs.
      --
      -- The recheck repeats the owner, the inactivity, the UNCHANGED
      -- marker and the cutoff. A parent that was reactivated, or whose
      -- marker moved, is not a candidate any more.
      -------------------------------------------------------------------
      SELECT w.user_id, w.removed_at, w.is_active
        INTO v_owner, v_removed, v_active
        FROM public.competitor_watchlist AS w
       WHERE w.id = v_ids[i];

      IF v_owner IS NULL
         OR v_active
         OR v_removed IS DISTINCT FROM v_marks[i]
         OR v_removed > v_cutoff THEN
        v_skipped_ineligible := v_skipped_ineligible + 1;
        CONTINUE;
      END IF;

      -------------------------------------------------------------------
      -- A live lease stops the cleanup for this parent.
      --
      -- The lease is compared against the wall clock, not the transaction
      -- time: a slice that waited on a lock must not treat an expired
      -- lease as live. An EXPIRED lease is not a stop - it is abandoned
      -- work, and it confers no write authority on anybody.
      -------------------------------------------------------------------
      SELECT count(*)::integer INTO v_live
        FROM public.instagram_collection_jobs AS j
       WHERE j.watchlist_id = v_ids[i]
         AND j.user_id = v_owner
         AND j.target_kind = 'competitor'
         AND j.status = 'leased'
         AND j.lease_expires_at IS NOT NULL
         AND j.lease_expires_at > clock_timestamp();

      IF v_live > 0 THEN
        v_skipped_lease := v_skipped_lease + 1;
        CONTINUE;
      END IF;

      -- The budget is spent: no child can be removed, so the parent cannot
      -- be removed either. More work remains.
      IF v_budget <= 0 THEN
        EXIT;
      END IF;

      -- The jobs of this parent. Every job join below is scoped by BOTH
      -- the watchlist id and the owner, so another owner's row can never
      -- be reached through a shared handle.
      SELECT array_agg(j.id) INTO v_jobs
        FROM public.instagram_collection_jobs AS j
       WHERE j.watchlist_id = v_ids[i]
         AND j.user_id = v_owner
         AND j.target_kind = 'competitor';

      -------------------------------------------------------------------
      -- The children, in bounded chunks, child-first.
      --
      -- Each statement selects at most the remaining budget and deletes
      -- exactly those rows. A dry run performs the identical SELECT and
      -- counts the victims without deleting them, so the preview and the
      -- real slice report the same numbers.
      -------------------------------------------------------------------

      -- 1. The media snapshots.
      WITH victims AS (
        SELECT s.id
          FROM public.competitor_media_snapshots AS s
         WHERE s.watchlist_id = v_ids[i]
           AND s.user_id = v_owner
         LIMIT v_budget
      ), removed AS (
        DELETE FROM public.competitor_media_snapshots AS t
         USING victims
         WHERE t.id = victims.id
           AND NOT p_dry_run
         RETURNING 1
      )
      SELECT count(*)::integer INTO v_n FROM victims;
      v_here_media := v_n;
      v_n_media := v_n_media + v_n;
      v_budget := v_budget - v_n;

      -- 2. The profile snapshots.
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT s.id
            FROM public.competitor_profile_snapshots AS s
           WHERE s.watchlist_id = v_ids[i]
             AND s.user_id = v_owner
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.competitor_profile_snapshots AS t
           USING victims
           WHERE t.id = victims.id
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_profile := v_n;
        v_n_profile := v_n_profile + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -- 3. The capture coverage (M1).
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT c.id
            FROM public.competitor_capture_coverage AS c
           WHERE c.watchlist_id = v_ids[i]
             AND c.user_id = v_owner
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.competitor_capture_coverage AS t
           USING victims
           WHERE t.id = victims.id
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_coverage := v_n;
        v_n_coverage := v_n_coverage + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -- 4. The job operations. They go before their job, in bounded
      --    chunks, so the job delete never has to lean on the cascade.
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT o.id
            FROM public.instagram_collection_job_operations AS o
           WHERE o.user_id = v_owner
             AND o.job_id = ANY(coalesce(v_jobs, ARRAY[]::uuid[]))
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.instagram_collection_job_operations AS t
           USING victims
           WHERE t.id = victims.id
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_ops := v_n;
        v_n_ops := v_n_ops + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -- 5. The job checkpoints.
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT c.job_id, c.job_generation
            FROM public.instagram_collection_job_checkpoints AS c
           WHERE c.user_id = v_owner
             AND c.job_id = ANY(coalesce(v_jobs, ARRAY[]::uuid[]))
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.instagram_collection_job_checkpoints AS t
           USING victims
           WHERE t.job_id = victims.job_id
             AND t.job_generation = victims.job_generation
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_ckpt := v_n;
        v_n_ckpt := v_n_ckpt + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -- 6. The jobs themselves: completed work, abandoned queued, retry,
      --    partial, error and unavailable work, and expired leases.
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT j.id
            FROM public.instagram_collection_jobs AS j
           WHERE j.watchlist_id = v_ids[i]
             AND j.user_id = v_owner
             AND j.target_kind = 'competitor'
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.instagram_collection_jobs AS t
           USING victims
           WHERE t.id = victims.id
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_jobs := v_n;
        v_n_jobs := v_n_jobs + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -- 7. The per-target request throttle rows. The shared provider
      --    throttle buckets are NOT touched: they are shared state and not
      --    the property of one tracked competitor.
      IF v_budget > 0 THEN
        WITH victims AS (
          SELECT t.scope, t.target_kind, t.target_id
            FROM public.instagram_collection_request_throttles AS t
           WHERE t.user_id = v_owner
             AND t.watchlist_id = v_ids[i]
             AND t.target_kind = 'competitor'
             AND t.target_id = v_ids[i]
           LIMIT v_budget
        ), removed AS (
          DELETE FROM public.instagram_collection_request_throttles AS t
           USING victims
           WHERE t.scope = victims.scope
             AND t.target_kind = victims.target_kind
             AND t.target_id = victims.target_id
             AND NOT p_dry_run
           RETURNING 1
        )
        SELECT count(*)::integer INTO v_n FROM victims;
        v_here_throttle := v_n;
        v_n_throttle := v_n_throttle + v_n;
        v_budget := v_budget - v_n;
      END IF;

      -------------------------------------------------------------------
      -- The children this parent still has.
      --
      -- Nothing is deleted while a child remains: the parent delete below
      -- is the only cascade-bearing statement, and it runs only when this
      -- count is zero. In a dry run nothing was deleted, so the count is
      -- the total and the projection subtracts what this call covers.
      -------------------------------------------------------------------
      SELECT count(*)::integer INTO v_remaining
        FROM (
          SELECT 1 FROM public.competitor_media_snapshots AS s
           WHERE s.watchlist_id = v_ids[i] AND s.user_id = v_owner
          UNION ALL
          SELECT 1 FROM public.competitor_profile_snapshots AS s
           WHERE s.watchlist_id = v_ids[i] AND s.user_id = v_owner
          UNION ALL
          SELECT 1 FROM public.competitor_capture_coverage AS c
           WHERE c.watchlist_id = v_ids[i] AND c.user_id = v_owner
          UNION ALL
          SELECT 1 FROM public.instagram_collection_jobs AS j
           WHERE j.watchlist_id = v_ids[i]
             AND j.user_id = v_owner
             AND j.target_kind = 'competitor'
          UNION ALL
          SELECT 1 FROM public.instagram_collection_job_operations AS o
           WHERE o.user_id = v_owner
             AND o.job_id = ANY(coalesce(v_jobs, ARRAY[]::uuid[]))
          UNION ALL
          SELECT 1 FROM public.instagram_collection_job_checkpoints AS c
           WHERE c.user_id = v_owner
             AND c.job_id = ANY(coalesce(v_jobs, ARRAY[]::uuid[]))
          UNION ALL
          SELECT 1 FROM public.instagram_collection_request_throttles AS t
           WHERE t.user_id = v_owner
             AND t.watchlist_id = v_ids[i]
             AND t.target_kind = 'competitor'
             AND t.target_id = v_ids[i]
        ) AS remaining;

      IF p_dry_run THEN
        v_remaining := v_remaining
          - v_here_media - v_here_profile - v_here_coverage
          - v_here_ops - v_here_ckpt - v_here_jobs - v_here_throttle;
      END IF;

      IF v_remaining > 0 THEN
        -- The budget ran out before this parent's children were gone. The
        -- parent is NOT deleted, and the slice stops here: the next call
        -- picks the backlog up where this one left it.
        EXIT;
      END IF;

      -------------------------------------------------------------------
      -- The parent delete.
      --
      -- The owner, the inactivity, the UNCHANGED marker and the cutoff are
      -- repeated here, in the same transaction, right before the delete.
      -- A row that moved under us is not deleted.
      -------------------------------------------------------------------
      IF p_dry_run THEN
        v_projected := v_projected + 1;
      ELSE
        DELETE FROM public.competitor_watchlist AS w
         WHERE w.id = v_ids[i]
           AND w.user_id = v_owner
           AND w.is_active = false
           AND w.removed_at IS NOT NULL
           AND w.removed_at = v_removed
           AND w.removed_at <= v_cutoff;

        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n = 1 THEN
          v_deleted := v_deleted + 1;
          v_projected := v_projected + 1;
        ELSE
          v_skipped_ineligible := v_skipped_ineligible + 1;
        END IF;
      END IF;
    END LOOP;
  ELSE
    -------------------------------------------------------------------
    -- The switch is off, missing or malformed: NO MUTATION AT ALL.
    --
    -- The report still says how much eligible work exists, so an operator
    -- can see the backlog without turning anything on.
    -------------------------------------------------------------------
    SELECT count(*)::integer INTO v_considered
      FROM (
        SELECT 1
          FROM public.competitor_watchlist AS w
         WHERE w.is_active = false
           AND w.removed_at IS NOT NULL
           AND w.removed_at <= v_cutoff
         ORDER BY w.removed_at, w.id
         LIMIT p_parent_limit
      ) AS bounded;
  END IF;

  -- Is there eligible work left? A parent that was skipped because of a
  -- live lease, or because the budget ran out, or because another
  -- transaction holds its lock, is eligible work that is still there.
  SELECT EXISTS (
    SELECT 1
      FROM public.competitor_watchlist AS w
     WHERE w.is_active = false
       AND w.removed_at IS NOT NULL
       AND w.removed_at <= v_cutoff
  ) INTO v_has_more;

  RETURN jsonb_build_object(
    'switch_state', v_switch,
    'dry_run', p_dry_run,
    'now_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cutoff_at', to_char(v_cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'parents_considered', v_considered,
    'parents_deleted', v_deleted,
    'parents_projected', v_projected,
    'parents_skipped_live_lease', v_skipped_lease,
    'parents_skipped_ineligible', v_skipped_ineligible,
    'child_counts', jsonb_build_object(
      'competitor_media_snapshots', v_n_media,
      'competitor_profile_snapshots', v_n_profile,
      'competitor_capture_coverage', v_n_coverage,
      'instagram_collection_job_operations', v_n_ops,
      'instagram_collection_job_checkpoints', v_n_ckpt,
      'instagram_collection_jobs', v_n_jobs,
      'instagram_collection_request_throttles', v_n_throttle
    ),
    'children_counted', v_n_media + v_n_profile + v_n_coverage
      + v_n_ops + v_n_ckpt + v_n_jobs + v_n_throttle,
    'children_deleted', CASE WHEN p_dry_run THEN 0
      ELSE v_n_media + v_n_profile + v_n_coverage
         + v_n_ops + v_n_ckpt + v_n_jobs + v_n_throttle END,
    'has_more', v_has_more
  );
END;
$function$;

COMMENT ON FUNCTION public.run_competitor_retention_batch(integer, integer, boolean) IS
  'One bounded slice of the inactive-history cleanup. Service role only. '
  'Deletes the history of competitors removed for at least 90 elapsed days, '
  'child rows first, at most p_parent_limit parents (1-50) and p_child_limit '
  'child rows (1-500) per call. The server now() is the only clock and there '
  'is no owner or cutoff argument. A parent with a live job lease is '
  'skipped; an expired lease has no write authority. The parent is deleted '
  'only after every child relation is empty for it, and the delete repeats '
  'the owner, inactivity, unchanged marker and cutoff predicates. The '
  'competitor_retention_enabled setting must be true or nothing is mutated; '
  'a missing or malformed switch fails closed. p_dry_run performs the same '
  'bounded reads and mutates nothing.';

-- ===========================================================================
-- 4. Grants.
-- ===========================================================================
--
-- Service role only. This stack carries ALTER DEFAULT PRIVILEGES ... GRANT
-- ALL ON FUNCTIONS, so the REVOKEs are load-bearing.
--
REVOKE ALL ON FUNCTION public.run_competitor_retention_batch(integer, integer, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.run_competitor_retention_batch(integer, integer, boolean)
  TO service_role;

COMMIT;
