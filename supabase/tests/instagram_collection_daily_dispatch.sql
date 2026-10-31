-- ============================================================================
-- supabase/tests/instagram_collection_daily_dispatch.sql
--
-- R2 (migration 20261031091000_instagram_collection_daily_dispatch.sql).
--
-- One transaction, synthetic fixtures, labelled ASSERTs, expected refusals in
-- nested BEGIN/EXCEPTION blocks, ROLLBACK, sentinel last. Fixture values are
-- synthetic ('...@example.invalid'); no secrets and no real accounts.
--
-- What this suite proves
--   D1  the sweep table: it exists, its states are constrained, RLS is on
--       and the browser roles cannot read a row of it.
--   D2  the daily page RPC is service only. The browser roles cannot
--       execute it, PUBLIC cannot execute it, and an ordinary session is
--       refused by the database itself.
--   D3  the page ceiling: twenty five owner targets and fifty competitor
--       targets, and the scan never exceeds it.
--   D4  more than twenty five owners: every eligible target ends up with
--       exactly ONE current-day job, across several bounded invocations.
--   D5  more than fifty competitors: the same, for the competitor
--       population.
--   D6  more than one thousand competitors: the completion spans many
--       bounded invocations and every eligible target is still enqueued
--       exactly once.
--   D7  a duplicate keeps its generation: an existing job is never reset,
--       never re-generated and never counted as newly enqueued.
--   D8  the exclusion wins at insert time: a target the policy does not
--       admit never gets a job, and a completed sweep never certifies it.
--   D9  the weekly retry gate is not bypassed: an entry that is waiting
--       for its weekly gate is not due.
--   D10 the states are reported truthfully: pending, completed and the
--       counters of the day.
--   D11 a disabled master and an unreadable configuration are DEFINITE
--       refusals, never an empty page.
--   D12 the atomicity: the page and its jobs commit together or neither.
--   D13 the current-day replay and the reopen: a repeated start is
--       idempotent and a reopen admits a newly approved target.
--   D14 the rollover: an unfinished sweep of an earlier capture day is
--       recorded expired, never silently completed.
--   D15 no-progress errors: a page that enqueued nothing says so, and it
--       never reports progress it did not make.
--   D16 a competitor page the evaluator refuses cannot stall the sweep.
--       Fifty refused watchlists sorted before one eligible watchlist are
--       passed, the eligible one is enqueued exactly once, and the day
--       completes inside a bounded number of pages.
--   D17 the same for owners: twenty five evaluator refusals sorted before
--       one eligible account cannot stall the owner sweep.
--   D18 a target that becomes eligible behind the cursor is not taken by
--       a resume and is not certified by a completed sweep. The next
--       start or reopen walks from the beginning and admits it.
--
-- The suite SET ROLEs away from superuser where the point of the check is
-- that a client role cannot do something, and it uses the house claim
-- convention (request.jwt.claim.role) for the service calls, which keeps the
-- session's own privileges. The service role bypasses RLS, so the ownership
-- checks and the composite foreign keys are the only thing under test there.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures. Written as superuser, where RLS does not apply.
--
-- u_a          : owner A, the pilot tenant
-- u_b          : owner B, the other tenant
-- acct_01..30  : owner A's thirty Instagram accounts (more than one page)
-- acct_b       : owner B's account (foreign)
-- viewer       : owner A's approved competitor viewer
-- comp_01..60  : owner A's sixty watchlist entries (more than one page)
-- comp_b       : owner B's watchlist entry (foreign)
--
-- The scale population (more than one thousand competitors) is inserted
-- later, in its own section, so the ordinary fixtures stay readable.
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  u_a    uuid := 'ad100000-0000-4000-8000-000000000001';
  u_b    uuid := 'bd100000-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (u_a, 'igdaily-owner-a@example.invalid'),
    (u_b, 'igdaily-owner-b@example.invalid');

  -- The tracked-competitor quota of the synthetic owners is UNLIMITED.
  --
  -- The plan entitlement caps a watchlist at five entries, and the guard
  -- runs on every insert. The scale population of this suite needs more
  -- than a thousand, so the synthetic entitlement is raised here - and only
  -- for the two synthetic owners, which the transaction rolls back.
  INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
  VALUES (u_a, -1), (u_b, -1)
  ON CONFLICT (user_id) DO UPDATE SET max_tracked_competitors = -1;

  -- Thirty owner accounts. More than one page of twenty five.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  SELECT
    ('ad200000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
    u_a,
    'instagram',
    'ig-daily-' || i,
    'igdaily_a' || i,
    'token-a-' || i,
    'facebook_page',
    true,
    false
  FROM generate_series(1, 30) AS i;

  -- The other tenant's account. It is an owned target of owner B, so the
  -- 'all' policy admits it: the sweep is GLOBAL, and the POLICY decides
  -- which targets are admitted, not the caller.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    ('bd200000-0000-4000-8000-000000000001', u_b, 'instagram',
     'ig-daily-b', 'igdaily_b', 'token-b', 'facebook_page', true, false);

  -- Sixty watchlist entries. More than one page of fifty.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  SELECT
    ('cd300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
    u_a,
    'instagram',
    'igdaily_c' || i
  FROM generate_series(1, 60) AS i;

  -- The other tenant's watchlist entry.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  VALUES ('cd300000-0000-4000-8000-0000000000ff', u_b, 'instagram', 'igdaily_cb');
END
$fixtures$;

-- The capture day the suite works on. The DATABASE chooses it; the suite
-- only reads it back, exactly like the dispatch does.
CREATE TEMP TABLE igdaily_ctx (
  label text PRIMARY KEY,
  value jsonb
) ON COMMIT DROP;

INSERT INTO igdaily_ctx (label, value)
SELECT 'captured_on', to_jsonb((now() AT TIME ZONE 'Asia/Kuwait')::date);

-- The master kill switch. It is off by absence, so the suite turns it on
-- explicitly: the rollout is proved against an ENABLED master.
INSERT INTO public.app_settings (key, value, description)
VALUES ('collection_instagram_insights_enabled', 'true'::jsonb,
        'Synthetic harness master switch for the daily dispatch suite.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- The policy helper. It installs a policy document for the duration of the
-- transaction. An empty list is the documented 'all' shape.
CREATE OR REPLACE FUNCTION pg_temp.igdaily_policy(
  p_owners      text,
  p_competitors text
) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', p_owners, 'account_ids',
      CASE WHEN p_owners = 'allowlist'
           THEN jsonb_build_array('ad200000-0000-4000-8000-000000000001'::text)
           ELSE '[]'::jsonb END),
    'competitors', jsonb_build_object('mode', p_competitors, 'targets',
      CASE WHEN p_competitors = 'allowlist'
           THEN jsonb_build_array(jsonb_build_object(
                  'watchlist_id', 'cd300000-0000-4000-8000-000000000001'::text,
                  'viewer_social_account_id', 'ed100000-0000-4000-8000-000000000001'::text))
           ELSE '[]'::jsonb END)
  );
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.igdaily_set_policy(p_policy jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.app_settings (key, value, description)
  VALUES ('collection_instagram_rollout_policy', p_policy, 'Synthetic harness policy.')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END
$fn$;

-- A policy that admits exactly the named owner accounts.
CREATE OR REPLACE FUNCTION pg_temp.igdaily_owner_policy(p_ids text[])
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'allowlist',
      'account_ids', to_jsonb(p_ids)),
    'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)
  );
