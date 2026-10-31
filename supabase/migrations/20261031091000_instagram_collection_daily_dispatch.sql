-- ===========================================================================
-- 20261031091000_instagram_collection_daily_dispatch.sql
--
-- R2 - the durable daily dispatch and its bounded continuation.
--
-- Plan:  docs/plans/2026-10-30-instagram-collection-rollout-controls.md
-- Spec:  docs/specs/2026-10-30-instagram-collection-rollout-controls.md
--
-- APPLY AS supabase_admin. It owns the functions below; postgres is not a
-- superuser on this stack and a REVOKE by a non-owner is a WARNING that
-- changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   The daily sweep that turns "which targets may be collected for" into
--   "which targets have a job for TODAY". The admission decision stays where
--   R1 put it - in SQL, in one evaluator - and this migration adds only the
--   durable bookkeeping that lets a bounded page be continued by a LATER
--   tick instead of by a volatile in-process cursor.
--
--   One table, `instagram_collection_enqueue_sweeps`, keyed by
--   (target_kind, captured_on), and one service-only RPC,
--   `enqueue_instagram_collection_daily_page(p_target_kind, p_start)`.
--
-- WHAT THIS IS NOT
--
--   * Not an activation. The default policy admits nobody, the master
--     switch is still the first kill switch, and no schedule is created.
--     C1 owns the schedules and they are installed inactive.
--   * Not a second admission system. Every candidate is decided by R1's
--     `ig_collection_rollout_target_allowed` AT INSERT TIME, so a policy
--     that excludes a target excludes it here too. The page does not carry
--     its own copy of the populations.
--   * Not a second enqueue. The rows it inserts are ORDINARY jobs: no
--     forced generation, no reset of a completed job, and no spent
--     accepted-request throttle window.
--
-- THE CONTINUATION
--
--   Progress is a keyset cursor on the sweep row (`last_target_id`), plus
--   the anti-join. Each page scans `id > cursor` in id order, at most one
--   page, and stores the last id it SCANNED, whether the evaluator
--   admitted that target or refused it. A refusal inserts no job, but the
--   cursor still moves past that id, so the next page cannot select it
--   again. Without that, a prefix of refused rows that fills the page is
--   selected forever and the sweep never completes.
--
--   The anti-join skips a target that already has a job for this capture
--   day. A start that walks from the beginning is therefore idempotent
--   for targets that were already queued. A lost response loses nothing:
--   the next call reconciles from the persisted jobs and the persisted
--   cursor.
--
--   The evaluator stays OUT of the scan's WHERE clause. Putting it there
--   would turn an all-refused table into an unbounded scan. The page
--   limit bounds the scan; the cursor stops the next page repeating it.
--
--   A target that becomes eligible BEHIND the cursor while the sweep is
--   still pending is not taken by a resume. The next start or reopen
--   resets the cursor to NULL and walks from the beginning, and the
--   anti-join skips targets that already have a job, so the newly
--   eligible one is admitted then. A completed sweep's resume returns
--   without writing a job. The cursor is the end of the walk, never a
--   certificate that a target was collected, and it carries no credential.
--
--   The page is bounded: at most 25 owner targets or 50 competitor targets
--   per call. A population larger than that is finished by later ticks, and
--   the sweep row is what says whether the day is finished.
--
-- THE TWO MODES
--
--   p_start = true   STARTS or REOPENS the current day's sweep and resets
--                     the keyset cursor. It is the daily dispatcher's mode.
--                     Reopening walks from the beginning, so it admits a
--                     target that was approved after the sweep completed
--                     and a target that became eligible behind the cursor,
--                     without touching the jobs that already exist.
--   p_start = false  RESUMES an already pending current-day sweep. It never
--                     starts one, so a drain tick can never begin
--                     collection by itself.
--
-- THE CAPTURE DAY
--
--   The capture day is chosen by the DATABASE, in Asia/Kuwait, exactly like
--   the accepted job's `captured_on`. The caller never names a day: a
--   caller-selected date is a way to write history, and this table is a
--   record of what was actually attempted.
--
-- THE STATES
--
--   pending    the sweep is still running. Another tick continues it
--              from the cursor.
--   completed  the last page did not fill, so the walk reached the end of
--              the id order after the cursor. That is not a proof that a
--              target behind the cursor was collected. A target approved
--              later, or one that became eligible behind the cursor, waits
--              for another explicit start or for the next day's schedule.
--   expired    the capture day rolled over before the sweep finished. The
--              row is kept as evidence: it is never silently completed and
--              no historical observation is ever fabricated.
--
-- THE LOCK
--
--   The sweep row is the serialisation point. A start and a resume of the
--   same kind and day take the same row lock, so two dispatchers cannot
--   interleave inside one sweep. The lock is taken on the SWEEP ROW and on
--   no account row, so the established `account -> watchlist -> job` order
--   is not inverted and the R1 policy writer still never waits.
--
--   The job rows this migration inserts take a KEY SHARE on their parent
--   account or watchlist row, which is the weakest possible lock and is
--   compatible with the concurrent lease writers the workers already do.
--
-- THE BOUNDS
--
--   The statement is bounded: a lock timeout and a statement timeout, both
--   local to the call. A sweep that cannot be serialised in time FAILS
--   loudly. It is never reported as "everything was enqueued".
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The sweep table.
--
-- One row per (kind, capture day). It is a bookkeeping record: counts, a
-- state, the keyset cursor and three timestamps. The cursor names the last
-- scanned target id. It is not a claim that the target was collected, and
-- the row carries no credential.
-- ===========================================================================

