-- ===========================================================================
-- 20261105200000_instagram_context_missing_settlement.sql
--
-- The terminal settlement of an owner job whose account has NO capability
-- row, and the daily page that stops writing such jobs in the first place.
--
-- THE INCIDENT
--
--   On 2026-11-05 twenty one Instagram accounts had no row in
--   instagram_account_capabilities. The claim binds an owner job's context
--   from that row, so a job for one of those accounts could never carry a
--   context: it was claimed every two minutes, found without a context, and
--   abandoned as context_missing. Twenty nine such jobs had been reclaimed
--   up to five hundred and seventy three times. Nothing could settle them:
--   complete_instagram_collection_job_capability_unavailable refused a
--   context-less job outright, so the row stayed leased, came back, and was
--   abandoned again.
--
--   The enqueue side had the same hole. The daily page selected every active
--   Instagram account, so it kept writing a job for an account that could
--   never be collected.
--
-- WHAT THIS CHANGES
--
--   1. complete_instagram_collection_job_capability_unavailable gains ONE
--      branch. A context-less OWNER job whose social_account_id has no
--      capability row is settled exactly like the bound-context success
--      branch: status 'unavailable', the lease cleared, the reason
--      'capability_missing', and the same five-key answer. Every other
--      context-less job - a competitor job, or an owner job whose account
--      HAS a capability row, which the claim would have bound - is still
--      refused with IG_COLLECTION_CONTEXT_MISSING, because that is a stale
--      claim and not an unenrolled account.
--
--      The fence, the lock order, the rollout admission, the lease check and
--      the grants are unchanged: the branch is reachable only through the
--      same accepted fence the bound-context settlement already used.
--
--   2. enqueue_instagram_collection_daily_page never enqueues an owner
--      account without a capability row, and AUDITS how many it skipped.
--
--      The page reads a WINDOW: the first twenty five account ids after
--      the cursor, in id order. The enrolment decides what happens inside
--      the window, never which rows the window is, so an unenrolled account
--      consumes its slot, the cursor moves past it, and the read stays
--      bounded. The receipt does NOT change: it is a closed projection the
--      worker parses exactly, so the gap is observed in the audit trail
--      instead, one row per page. The competitor branch is unchanged.
--
--   This migration replaces two existing functions (CREATE OR REPLACE) and
--   changes no table, constraint, grant or policy.
-- ===========================================================================

BEGIN;

DO $dependencies$ BEGIN
  PERFORM 'public.ig_collection_assert_service_caller()'::regprocedure;
  PERFORM 'public.ig_collection_reason_code(text)'::regprocedure;
  PERFORM 'public.ig_collection_load_fenced_job(uuid,uuid,bigint,boolean,uuid)'::regprocedure;
  PERFORM 'public.ig_collection_assert_lease_live(timestamptz)'::regprocedure;
  PERFORM 'public.complete_instagram_collection_job(uuid,uuid,bigint,text,text)'::regprocedure;
  PERFORM 'public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint)'::regprocedure;
  PERFORM 'public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint)'::regprocedure;
  PERFORM 'public.enqueue_instagram_collection_daily_page(text,boolean)'::regprocedure;
  PERFORM 'public.ig_collection_rollout_state()'::regprocedure;
END $dependencies$;