$fn$;

-- The service call. The house claim convention keeps the session's own
-- privileges, so the function is exercised as the service role would
-- exercise it.
CREATE OR REPLACE FUNCTION pg_temp.igdaily_page(
  p_kind  text,
  p_start boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.enqueue_instagram_collection_daily_page(p_kind, p_start);
  PERFORM set_config('request.jwt.claim.role', '', true);
  RETURN v_result;
END
$fn$;

-- The accepted populations for the ordinary fixtures.
SELECT pg_temp.igdaily_set_policy(pg_temp.igdaily_policy('all', 'all'));

-- ===========================================================================
-- D1 - the sweep table.
-- ===========================================================================
DO $d1$
DECLARE
  v_relrowsecurity boolean;
  v_anon_select boolean;
  v_auth_select boolean;
  v_auth_insert boolean;
  v_service_select boolean;
BEGIN
  SELECT c.relrowsecurity INTO v_relrowsecurity
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'instagram_collection_enqueue_sweeps';

  ASSERT v_relrowsecurity, 'D1 the sweep table has RLS enabled';

  SELECT has_table_privilege('anon', 'public.instagram_collection_enqueue_sweeps', 'SELECT')
    INTO v_anon_select;
  SELECT has_table_privilege('authenticated', 'public.instagram_collection_enqueue_sweeps', 'SELECT')
    INTO v_auth_select;
  SELECT has_table_privilege('authenticated', 'public.instagram_collection_enqueue_sweeps', 'INSERT')
    INTO v_auth_insert;
  SELECT has_table_privilege('service_role', 'public.instagram_collection_enqueue_sweeps', 'SELECT')
    INTO v_service_select;

  ASSERT NOT v_anon_select, 'D1 the browser role cannot read the sweep table';
  ASSERT NOT v_auth_select, 'D1 an ordinary session cannot read the sweep table';
  ASSERT NOT v_auth_insert, 'D1 an ordinary session cannot write the sweep table';
  -- The service role is a privileged dispatch caller and keeps the table
  -- privilege the default privileges give it, exactly like every other
  -- service-owned table in this schema.
  ASSERT v_service_select, 'D1 the service role may read the sweep table';

  -- The states are constrained. The CHECK constraints are the boundary, so
  -- an unknown state can never be stored.
  BEGIN
    INSERT INTO public.instagram_collection_enqueue_sweeps (target_kind, captured_on, status)
    VALUES ('owner', current_date, 'unknown-state');
    RAISE EXCEPTION 'D1 an unknown sweep state was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.instagram_collection_enqueue_sweeps (target_kind, captured_on, status)
    VALUES ('unknown-kind', current_date, 'pending');
    RAISE EXCEPTION 'D1 an unknown target kind was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- One row per (kind, capture day).
  INSERT INTO public.instagram_collection_enqueue_sweeps (target_kind, captured_on, status)
  VALUES ('owner', current_date, 'pending');
  BEGIN
    INSERT INTO public.instagram_collection_enqueue_sweeps (target_kind, captured_on, status)
    VALUES ('owner', current_date, 'pending');
    RAISE EXCEPTION 'D1 a second sweep row was stored for the same kind and day';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  DELETE FROM public.instagram_collection_enqueue_sweeps WHERE captured_on = current_date;
END
$d1$;

-- ===========================================================================
-- D2 - the ACL of the daily page.
-- ===========================================================================
DO $d2$
DECLARE
  v_anon_exec    boolean;
  v_auth_exec    boolean;
  v_service_exec boolean;
  v_public_cannot boolean;
  v_arity        integer;
BEGIN
  SELECT has_function_privilege('anon',
           'public.enqueue_instagram_collection_daily_page(text,boolean)', 'EXECUTE')
    INTO v_anon_exec;
  SELECT has_function_privilege('authenticated',
           'public.enqueue_instagram_collection_daily_page(text,boolean)', 'EXECUTE')
    INTO v_auth_exec;
  SELECT has_function_privilege('service_role',
           'public.enqueue_instagram_collection_daily_page(text,boolean)', 'EXECUTE')
    INTO v_service_exec;

  -- PUBLIC is not a role, so the grant to PUBLIC is read from the ACL
  -- itself: grantee 0 IS PUBLIC.
  SELECT NOT EXISTS (
           SELECT 1
             FROM pg_proc AS p
             JOIN pg_namespace AS n ON n.oid = p.pronamespace
             CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner)))
                                AS a
            WHERE n.nspname = 'public'
              AND p.proname = 'enqueue_instagram_collection_daily_page'
              AND a.grantee = 0
              AND a.privilege_type = 'EXECUTE'
         )
    INTO v_public_cannot;

  ASSERT NOT v_anon_exec, 'D2 the browser role cannot execute the daily page';
  ASSERT NOT v_auth_exec, 'D2 an ordinary session cannot execute the daily page';
  ASSERT v_public_cannot, 'D2 PUBLIC cannot execute the daily page';
  ASSERT v_service_exec, 'D2 the service role can execute the daily page';

  -- The daily page has NO owner, account, date, cursor or limit argument:
  -- the caller cannot select the capture day or the page size.
  SELECT count(*) INTO v_arity
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'enqueue_instagram_collection_daily_page'
     AND p.pronargs = 2;

  ASSERT v_arity = 1, 'D2 the daily page takes exactly the kind and the start marker';
END
$d2$;

-- The database itself refuses an ordinary session. The GRANT is the
-- outermost shell and the service role is the only holder.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', 'ad100000-0000-4000-8000-000000000001', true);

DO $d2_client$
BEGIN
  BEGIN
    PERFORM public.enqueue_instagram_collection_daily_page('owner', true);
    RAISE EXCEPTION 'D2 an ordinary session executed the daily page';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$d2_client$;

RESET ROLE;