CREATE TABLE public.instagram_collection_enqueue_sweeps (
  target_kind   text NOT NULL,
  captured_on   date NOT NULL,

  status        text NOT NULL DEFAULT 'pending',

  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expired_at    timestamptz,

  -- The non-secret progress counts of the day.
  enqueued_count integer NOT NULL DEFAULT 0,
  page_count     integer NOT NULL DEFAULT 0,

  last_reason_code text,

  -- The last target id this sweep scanned, admitted or refused. NULL until
  -- the first page of a start or reopen scans a row. No foreign key: the
  -- id may belong to an account or a watchlist, and that row may be gone.
  last_target_id uuid,

  CONSTRAINT instagram_collection_enqueue_sweeps_pkey
    PRIMARY KEY (target_kind, captured_on),

  CONSTRAINT instagram_collection_enqueue_sweeps_target_kind_chk
    CHECK (target_kind IN ('owner', 'competitor')),

  CONSTRAINT instagram_collection_enqueue_sweeps_status_chk
    CHECK (status IN ('pending', 'completed', 'expired')),

  CONSTRAINT instagram_collection_enqueue_sweeps_counts_chk
    CHECK (enqueued_count >= 0 AND page_count >= 0),

  CONSTRAINT instagram_collection_enqueue_sweeps_reason_code_chk
    CHECK (last_reason_code IS NULL OR last_reason_code ~ '^[a-z0-9_]{1,64}$')
);

COMMENT ON TABLE public.instagram_collection_enqueue_sweeps IS
  'The durable progress of one daily collection sweep, per (target kind, '
  'Kuwait capture day). pending = another tick continues from the keyset '
  'cursor, completed = the last page did not fill so the walk reached the '
  'end of the id order, expired = the capture day rolled over before the '
  'sweep finished. The cursor is the last scanned target id, not a claim '
  'that the target was collected, and the row carries no credential.';

COMMENT ON COLUMN public.instagram_collection_enqueue_sweeps.started_at IS
  'When this day''s sweep was first started. A reopen keeps it: the row is '
  'the record of the day, not of the last call.';