-- ===========================================================================
-- 1. The settlement, with the context-less owner branch.
--
-- Copied from 20261104120000_instagram_capability_unavailable_settlement.sql.
-- The only difference is the block that refused a context-less job: it now
-- settles the owner job whose account has no capability row, and refuses
-- every other context-less job exactly as before.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.complete_instagram_collection_job_capability_unavailable(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job        public.instagram_collection_jobs%ROWTYPE;
  v_reason     text := public.ig_collection_reason_code('capability_missing');
  v_active     boolean;
  v_reauth     boolean;
  v_live_gen   bigint;
  v_live_login text;
  v_read_state text;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- The accepted fence: the parents and the job locked in the established
  -- order, the claim, the lease, the target and the rollout admission. The
  -- context is checked below, generation before state.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, false, NULL);

  -- The bound context, as the fence's p_require_context branch checks it.
  IF v_job.context_viewer_social_account_id IS NULL
     OR v_job.context_credential_generation IS NULL
     OR v_job.context_login_kind IS NULL THEN
    -- The claim binds the context from the capability row. An owner whose
    -- account has none could never be bound: that job is settled here, once,
    -- so it stops coming back every lease. Any other context-less job is a
    -- stale claim and is refused as before.
    IF v_job.target_kind = 'owner'
       AND NOT EXISTS (SELECT 1 FROM public.instagram_account_capabilities AS c
                        WHERE c.social_account_id = v_job.social_account_id) THEN
      PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
      UPDATE public.instagram_collection_jobs AS j
         SET status = 'unavailable', retry_at = NULL, lease_token = NULL, lease_expires_at = NULL,
             last_reason_code = v_reason, updated_at = now()
       WHERE j.id = p_job_id;
      RETURN jsonb_build_object('job_id', p_job_id, 'job_generation', v_job.job_generation,
                                'status', 'unavailable', 'outcome', 'unavailable', 'reason_code', v_reason);
    END IF;
    RAISE EXCEPTION
      'IG_COLLECTION_CONTEXT_MISSING: the job has no bound connection context'
      USING ERRCODE = '22023';
  END IF;

  SELECT sa.is_active, COALESCE(sa.needs_reauth, false)
    INTO v_active, v_reauth
    FROM public.social_accounts AS sa
   WHERE sa.id = v_job.context_viewer_social_account_id
     AND sa.user_id = v_job.user_id
     AND sa.platform = 'instagram';

  IF NOT FOUND OR NOT COALESCE(v_active, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_INACTIVE: the viewer account is not active'
      USING ERRCODE = '22023';
  END IF;

  IF v_reauth THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NEEDS_REAUTH: the viewer account needs to be reconnected'
      USING ERRCODE = '22023';
  END IF;

  -- The capability of the claimed generation. An absent row cannot be bound
  -- to the claimed generation, so it is refused like a replaced one.
  SELECT c.credential_generation, c.login_kind, c.permission_read_state
    INTO v_live_gen, v_live_login, v_read_state
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = v_job.context_viewer_social_account_id;

  IF NOT FOUND
     OR v_live_gen IS DISTINCT FROM v_job.context_credential_generation
     OR v_live_login IS DISTINCT FROM v_job.context_login_kind THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CREDENTIAL_CHANGED: the connection was replaced after this work was claimed'
      USING ERRCODE = '40001';
  END IF;

  IF v_read_state = 'ok' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CAPABILITY_RESOLVED: the bound account recorded its permission read after this work was claimed'
      USING ERRCODE = '40001';
  END IF;

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  -- The 'unavailable' branch of complete_instagram_collection_job. due_at,
  -- last_partial_at and last_success_at keep their values there too.
  UPDATE public.instagram_collection_jobs AS j
     SET status           = 'unavailable',
         retry_at         = NULL,
         lease_token      = NULL,
         lease_expires_at = NULL,
         last_reason_code = v_reason,
         updated_at       = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'status', 'unavailable',
    'outcome', 'unavailable',
    'reason_code', v_reason
  );
END;
$function$;