-- ===========================================================================
-- D3 - the page ceiling.
-- ===========================================================================
DO $d3$
DECLARE
  v_day  date;
  v_page jsonb;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  v_page := pg_temp.igdaily_page('owner', true);

  ASSERT v_page ->> 'accepted' = 'true', 'D3 the page was accepted';
  ASSERT v_page ->> 'page_limit' = '25', 'D3 the owner page is twenty five targets';
  ASSERT (v_page ->> 'scanned')::integer <= 25, 'D3 the owner scan is bounded by the page';
  ASSERT (v_page ->> 'enqueued')::integer <= 25, 'D3 the owner page enqueues at most twenty five';
  ASSERT v_page ->> 'sweep_status' = 'pending', 'D3 a full page leaves the sweep pending';
  ASSERT v_page ->> 'has_more' = 'true', 'D3 a full page reports that progress remains';
  ASSERT v_page ->> 'started' = 'true', 'D3 the start reports that it started the sweep';
  ASSERT v_page ->> 'resumed' = 'false', 'D3 the start is not a resume';

  -- The competitor page is fifty.
  v_page := pg_temp.igdaily_page('competitor', true);
  ASSERT v_page ->> 'page_limit' = '50', 'D3 the competitor page is fifty targets';
  ASSERT (v_page ->> 'scanned')::integer <= 50, 'D3 the competitor scan is bounded by the page';

  -- An unknown kind is refused by the statement, not by a silent no-op.
  BEGIN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM public.enqueue_instagram_collection_daily_page('unknown-kind', true);
    RAISE EXCEPTION 'D3 an unknown target kind was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claim.role', '', true);

  -- The ceiling section leaves no state behind: the sections that follow
  -- count the pages of their own population from the beginning.
  DELETE FROM public.instagram_collection_jobs WHERE captured_on = v_day;
  DELETE FROM public.instagram_collection_enqueue_sweeps WHERE captured_on = v_day;
END
$d3$;

-- ===========================================================================
-- D4 - more than twenty five owners, across several bounded invocations.
--
-- Thirty accounts, a page of twenty five: the first page enqueues twenty
-- five and the second enqueues the remaining five and COMPLETES the day.
-- This loop passes p_start = true on every call, which reopens the day
-- and walks from the beginning. The anti-join is what skips a target
-- that already has a job, so the rewalk still reaches the ones that do
-- not. A resume of a pending sweep does not rewalk: it continues from
-- the keyset cursor (D16-D18).
-- ===========================================================================
DO $d4$
DECLARE
  v_day      date;
  v_page     jsonb;
  v_jobs     integer;
  v_distinct integer;
  v_status   text;
  v_pages    integer := 0;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  LOOP
    v_page := pg_temp.igdaily_page('owner', true);
    v_pages := v_pages + 1;
    EXIT WHEN (v_page ->> 'has_more')::boolean IS NOT TRUE;
    EXIT WHEN v_pages > 10;
  END LOOP;

  SELECT count(*), count(DISTINCT target_id)
    INTO v_jobs, v_distinct
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND captured_on = v_day;

  -- Thirty of owner A's accounts and owner B's one: the sweep is GLOBAL and
  -- the POLICY decides which targets are admitted.
  ASSERT v_jobs = 31, 'D4 every eligible owner target has exactly one current-day job';
  ASSERT v_distinct = 31, 'D4 no owner target has two current-day jobs';
  ASSERT v_pages >= 2, 'D4 a population larger than one page needs several invocations';

  -- The last page was not full, so the day is finished.
  ASSERT v_page ->> 'sweep_status' = 'completed',
    'D4 a page that did not fill completes the day';
  ASSERT v_page ->> 'has_more' = 'false',
    'D4 a finished day reports that no progress remains';

  -- The sweep never reaches into another owner's rows: the owner of every
  -- enqueued target is the owner of the target row itself.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = 'owner'
       AND j.captured_on = v_day
       AND j.user_id <> (SELECT sa.user_id FROM public.social_accounts AS sa
                          WHERE sa.id = j.target_id)
  ), 'D4 every enqueued owner job belongs to the owner of its target';

  -- The scan never exceeded the ceiling.
  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT (v_page ->> 'scanned')::integer <= 25,
    'D4 the scan is bounded by the page limit';

  SELECT s.status INTO v_status
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day;
  ASSERT v_status = 'completed', 'D4 the day is completed once every target is enqueued';
END
$d4$;

-- ===========================================================================
-- D5 - more than fifty competitors, across several bounded invocations.
-- ===========================================================================
DO $d5$
DECLARE
  v_day      date;
  v_page     jsonb;
  v_jobs     integer;
  v_distinct integer;
  v_pages    integer := 0;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  LOOP
    v_page := pg_temp.igdaily_page('competitor', true);
    v_pages := v_pages + 1;
    EXIT WHEN (v_page ->> 'has_more')::boolean IS NOT TRUE;
    EXIT WHEN v_pages > 10;
  END LOOP;

  SELECT count(*), count(DISTINCT target_id)
    INTO v_jobs, v_distinct
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND captured_on = v_day;

  ASSERT v_jobs = 61, 'D5 every eligible competitor target has exactly one current-day job';
  ASSERT v_distinct = 61, 'D5 no competitor target has two current-day jobs';
  ASSERT v_pages >= 2, 'D5 a population larger than one page needs several invocations';

  -- The sweep never reaches into another owner's rows.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = 'competitor'
       AND j.captured_on = v_day
       AND j.user_id <> (SELECT cw.user_id FROM public.competitor_watchlist AS cw
                          WHERE cw.id = j.target_id)
  ), 'D5 every enqueued competitor job belongs to the owner of its target';
END
$d5$;