COMMENT ON COLUMN public.instagram_collection_enqueue_sweeps.enqueued_count IS
  'How many job rows this day''s sweep inserted. It is a count of INSERTed '
  'rows, never of collected targets.';

COMMENT ON COLUMN public.instagram_collection_enqueue_sweeps.last_target_id IS
  'The keyset cursor: the last target id this sweep scanned, whether the '
  'evaluator admitted it or refused it. A start or reopen sets it back to '
  'NULL. A resume continues at id > this value. A target that becomes '
  'eligible at or behind this id waits for the next start or reopen. It '
  'is not a claim of collection and it carries no credential.';

-- The browser never sees this table. RLS is enabled and there is no policy,
-- so no ordinary role may read or write a row whatever the caller claims.
ALTER TABLE public.instagram_collection_enqueue_sweeps ENABLE ROW LEVEL SECURITY;

-- The browser roles get NO privilege on the table. RLS is enabled and
-- there is no policy, so even a grant would not open a row.
--
-- The service role keeps the table privilege the database's default
-- privileges already give it, exactly like every other service-owned table
-- in this schema: it is a privileged dispatch caller, and the RPC is the
-- documented way to read the counts.
REVOKE ALL ON TABLE public.instagram_collection_enqueue_sweeps FROM PUBLIC, anon, authenticated;

-- The candidate scans are `id > cursor ORDER BY id LIMIT page`, so the two
-- partial indexes below keep each page index-backed and bounded by the
-- page limit instead of a sort over the whole table.
CREATE INDEX IF NOT EXISTS idx_social_accounts_instagram_daily_dispatch
  ON public.social_accounts (id)
  WHERE platform = 'instagram' AND is_active;

CREATE INDEX IF NOT EXISTS idx_competitor_watchlist_daily_dispatch
  ON public.competitor_watchlist (id)
  WHERE is_active;