-- ===========================================================================
-- 2. The daily page, which no longer writes a job for an account that
-- cannot be collected.
--
-- Copied from 20261031091000_instagram_collection_daily_dispatch.sql. The
-- owner branch reads the page WINDOW first and decides the enrolment
-- inside it, and the skipped accounts of the window are audited. The
-- receipt itself is unchanged.
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
  v_skipped     integer := 0;
  v_skipped_accounts jsonb := '[]'::jsonb;
  v_has_more    boolean := false;
  v_cursor      uuid := NULL;
  v_last_scanned uuid := NULL;
  v_window       jsonb := '[]'::jsonb;
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
  -- The window.
  --
  -- The continuation is the persisted keyset AND the anti-join. The scan
  -- reads at most one page of ids strictly after the cursor, in id order.
  -- The anti-join skips a target that already has a job for this capture
  -- day, so a start that reset the cursor does not insert a second job.
  --
  -- The WINDOW is read FIRST and it carries NO enrolment predicate. The
  -- window is the bounded read: the first v_page_limit ids after the
  -- cursor. The enrolment decides what happens to a row INSIDE the window,
  -- never which rows the window is. An account without a capability row
  -- consumes its slot in this page and the cursor moves past it, so the
  -- read stays bounded and the account is counted once and never again.
  --
  -- The evaluator is applied in the loop below, not in the WHERE clause.
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
    -- The WINDOW of this page: the first v_page_limit active Instagram
    -- account ids strictly after the cursor, in id order, with the allowlist
    -- and the anti-join applied. One bounded read.
    --
    -- The enrolment is decided INSIDE the window: a row whose account has a
    -- capability row is a candidate, a row without one is SKIPPED. It
    -- consumes its slot, the cursor moves past it, and it is counted in the
    -- audit of this page.
    WITH page_window AS (
      SELECT sa.id, sa.user_id
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
    ),
    page_rows AS (
      SELECT w.id, w.user_id,
             EXISTS (SELECT 1
                       FROM public.instagram_account_capabilities AS cap
                      WHERE cap.social_account_id = w.id) AS has_capability
        FROM page_window AS w
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', r.user_id,
               'target_id', r.id,
               'social_account_id', r.id,
               'watchlist_id', NULL::uuid,
               'has_capability', r.has_capability
             ) ORDER BY r.id), '[]'::jsonb),
           count(*) FILTER (WHERE NOT r.has_capability),
           COALESCE(jsonb_agg(jsonb_build_object(
               'target_id', r.id,
               'user_id', r.user_id
             ) ORDER BY r.id) FILTER (WHERE NOT r.has_capability), '[]'::jsonb)
      INTO v_window, v_skipped, v_skipped_accounts
      FROM page_rows AS r;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'user_id', c.user_id,
               'target_id', c.target_id,
               'social_account_id', c.social_account_id,
               'watchlist_id', c.watchlist_id
             ) ORDER BY c.target_id), '[]'::jsonb)
      INTO v_window
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

  -- -------------------------------------------------------------------------
  -- The enrolment gap of this page.
  --
  -- The receipt is a CLOSED projection and it does NOT change: the old and
  -- the new worker agree on it, so either deploy order is safe. The gap is
  -- observable in the AUDIT trail instead: one row per page, written with
  -- the same helper the refusals use.
  --
  -- A page is not one tenant's page, so the row carries no user id of its
  -- own; the owners of the skipped accounts are in the details.
  -- -------------------------------------------------------------------------
  IF v_kind = 'owner' AND v_skipped > 0 THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_daily_enqueue_skipped_reconnect_required',
      'reason_code', 'capability_missing',
      'target_kind', 'owner',
      'details', jsonb_build_object(
        'action', 'enqueue_daily',
        'captured_on', v_captured_on::text,
        'skipped', v_skipped,
        'skipped_accounts', v_skipped_accounts)));
  END IF;

  FOR v_candidate IN
    SELECT (e.value ->> 'user_id')::uuid AS user_id,
           (e.value ->> 'target_id')::uuid AS target_id,
           (e.value ->> 'social_account_id')::uuid AS social_account_id,
           (e.value ->> 'watchlist_id')::uuid AS watchlist_id,
           COALESCE((e.value ->> 'has_capability')::boolean, true) AS has_capability
      FROM jsonb_array_elements(v_window) AS e(value)
  LOOP
    v_scanned := v_scanned + 1;
    -- Every scanned id advances the cursor, including a refusal and an
    -- insert that conflicted. The cursor is how the next page moves on.
    v_last_scanned := v_candidate.target_id;

    -- A row whose account has NO capability row is SKIPPED, not refused: it
    -- consumes its slot in this page and the cursor moves past it, so the
    -- window stays bounded and the account is never counted twice.
    IF NOT v_candidate.has_capability THEN
      CONTINUE;
    END IF;

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

COMMENT ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) IS
  'Settles a claimed owner job as unavailable with the fixed reason '
  'capability_missing when its bound account never recorded a permission '
  'read. The accepted fence (without its context branch) locks and checks '
  'the claim, the lease, the target and the rollout admission; the bound '
  'context is then checked, the capability generation before its state. A '
  'context-less owner job whose account has NO capability row is settled the '
  'same way, once, so it cannot come back every lease; any other '
  'context-less job is refused with IG_COLLECTION_CONTEXT_MISSING. An '
  'absent or replaced capability refuses with IG_COLLECTION_CREDENTIAL_'
  'CHANGED, an ok read with IG_COLLECTION_CAPABILITY_RESOLVED. It never '
  'writes a capability, an account or a credential.';

COMMENT ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) IS
  'The non-retrying PostgREST boundary of complete_instagram_collection_job_'
  'capability_unavailable. The named collection refusals, including '
  'IG_COLLECTION_CAPABILITY_RESOLVED, are returned as PT409; every other '
  'error is raised unchanged.';

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
  'start or reopen. The evaluator is not part of the scan filter. The page '
  'reads a window of ids and decides the enrolment inside it, so an owner '
  'account with no capability row consumes its slot, is never enqueued and '
  'is audited as skipped; the receipt itself does not change.';

-- ===========================================================================
-- 3. The grants.
--
-- Service only. The browser roles may not execute these functions, and the
-- internal helpers they use stay unreachable for them as well.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job_capability_unavailable_http(uuid,uuid,bigint) TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_daily_page(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_daily_page(text, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