-- ===========================================================================
-- D6 - more than one thousand competitors.
--
-- The completion spans many bounded invocations, and every eligible target
-- is still enqueued exactly once. This loop reopens on every call. The
-- anti-join skips targets that already have a job, so the rewalk is still
-- bounded and still finishes. It is not a volatile process cursor: a
-- resume continues from the cursor stored on the sweep row.
-- ===========================================================================
DO $d6$
DECLARE
  v_day      date;
  v_page     jsonb;
  v_jobs     integer;
  v_distinct integer;
  v_pages    integer := 0;
  v_bounded  boolean := true;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- One thousand and forty more competitors for owner A.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  SELECT
    ('dd300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
    'ad100000-0000-4000-8000-000000000001',
    'instagram',
    'igdaily_d' || i
  FROM generate_series(1, 1040) AS i;

  LOOP
    v_page := pg_temp.igdaily_page('competitor', true);
    v_pages := v_pages + 1;

    IF (v_page ->> 'scanned')::integer > 50 THEN
      v_bounded := false;
    END IF;

    EXIT WHEN (v_page ->> 'has_more')::boolean IS NOT TRUE;
    EXIT WHEN v_pages > 100;
  END LOOP;

  ASSERT v_bounded, 'D6 every page of the large population stayed inside the ceiling';
  ASSERT v_pages >= 21, 'D6 a population larger than one thousand spans many bounded invocations';

  SELECT count(*), count(DISTINCT target_id)
    INTO v_jobs, v_distinct
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND captured_on = v_day;

  ASSERT v_jobs = 1101, 'D6 every eligible competitor target has exactly one current-day job';
  ASSERT v_distinct = 1101, 'D6 no competitor target has two current-day jobs';

  -- The statement timeout the statement set is local to the transaction, so
  -- the rest of the suite runs with the server's own default.
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM set_config('lock_timeout', '0', true);
END
$d6$;

-- ===========================================================================
-- D7 - a duplicate keeps its generation.
-- ===========================================================================
DO $d7$
DECLARE
  v_day        date;
  v_target     uuid := 'ad200000-0000-4000-8000-000000000001';
  v_generation bigint;
  v_status     text;
  v_attempts   integer;
  v_page       jsonb;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- The job already exists from D4. It is forced to a revision and a
  -- status, and a page must leave both exactly as they are.
  UPDATE public.instagram_collection_jobs
     SET job_generation = 7,
         status = 'completed',
         attempts = 3,
         last_success_at = now()
   WHERE target_kind = 'owner'
     AND target_id = v_target
     AND captured_on = v_day;

  v_page := pg_temp.igdaily_page('owner', true);

  SELECT job_generation, status, attempts
    INTO v_generation, v_status, v_attempts
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND target_id = v_target
     AND captured_on = v_day;

  ASSERT v_generation = 7, 'D7 a duplicate keeps its generation';
  ASSERT v_status = 'completed', 'D7 a duplicate never resets a completed job';
  ASSERT v_attempts = 3, 'D7 a duplicate never touches the attempts';

  -- The duplicate is not counted as newly enqueued: the anti-join removed
  -- it from the candidate set.
  ASSERT (v_page ->> 'enqueued')::integer = 0,
    'D7 a duplicate is not counted as a newly enqueued row';

  -- And the accepted-request throttle window is NOT spent by the daily page.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_request_throttles
     WHERE target_kind = 'owner' AND target_id = v_target
  ), 'D7 the daily page spends no accepted-request throttle window';
END
$d7$;

-- ===========================================================================
-- D8 - the exclusion wins at insert time.
-- ===========================================================================
DO $d8$
DECLARE
  v_day   date;
  v_page  jsonb;
  v_jobs  integer;
  v_status text;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- A NEW account of owner A that no policy admits yet, and a NEW account
  -- of owner B that no policy will ever admit.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    ('ad200000-0000-4000-8000-0000000000aa', 'ad100000-0000-4000-8000-000000000001',
     'instagram', 'ig-daily-aa', 'igdaily_aa', 'token-aa', 'facebook_page', true, false),
    ('bd200000-0000-4000-8000-0000000000bb', 'bd100000-0000-4000-8000-000000000002',
     'instagram', 'ig-daily-bb', 'igdaily_bb', 'token-bb', 'facebook_page', true, false);

  -- The policy admits exactly ONE account: owner A's new one. The other
  -- tenant's new account is not on the list, so it is not even a candidate.
  PERFORM pg_temp.igdaily_set_policy(pg_temp.igdaily_owner_policy(
    ARRAY['ad200000-0000-4000-8000-0000000000aa'::text]));

  v_page := pg_temp.igdaily_page('owner', true);

  ASSERT v_page ->> 'accepted' = 'true', 'D8 the page was accepted';
  ASSERT (v_page ->> 'enqueued')::integer = 1,
    'D8 the page enqueued exactly the admitted target';
  ASSERT (v_page ->> 'scanned')::integer = 1,
    'D8 an excluded target is not even a candidate';

  -- The exclusion WINS: the other tenant's new account has no job at all.
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'owner'
       AND target_id = 'bd200000-0000-4000-8000-0000000000bb'
       AND captured_on = v_day
  ), 'D8 an excluded target never gets a job';

  -- The competitor population is off, so no competitor job was created by
  -- this call. The jobs from D5 and D6 are untouched.
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND captured_on = v_day;
  ASSERT v_jobs = 1101, 'D8 an off competitor population is never touched';

  -- The day is finished: the page was not full.
  SELECT s.status INTO v_status
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day;
  ASSERT v_status = 'completed', 'D8 the owner day is completed';

  -- A target that becomes eligible AFTER the completed sweep waits for
  -- another explicit start: the completed sweep never certifies it. A
  -- target that becomes eligible BEHIND a pending sweep's cursor is the
  -- same rule, proved in D18: resume does not go backwards, and only the
  -- next start or reopen walks from the beginning.
  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    ('ad200000-0000-4000-8000-0000000000bb', 'ad100000-0000-4000-8000-000000000001',
     'instagram', 'ig-daily-bb', 'igdaily_bb', 'token-bb', 'facebook_page', true, false);

  PERFORM pg_temp.igdaily_set_policy(pg_temp.igdaily_owner_policy(ARRAY[
    'ad200000-0000-4000-8000-0000000000aa'::text,
    'ad200000-0000-4000-8000-0000000000bb'::text]));

  -- A RESUME never starts a sweep and never admits a later target.
  v_page := pg_temp.igdaily_page('owner', false);
  ASSERT (v_page ->> 'enqueued')::integer = 0,
    'D8 a resume of a completed sweep enqueues nothing';
  ASSERT v_page ->> 'sweep_status' = 'completed',
    'D8 a resume of a completed sweep reports the completed state';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'owner'
       AND target_id = 'ad200000-0000-4000-8000-0000000000bb'
       AND captured_on = v_day
  ), 'D8 a completed sweep never certifies a later-added target as collected';

  -- An explicit START reopens the day and admits it.
  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT (v_page ->> 'enqueued')::integer = 1,
    'D8 an explicit start admits a newly approved target';
  ASSERT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'owner'
       AND target_id = 'ad200000-0000-4000-8000-0000000000bb'
       AND captured_on = v_day
  ), 'D8 the newly approved target has exactly one current-day job';

  -- The wide policy is restored for the sections that follow.
  PERFORM pg_temp.igdaily_set_policy(pg_temp.igdaily_policy('all', 'all'));
END
$d8$;