-- ===========================================================================
-- 2. The bounded daily page.
--
-- The whole contract is one statement:
--
--   * it serialises the kind/day sweep row;
--   * it selects AT MOST 25 owner targets or 50 competitor targets with
--     id greater than the sweep cursor and NO job for the current capture
--     day;
--   * it re-decides every one of them with R1's evaluator AT INSERT TIME;
--   * it inserts ordinary jobs, never forcing a generation and never
--     spending the accepted-request throttle window;
--   * it records the counts and the state of the day;
--   * it returns a bounded receipt.
--
-- The receipt is a closed union:
--
--   accepted:
--     { accepted, target_kind, captured_on, sweep_status, enqueued,
--       has_more, page_limit, scanned, started, resumed }
--
--   refused:
--     { accepted: false, refused: true, reason_code, target_kind,
--       captured_on }
--
-- A refusal is a DEFINITE answer about the CONFIGURATION: the master is
-- off, or the configuration cannot be read. It is never an answer about a
-- target, and it never means "nothing was eligible".
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_daily_page(
  p_target_kind text,
  p_start       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_kind        text;
  v_start       boolean := COALESCE(p_start, false);
  v_state       jsonb;
  v_status      text;
  v_mode        text;
  v_restrict    boolean := false;
  v_allowed_ids uuid[] := ARRAY[]::uuid[];
  v_captured_on date;
  v_page_limit  integer;
  v_sweep_status text;
  v_started     boolean := false;
  v_resumed     boolean := false;
  v_enqueued    integer := 0;
  v_scanned     integer := 0;
  v_has_more    boolean := false;
  v_cursor      uuid := NULL;
  v_last_scanned uuid := NULL;
  v_candidates  jsonb := '[]'::jsonb;
  v_candidate   record;
  v_allowed     jsonb;
  v_job_id      uuid;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  v_kind := p_target_kind;

  -- The bounds. Both are LOCAL to this transaction, so a statement that
  -- cannot finish in time FAILS instead of holding a lock forever.
  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM set_config('statement_timeout', '30s', true);

  -- The capture day is chosen HERE, by the database, in Kuwait time.
  v_captured_on := (now() AT TIME ZONE 'Asia/Kuwait')::date;

  -- The rollout state, read ONCE for the page. A configuration that cannot
  -- be read is a definite refusal, not an empty page.
  v_state := public.ig_collection_rollout_state();
  v_status := v_state ->> 'status';

  IF v_status <> 'ok' THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_daily_enqueue_refused',
      'reason_code', v_state ->> 'reason_code',
      'target_kind', v_kind,
      'details', jsonb_build_object(
        'action', 'enqueue_daily',
        'captured_on', v_captured_on::text)));

    RETURN jsonb_build_object(
      'accepted', false,
      'refused', true,
      'reason_code', v_state ->> 'reason_code',
      'target_kind', v_kind,
      'captured_on', v_captured_on);
  END IF;

  -- The page ceiling. It is a CONSTANT of the contract: the owner page is
  -- twenty five targets and the competitor page is fifty.
  v_page_limit := CASE WHEN v_kind = 'owner' THEN 25 ELSE 50 END;

  -- The approved populations of THIS kind. `all` carries no id filter, and
  -- `off` carries an empty one, so `off` admits nobody.
  IF v_kind = 'owner' THEN
    v_mode := v_state ->> 'owner_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'owner_ids'))::uuid);
  ELSE
    v_mode := v_state ->> 'competitor_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'competitor_ids'))::uuid);
  END IF;

  v_restrict := (v_mode <> 'all');

  -- -------------------------------------------------------------------------
  -- The rollover.
  --
  -- An unfinished sweep of an EARLIER capture day is recorded expired, with
  -- the evidence that it did not finish. It is never deleted and never
  -- marked completed: a sweep that did not run to the end must not look
  -- like a day that was collected.
  --
  -- This runs BEFORE today's row is locked, so every caller takes the same
  -- lock order: the older rows first, then today's row.
  -- -------------------------------------------------------------------------
  UPDATE public.instagram_collection_enqueue_sweeps
     SET status           = 'expired',
         expired_at       = now(),
         updated_at       = now(),
         last_reason_code = 'capture_day_rolled_over'
   WHERE target_kind = v_kind
     AND captured_on < v_captured_on
     AND status = 'pending';

  -- -------------------------------------------------------------------------
  -- The sweep row.
  --
  -- The START path inserts or reopens it, and the upsert takes the same row
  -- lock the resume path takes. That row lock is the serialisation point:
  -- two dispatchers of the same kind and day cannot interleave.
  -- -------------------------------------------------------------------------
  IF v_start THEN
    INSERT INTO public.instagram_collection_enqueue_sweeps AS s
      (target_kind, captured_on, status, started_at, updated_at,
       completed_at, expired_at, last_target_id)
    VALUES (v_kind, v_captured_on, 'pending', now(), now(), NULL, NULL, NULL)
    ON CONFLICT (target_kind, captured_on) DO UPDATE
       SET status           = 'pending',
           updated_at       = now(),
           completed_at     = NULL,
           expired_at       = NULL,
           last_reason_code = NULL,
           last_target_id   = NULL;

    -- A start or reopen walks from the beginning. Counts of the day are
    -- kept: the cursor is the only progress marker that goes back to NULL.
    v_started := true;
    v_cursor := NULL;
  ELSE
    -- The RESUME path locks the row and reads its state and its cursor.
    -- A missing row leaves the state NULL, which is "there is no sweep
    -- to resume".
    SELECT s.status, s.last_target_id
      INTO v_sweep_status, v_cursor
      FROM public.instagram_collection_enqueue_sweeps AS s
     WHERE s.target_kind = v_kind
       AND s.captured_on = v_captured_on
     FOR UPDATE;

    IF v_sweep_status IS DISTINCT FROM 'pending' THEN
      -- Nothing to resume. A drain tick never STARTS a sweep, and a
      -- completed sweep stays completed until an explicit start reopens it.
      RETURN jsonb_build_object(
        'accepted', true,
        'target_kind', v_kind,
        'captured_on', v_captured_on,
        'sweep_status', COALESCE(v_sweep_status, 'absent'),
        'enqueued', 0,
        'has_more', false,
        'page_limit', v_page_limit,
        'scanned', 0,
        'started', false,
        'resumed', false);
    END IF;

    v_resumed := true;
  END IF;

  -- -------------------------------------------------------------------------
  -- The candidates.
  --
  -- The continuation is the persisted keyset AND the anti-join. The scan
  -- reads at most one page of ids strictly after the cursor, in id order.
  -- The anti-join skips a target that already has a job for this capture
  -- day, so a start that reset the cursor does not insert a second job.
  --
  -- The evaluator is applied in the loop below, not in this WHERE clause.
  -- A refused row still consumes a slot in this page and still advances
  -- the cursor. Filtering it out here would keep scanning until the page
  -- filled with admitted rows, which is unbounded when every row is refused.
  --
  -- The two kinds are two SEPARATE bounded reads rather than one union: a
  -- union would apply its LIMIT to the combined result and the scan would
  -- stop being bounded. The partial indexes on (id) serve `id > cursor
  -- ORDER BY id LIMIT`.
  -- -------------------------------------------------------------------------
  IF v_kind = 'owner' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', c.user_id,
               'target_id', c.target_id,
               'social_account_id', c.social_account_id,
               'watchlist_id', c.watchlist_id
             ) ORDER BY c.target_id), '[]'::jsonb)
      INTO v_candidates
      FROM (
        SELECT sa.user_id,
               sa.id AS target_id,
               sa.id AS social_account_id,
               NULL::uuid AS watchlist_id
          FROM public.social_accounts AS sa
         WHERE sa.platform = 'instagram'
           AND sa.is_active
           AND (NOT v_restrict OR sa.id = ANY(v_allowed_ids))
           AND (v_cursor IS NULL OR sa.id > v_cursor)
           AND NOT EXISTS (
                 SELECT 1
                   FROM public.instagram_collection_jobs AS j
                  WHERE j.user_id = sa.user_id
                    AND j.target_kind = 'owner'
                    AND j.target_id = sa.id
                    AND j.captured_on = v_captured_on)
         ORDER BY sa.id
         LIMIT v_page_limit
      ) AS c;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', c.user_id,
               'target_id', c.target_id,
               'social_account_id', c.social_account_id,
               'watchlist_id', c.watchlist_id
             ) ORDER BY c.target_id), '[]'::jsonb)
      INTO v_candidates
      FROM (
        SELECT w.user_id,
               w.id AS target_id,
               NULL::uuid AS social_account_id,
               w.id AS watchlist_id
          FROM public.competitor_watchlist AS w
         WHERE w.is_active
           -- The weekly retry gate is PRESERVED: an entry that is waiting
           -- for its weekly gate is not due, so the daily page does not
           -- bypass it.
           AND (w.next_retry_at IS NULL OR w.next_retry_at <= now())
           AND (NOT v_restrict OR w.id = ANY(v_allowed_ids))
           AND (v_cursor IS NULL OR w.id > v_cursor)
           AND NOT EXISTS (
                 SELECT 1
                   FROM public.instagram_collection_jobs AS j
                  WHERE j.user_id = w.user_id
                    AND j.target_kind = 'competitor'
                    AND j.target_id = w.id
                    AND j.captured_on = v_captured_on)
         ORDER BY w.id
         LIMIT v_page_limit
      ) AS c;
  END IF;

  FOR v_candidate IN
    SELECT (e.value ->> 'user_id')::uuid AS user_id,
           (e.value ->> 'target_id')::uuid AS target_id,
           (e.value ->> 'social_account_id')::uuid AS social_account_id,
           (e.value ->> 'watchlist_id')::uuid AS watchlist_id
      FROM jsonb_array_elements(v_candidates) AS e(value)
  LOOP
    v_scanned := v_scanned + 1;
    -- Every scanned id advances the cursor, including a refusal and an
    -- insert that conflicted. The cursor is how the next page moves on.
    v_last_scanned := v_candidate.target_id;

    -- The canonical admission check, AT INSERT TIME.
    --
    -- The page's own population list is only a SELECTION aid. The decision
    -- that admits the row is R1's evaluator, asked again here, so a policy
    -- that changed after the page was read still wins at the insert.
    v_allowed := public.ig_collection_rollout_target_allowed(
      v_candidate.user_id, v_kind, v_candidate.target_id, NULL::uuid);

    IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
      -- An excluded target is skipped, never inserted. It does not consume a
      -- throttle window and it does not change a generation.
      CONTINUE;
    END IF;

    -- An ORDINARY job: no forced generation, no reset of a completed job,
    -- and no accepted-request throttle window. The conflict clause is the
    -- race backstop; the anti-join above is what makes it rare.
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_candidate.user_id, v_kind, v_candidate.target_id,
      v_candidate.social_account_id, v_candidate.watchlist_id,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO NOTHING
    RETURNING j.id INTO v_job_id;

    IF v_job_id IS NOT NULL THEN
      v_enqueued := v_enqueued + 1;
    END IF;

    v_job_id := NULL;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- The state of the day.
  --
  -- A page that did not fill has walked to the end of the id order
  -- after the cursor, so the sweep is completed. That does not certify a
  -- target behind the cursor. A page that filled might have more ids after
  -- the last scanned one, so the sweep stays pending. An empty page leaves
  -- the cursor where it was.
  -- -------------------------------------------------------------------------
  v_has_more := (v_scanned >= v_page_limit);

  UPDATE public.instagram_collection_enqueue_sweeps
     SET status           = CASE WHEN v_has_more THEN 'pending' ELSE 'completed' END,
         completed_at     = CASE WHEN v_has_more THEN NULL ELSE now() END,
         updated_at       = now(),
         enqueued_count   = enqueued_count + v_enqueued,
         page_count       = page_count + 1,
         last_target_id   = CASE
                              WHEN v_scanned > 0 THEN v_last_scanned
                              ELSE last_target_id
                            END
   WHERE target_kind = v_kind
     AND captured_on = v_captured_on;

  RETURN jsonb_build_object(
    'accepted', true,
    'target_kind', v_kind,
    'captured_on', v_captured_on,
    'sweep_status', CASE WHEN v_has_more THEN 'pending' ELSE 'completed' END,
    'enqueued', v_enqueued,
    'has_more', v_has_more,
    'page_limit', v_page_limit,
    'scanned', v_scanned,
    'started', v_started,
    'resumed', v_resumed);
END;
$function$;

COMMENT ON FUNCTION public.enqueue_instagram_collection_daily_page(text, boolean) IS
  'The bounded daily enqueue page. It serialises the (target_kind, '
  'capture day) sweep row, selects at most 25 owner targets or 50 '
  'competitor targets with id greater than the sweep cursor and no job '
  'for the current Kuwait capture day, re-decides each of them with the '
  'rollout evaluator AT INSERT TIME, inserts ordinary jobs, advances the '
  'cursor to the last scanned id, and returns a bounded receipt. '
  'p_start = true starts or reopens the day''s sweep and resets the cursor; '
  'p_start = false resumes an already pending sweep and never starts one. '
  'A target that becomes eligible behind the cursor waits for the next '
  'start or reopen. The evaluator is not part of the scan filter.';

-- ===========================================================================
-- 3. The grants.
--
-- Service only. The browser roles may not execute it, and the internal
-- helpers it uses stay unreachable for them as well.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_daily_page(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_daily_page(text, boolean) TO service_role;

COMMIT;