-- ===========================================================================
-- D9 - the weekly retry gate is not bypassed.
-- ===========================================================================
DO $d9$
DECLARE
  v_day date;
  v_jobs integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- Two more watchlist entries of owner A: one is waiting for its weekly
  -- gate, the other one's gate has passed.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username, next_retry_at)
  VALUES
    ('dd300000-0000-4000-8000-0000000000a1', 'ad100000-0000-4000-8000-000000000001',
     'instagram', 'igdaily_gated', now() + interval '3 days'),
    ('dd300000-0000-4000-8000-0000000000a2', 'ad100000-0000-4000-8000-000000000001',
     'instagram', 'igdaily_due', now() - interval '1 day');

  PERFORM pg_temp.igdaily_page('competitor', true);

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'competitor'
       AND target_id = 'dd300000-0000-4000-8000-0000000000a1'
       AND captured_on = v_day
  ), 'D9 the weekly retry gate is not bypassed';

  ASSERT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'competitor'
       AND target_id = 'dd300000-0000-4000-8000-0000000000a2'
       AND captured_on = v_day
  ), 'D9 an entry whose weekly gate has passed is due';

  -- An INACTIVE entry is never a candidate either.
  INSERT INTO public.competitor_watchlist (id, user_id, platform, username, is_active, removed_at)
  VALUES ('dd300000-0000-4000-8000-0000000000a3', 'ad100000-0000-4000-8000-000000000001',
          'instagram', 'igdaily_inactive', false, now());

  PERFORM pg_temp.igdaily_page('competitor', true);

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE target_kind = 'competitor'
       AND target_id = 'dd300000-0000-4000-8000-0000000000a3'
       AND captured_on = v_day
  ), 'D9 an inactive entry is never enqueued';

  SELECT count(*) INTO v_jobs FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor' AND captured_on = v_day;
  ASSERT v_jobs = 1102, 'D9 the gated and the inactive entries changed nothing';
END
$d9$;

-- ===========================================================================
-- D10 - the states are reported truthfully.
-- ===========================================================================
DO $d10$
DECLARE
  v_day      date;
  v_page     jsonb;
  v_status   text;
  v_page_cnt integer;
  v_enq_cnt  integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- The competitor day is finished, so a RESUME reports the completed state
  -- and enqueues nothing.
  v_page := pg_temp.igdaily_page('competitor', false);
  ASSERT v_page ->> 'sweep_status' = 'completed',
    'D10 a resume of a finished day reports the completed state';
  ASSERT v_page ->> 'has_more' = 'false',
    'D10 a finished day reports that no progress remains';
  ASSERT (v_page ->> 'enqueued')::integer = 0,
    'D10 a resume of a finished day enqueues nothing';

  -- The counters of the day are persisted, and they are counts of INSERTED
  -- rows.
  SELECT s.status, s.page_count, s.enqueued_count
    INTO v_status, v_page_cnt, v_enq_cnt
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'competitor' AND s.captured_on = v_day;

  ASSERT v_status = 'completed', 'D10 the competitor sweep is completed';
  ASSERT v_page_cnt >= 22, 'D10 the page counter records every bounded invocation';
  ASSERT v_enq_cnt = 1102, 'D10 the enqueued counter counts the inserted rows';
END
$d10$;

-- ===========================================================================
-- D11 - a disabled master and an unreadable configuration.
-- ===========================================================================
DO $d11$
DECLARE
  v_page   jsonb;
  v_reason text;
BEGIN
  -- A false master refuses with the DEFINITE reason. It is never an empty
  -- page and never a completion.
  UPDATE public.app_settings
     SET value = 'false'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';

  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT v_page ->> 'accepted' = 'false', 'D11 a disabled master refuses the page';
  ASSERT v_page ->> 'refused' = 'true', 'D11 the refusal is marked as one';
  v_reason := v_page ->> 'reason_code';
  ASSERT v_reason = 'collection_disabled', 'D11 the refusal carries the collection_disabled reason';

  -- The refusal is audited, and the audit row commits with it.
  ASSERT EXISTS (
    SELECT 1 FROM public.system_logs
     WHERE source = 'instagram-collection-rollout'
       AND metadata ->> 'event' = 'collection_daily_enqueue_refused'
  ), 'D11 the refusal wrote its audit row';

  -- A malformed configuration is unavailable, which is a DIFFERENT refusal.
  UPDATE public.app_settings
     SET value = 'true'::jsonb
   WHERE key = 'collection_instagram_insights_enabled';
  PERFORM pg_temp.igdaily_set_policy('{"version":1,"owners":{"mode":"nonsense"}}'::jsonb);

  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT v_page ->> 'accepted' = 'false', 'D11 a malformed policy refuses the page';
  v_reason := v_page ->> 'reason_code';
  ASSERT v_reason = 'settings_unavailable',
    'D11 the malformed configuration carries the settings_unavailable reason';

  -- A MISSING policy means off, not unavailable.
  DELETE FROM public.app_settings WHERE key = 'collection_instagram_rollout_policy';
  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT v_page ->> 'accepted' = 'true', 'D11 a missing policy is not an unavailable configuration';
  ASSERT (v_page ->> 'enqueued')::integer = 0,
    'D11 a missing policy admits nobody';

  PERFORM pg_temp.igdaily_set_policy(pg_temp.igdaily_policy('all', 'all'));
END
$d11$;

-- ===========================================================================
-- D12 - the atomicity: the page and its jobs commit together or neither.
-- ===========================================================================
DO $d12$
DECLARE
  v_day   date;
  v_before integer;
  v_after  integer;
  v_sweeps integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  SELECT count(*) INTO v_before
    FROM public.instagram_collection_jobs WHERE captured_on = v_day;
  SELECT count(*) INTO v_sweeps
    FROM public.instagram_collection_enqueue_sweeps WHERE captured_on = v_day;

  -- The caller crashes AFTER the page ran. The sub-transaction rolls back,
  -- so neither the jobs nor the sweep row survive.
  BEGIN
    PERFORM pg_temp.igdaily_page('owner', true);
    RAISE EXCEPTION 'the caller crashed after the page';
  EXCEPTION WHEN others THEN
    NULL;
  END;

  SELECT count(*) INTO v_after
    FROM public.instagram_collection_jobs WHERE captured_on = v_day;

  ASSERT v_after = v_before, 'D12 a failure after the page rolls the page back';
  ASSERT (SELECT count(*) FROM public.instagram_collection_enqueue_sweeps
           WHERE captured_on = v_day) = v_sweeps,
    'D12 the sweep row rolls back with the jobs';

  -- The next call reconciles from the persisted state: the day is still
  -- there and the page simply runs again.
  PERFORM pg_temp.igdaily_page('owner', true);
  ASSERT (SELECT count(*) FROM public.instagram_collection_jobs
           WHERE captured_on = v_day) >= v_before,
    'D12 the next call reconciles by the persisted state';
END
$d12$;

-- ===========================================================================
-- D13 - the current-day replay and the reopen.
-- ===========================================================================
DO $d13$
DECLARE
  v_day      date;
  v_page     jsonb;
  v_jobs     integer;
  v_start_at timestamptz;
  v_again_at timestamptz;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  SELECT s.started_at INTO v_start_at
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day;

  -- A REPLAY of the same day is idempotent: nothing new is enqueued and no
  -- job is touched.
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs WHERE captured_on = v_day;

  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT (v_page ->> 'enqueued')::integer = 0,
    'D13 a replay of a finished day enqueues nothing';
  ASSERT (SELECT count(*) FROM public.instagram_collection_jobs
           WHERE captured_on = v_day) = v_jobs,
    'D13 a replay changes no job';

  -- The start timestamp of the day is kept: the row is the record of the
  -- day, not of the last call.
  SELECT s.started_at INTO v_again_at
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day;
  ASSERT v_again_at = v_start_at, 'D13 a reopen keeps the start of the day';

  -- A resume of a pending sweep is a resume, not a start.
  UPDATE public.instagram_collection_enqueue_sweeps
     SET status = 'pending', completed_at = NULL
   WHERE target_kind = 'owner' AND captured_on = v_day;

  v_page := pg_temp.igdaily_page('owner', false);
  ASSERT v_page ->> 'resumed' = 'true', 'D13 a resume reports that it resumed';
  ASSERT v_page ->> 'started' = 'false', 'D13 a resume never reports a start';
END
$d13$;

-- ===========================================================================
-- D14 - the rollover.
--
-- An unfinished sweep of an EARLIER capture day is recorded expired. It is
-- never silently completed and no historical observation is fabricated.
-- ===========================================================================
DO $d14$
DECLARE
  v_day    date;
  v_status  text;
  v_reason text;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  INSERT INTO public.instagram_collection_enqueue_sweeps
    (target_kind, captured_on, status, started_at, updated_at)
  VALUES ('owner', v_day - 1, 'pending', now() - interval '1 day', now() - interval '1 day');

  PERFORM pg_temp.igdaily_page('owner', true);

  SELECT s.status, s.last_reason_code INTO v_status, v_reason
    FROM public.instagram_collection_enqueue_sweeps AS s
   WHERE s.target_kind = 'owner' AND s.captured_on = v_day - 1;

  ASSERT v_status = 'expired', 'D14 an unfinished sweep of an earlier day is expired';
  ASSERT v_reason = 'capture_day_rolled_over',
    'D14 the expired sweep carries the reason it did not finish';
  ASSERT v_status <> 'completed',
    'D14 an unfinished sweep is never silently marked completed';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.instagram_collection_jobs
     WHERE captured_on = v_day - 1
  ), 'D14 the rollover never fabricates a historical observation';
END
$d14$;

-- ===========================================================================
-- D15 - no-progress errors.
--
-- A page that enqueues nothing says so, and it never reports progress it
-- did not make. A page whose candidates are all excluded reports zero
-- enqueued rows and completes the day.
-- ===========================================================================
DO $d15$
DECLARE
  v_day  date;
  v_page jsonb;
  v_jobs integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- Every owner account of owner A already has a current-day job, so the
  -- page has nothing to do.
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND user_id = 'ad100000-0000-4000-8000-000000000001'
     AND captured_on = v_day;

  v_page := pg_temp.igdaily_page('owner', true);
  ASSERT (v_page ->> 'enqueued')::integer = 0, 'D15 a page with no work reports zero';
  ASSERT (v_page ->> 'scanned')::integer = 0, 'D15 a page with no work scans nothing';
  ASSERT v_page ->> 'has_more' = 'false', 'D15 a page with no work reports no progress';
  ASSERT v_page ->> 'sweep_status' = 'completed', 'D15 a page with no work completes the day';

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND user_id = 'ad100000-0000-4000-8000-000000000001'
     AND captured_on = v_day;
  ASSERT v_jobs >= 32, 'D15 the existing jobs are untouched by a page with no work';

  -- The sweep never reports a progress it did not make: the enqueued count
  -- of the day is the number of inserted rows.
  ASSERT (
    SELECT s.enqueued_count = (
      SELECT count(*) FROM public.instagram_collection_jobs
       WHERE target_kind = 'owner'
         AND captured_on = v_day)
    FROM public.instagram_collection_enqueue_sweeps AS s
    WHERE s.target_kind = 'owner' AND s.captured_on = v_day
  ), 'D15 the recorded count is the count of inserted rows';
END
$d15$;

-- The correction tests record every failed condition and keep going, so one
-- run shows the competitor stall and the owner stall together. A failure
-- still aborts this transaction through the report block below.
CREATE TEMP TABLE igdaily_failures (
  label text PRIMARY KEY,
  detail text NOT NULL
) ON COMMIT DROP;

-- ===========================================================================
-- D16 - a refused competitor prefix cannot stall the sweep.
--
-- The pre-filter admits an allowlisted, active, due watchlist. The
-- evaluator then refuses it when the pinned viewer is not an Instagram
-- account of the same owner. Fifty of those, sorted before one watchlist
-- whose viewer does belong to the owner, used to fill every page. The
-- anti-join never moved, because a refusal inserts no job.
-- ===========================================================================
DO $d16$
DECLARE
  u_a uuid := 'ad100000-0000-4000-8000-000000000001';
  v_bad_viewer uuid := 'bd200000-0000-4000-8000-000000000001';
  v_good_viewer uuid := 'ee160000-0000-4000-8000-000000000051';
  v_eligible uuid := 'c0e16000-0000-4000-8000-000000000051';
  v_day date;
  v_page jsonb;
  v_pages integer := 0;
  v_jobs integer;
  v_targets jsonb := '[]'::jsonb;
  v_errors text := '';
  i integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    (v_good_viewer, u_a, 'instagram', 'ig-d16-viewer', 'igd16viewer',
     'token-d16-viewer', 'facebook_page', true, false);

  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  SELECT ('c0e16000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         u_a,
         'instagram',
         'igst16' || lpad(n::text, 2, '0')
    FROM generate_series(1, 51) AS n;

  FOR i IN 1..51 LOOP
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'watchlist_id', ('c0e16000-0000-4000-8000-' || lpad(i::text, 12, '0')),
      'viewer_social_account_id',
        CASE WHEN i = 51 THEN v_good_viewer::text ELSE v_bad_viewer::text END));
  END LOOP;

  PERFORM pg_temp.igdaily_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'off', 'account_ids', '[]'::jsonb),
    'competitors', jsonb_build_object('mode', 'allowlist', 'targets', v_targets)));

  LOOP
    v_page := pg_temp.igdaily_page('competitor', v_pages = 0);
    v_pages := v_pages + 1;
    IF (v_page ->> 'scanned')::integer > 50 THEN
      v_errors := v_errors || ' page ' || v_pages::text || ' scanned '
        || (v_page ->> 'scanned') || ';';
    END IF;
    EXIT WHEN COALESCE((v_page ->> 'has_more')::boolean, false) IS NOT TRUE;
    EXIT WHEN v_pages >= 4;
  END LOOP;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND target_id = v_eligible
     AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 1 THEN
    v_errors := v_errors || ' eligible jobs=' || COALESCE(v_jobs::text, 'null')
      || ' want 1;';
  END IF;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND captured_on = v_day
     AND target_id IN (
       SELECT ('c0e16000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
         FROM generate_series(1, 50) AS n);
  IF v_jobs IS DISTINCT FROM 0 THEN
    v_errors := v_errors || ' refused jobs=' || v_jobs::text || ' want 0;';
  END IF;

  IF v_page ->> 'sweep_status' IS DISTINCT FROM 'completed'
     OR COALESCE((v_page ->> 'has_more')::boolean, true) THEN
    v_errors := v_errors || ' status=' || COALESCE(v_page ->> 'sweep_status', 'null')
      || ' has_more=' || COALESCE(v_page ->> 'has_more', 'null')
      || ' pages=' || v_pages::text || ';';
  END IF;

  IF v_pages > 3 THEN
    v_errors := v_errors || ' pages=' || v_pages::text || ' want <= 3;';
  END IF;

  IF v_errors = '' THEN
    IF (
      SELECT s.last_target_id
        FROM public.instagram_collection_enqueue_sweeps AS s
       WHERE s.target_kind = 'competitor' AND s.captured_on = v_day
    ) IS DISTINCT FROM v_eligible THEN
      v_errors := v_errors || ' cursor did not stop on the eligible watchlist;';
    END IF;
  END IF;

  IF v_errors <> '' THEN
    RAISE EXCEPTION 'D16 %', v_errors;
  END IF;
EXCEPTION WHEN others THEN
  INSERT INTO igdaily_failures (label, detail) VALUES ('D16', SQLERRM);
END
$d16$;

-- ===========================================================================
-- D17 - a refused owner prefix cannot stall the sweep.
--
-- The owner evaluator admits every active Instagram account the pre-filter
-- selects: the population check and the ownership check are the same
-- predicate, so a static policy cannot refuse an owner row the page
-- already chose. The block below installs a transaction-local refusal for
-- twenty five ids that still pass is_active, platform and mode 'all'.
-- That is the same allowed=false branch the page already takes. The
-- rename is undone when this transaction rolls back.
--
-- Mode 'all' also admits the earlier fixture accounts, and those sort
-- after this prefix. A correct cursor therefore finishes on the last
-- scanned id of the completing page, which is at or past the eligible
-- account, not necessarily equal to it. The assertion below requires
-- that move. Narrowing the policy to this prefix alone would hide the
-- accounts the production 'all' scan still has to walk.
-- ===========================================================================
DO $d17$
DECLARE
  u_a uuid := 'ad100000-0000-4000-8000-000000000001';
  v_eligible uuid := 'a0d17000-0000-4000-8000-000000000026';
  v_day date;
  v_page jsonb;
  v_pages integer := 0;
  v_jobs integer;
  v_cursor uuid;
  v_errors text := '';
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  -- A real table, not a temporary one: the evaluator is SECURITY DEFINER
  -- and must be able to see the refusal list. This transaction rolls the
  -- table back with the function rename.
  CREATE TABLE public.igdaily_owner_refused (id uuid PRIMARY KEY);
  INSERT INTO public.igdaily_owner_refused (id)
  SELECT ('a0d17000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
    FROM generate_series(1, 25) AS n;

  ALTER FUNCTION public.ig_collection_rollout_owner_allowed(uuid, uuid, jsonb)
    RENAME TO ig_collection_rollout_owner_allowed_d17_orig;

  CREATE FUNCTION public.ig_collection_rollout_owner_allowed(
    p_user_id uuid,
    p_target_id uuid,
    p_state jsonb
  ) RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF EXISTS (
      SELECT 1
        FROM public.igdaily_owner_refused AS r
       WHERE r.id = p_target_id
    ) THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'reason_code', 'collection_not_eligible',
        'fingerprint', p_state ->> 'fingerprint');
    END IF;

    RETURN public.ig_collection_rollout_owner_allowed_d17_orig(
      p_user_id, p_target_id, p_state);
  END;
  $fn$;

  REVOKE ALL ON FUNCTION public.ig_collection_rollout_owner_allowed(uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated, service_role;

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  SELECT
    ('a0d17000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    u_a,
    'instagram',
    'ig-d17-' || n,
    'igd17_' || n,
    'token-d17-' || n,
    'facebook_page',
    true,
    false
  FROM generate_series(1, 26) AS n;

  PERFORM pg_temp.igdaily_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'all', 'account_ids', '[]'::jsonb),
    'competitors', jsonb_build_object('mode', 'off', 'targets', '[]'::jsonb)));

  LOOP
    v_page := pg_temp.igdaily_page('owner', v_pages = 0);
    v_pages := v_pages + 1;
    IF (v_page ->> 'scanned')::integer > 25 THEN
      v_errors := v_errors || ' page ' || v_pages::text || ' scanned '
        || (v_page ->> 'scanned') || ';';
    END IF;
    EXIT WHEN COALESCE((v_page ->> 'has_more')::boolean, false) IS NOT TRUE;
    EXIT WHEN v_pages >= 4;
  END LOOP;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND target_id = v_eligible
     AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 1 THEN
    v_errors := v_errors || ' eligible jobs=' || COALESCE(v_jobs::text, 'null')
      || ' want 1;';
  END IF;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'owner'
     AND captured_on = v_day
     AND target_id IN (SELECT r.id FROM public.igdaily_owner_refused AS r);
  IF v_jobs IS DISTINCT FROM 0 THEN
    v_errors := v_errors || ' refused jobs=' || v_jobs::text || ' want 0;';
  END IF;

  IF v_page ->> 'sweep_status' IS DISTINCT FROM 'completed'
     OR COALESCE((v_page ->> 'has_more')::boolean, true) THEN
    v_errors := v_errors || ' status=' || COALESCE(v_page ->> 'sweep_status', 'null')
      || ' has_more=' || COALESCE(v_page ->> 'has_more', 'null')
      || ' pages=' || v_pages::text || ';';
  END IF;

  IF v_pages > 3 THEN
    v_errors := v_errors || ' pages=' || v_pages::text || ' want <= 3;';
  END IF;

  IF v_errors = '' THEN
    SELECT s.last_target_id INTO v_cursor
      FROM public.instagram_collection_enqueue_sweeps AS s
     WHERE s.target_kind = 'owner' AND s.captured_on = v_day;
    -- Mode 'all' keeps scanning fixture accounts that sort after the
    -- eligible id, so the cursor stops on the last of those, not on it.
    IF v_cursor IS NULL OR v_cursor < v_eligible THEN
      v_errors := v_errors || ' cursor=' || COALESCE(v_cursor::text, 'null')
        || ' did not move past the refused prefix;';
    END IF;
  END IF;

  IF v_errors <> '' THEN
    RAISE EXCEPTION 'D17 %', v_errors;
  END IF;
EXCEPTION WHEN others THEN
  INSERT INTO igdaily_failures (label, detail) VALUES ('D17', SQLERRM);
END
$d17$;

-- ===========================================================================
-- D18 - a target that becomes eligible behind the cursor.
--
-- The sweep scans fifty refused watchlists and stops on the last of them.
-- The lowest one is then given a same-owner viewer, so it would be
-- eligible. A resume must not go backwards to collect it, and a completed
-- sweep must not certify it. The next start walks from the beginning and
-- admits it, still without a job for any watchlist the evaluator refuses.
-- ===========================================================================
DO $d18$
DECLARE
  u_a uuid := 'ad100000-0000-4000-8000-000000000001';
  v_bad_viewer uuid := 'bd200000-0000-4000-8000-000000000001';
  v_good_viewer uuid := 'ee180000-0000-4000-8000-000000000051';
  v_behind uuid := 'c0e18000-0000-4000-8000-000000000001';
  v_eligible uuid := 'c0e18000-0000-4000-8000-000000000051';
  v_day date;
  v_page jsonb;
  v_jobs integer;
  v_targets jsonb := '[]'::jsonb;
  v_errors text := '';
  i integer;
BEGIN
  SELECT (value #>> '{}')::date INTO v_day FROM igdaily_ctx WHERE label = 'captured_on';

  INSERT INTO public.social_accounts
    (id, user_id, platform, platform_user_id, platform_username,
     access_token, ig_auth_type, is_active, needs_reauth)
  VALUES
    (v_good_viewer, u_a, 'instagram', 'ig-d18-viewer', 'igd18viewer',
     'token-d18-viewer', 'facebook_page', true, false);

  INSERT INTO public.competitor_watchlist (id, user_id, platform, username)
  SELECT ('c0e18000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         u_a,
         'instagram',
         'igst18' || lpad(n::text, 2, '0')
    FROM generate_series(1, 51) AS n;

  FOR i IN 1..51 LOOP
    v_targets := v_targets || jsonb_build_array(jsonb_build_object(
      'watchlist_id', ('c0e18000-0000-4000-8000-' || lpad(i::text, 12, '0')),
      'viewer_social_account_id',
        CASE WHEN i = 51 THEN v_good_viewer::text ELSE v_bad_viewer::text END));
  END LOOP;

  PERFORM pg_temp.igdaily_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'off', 'account_ids', '[]'::jsonb),
    'competitors', jsonb_build_object('mode', 'allowlist', 'targets', v_targets)));

  v_page := pg_temp.igdaily_page('competitor', true);

  -- The lowest watchlist becomes eligible only after the page that had to
  -- pass it. On a cursor, that page has already moved past it.
  v_targets := jsonb_set(
    v_targets,
    '{0,viewer_social_account_id}',
    to_jsonb(v_good_viewer::text));
  PERFORM pg_temp.igdaily_set_policy(jsonb_build_object(
    'version', 1,
    'owners', jsonb_build_object('mode', 'off', 'account_ids', '[]'::jsonb),
    'competitors', jsonb_build_object('mode', 'allowlist', 'targets', v_targets)));

  v_page := pg_temp.igdaily_page('competitor', false);

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor' AND target_id = v_eligible AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 1 THEN
    v_errors := v_errors || ' eligible jobs=' || COALESCE(v_jobs::text, 'null') || ' want 1;';
  END IF;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor' AND target_id = v_behind AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 0 THEN
    v_errors := v_errors || ' behind-cursor jobs=' || COALESCE(v_jobs::text, 'null') || ' want 0;';
  END IF;

  IF v_page ->> 'sweep_status' IS DISTINCT FROM 'completed' THEN
    v_errors := v_errors || ' status=' || COALESCE(v_page ->> 'sweep_status', 'null')
      || ' has_more=' || COALESCE(v_page ->> 'has_more', 'null') || ';';
  END IF;

  IF v_errors <> '' THEN
    RAISE EXCEPTION 'D18 %', v_errors;
  END IF;

  v_page := pg_temp.igdaily_page('competitor', false);
  IF (v_page ->> 'enqueued')::integer IS DISTINCT FROM 0
     OR v_page ->> 'sweep_status' IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'D18 a completed sweep certified the behind-cursor target (%).', v_page::text;
  END IF;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor' AND target_id = v_behind AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'D18 resume of the completed sweep wrote % jobs for the behind-cursor target.', v_jobs;
  END IF;

  v_page := pg_temp.igdaily_page('competitor', true);
  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor' AND target_id = v_behind AND captured_on = v_day;
  IF v_jobs IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'D18 the next start admitted % jobs for the behind-cursor target, want 1.', COALESCE(v_jobs, 0);
  END IF;

  SELECT count(*) INTO v_jobs
    FROM public.instagram_collection_jobs
   WHERE target_kind = 'competitor'
     AND captured_on = v_day
     AND target_id IN (
       SELECT ('c0e18000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
         FROM generate_series(2, 50) AS n);
  IF v_jobs IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'D18 the reopen gave a job to % still-refused watchlists.', v_jobs;
  END IF;
EXCEPTION WHEN others THEN
  INSERT INTO igdaily_failures (label, detail) VALUES ('D18', SQLERRM);
END
$d18$;

DO $igdaily_report$
DECLARE
  v_detail text;
BEGIN
  IF EXISTS (SELECT 1 FROM igdaily_failures) THEN
    SELECT string_agg(label || ': ' || detail, E'\n' ORDER BY label)
      INTO v_detail
      FROM igdaily_failures;
    RAISE EXCEPTION 'instagram_collection_daily_dispatch correction tests failed:%',
      E'\n' || v_detail;
  END IF;
END
$igdaily_report$;

ROLLBACK;

\echo '=== instagram_collection_daily_dispatch: ALL CHECKS PASSED ==='
