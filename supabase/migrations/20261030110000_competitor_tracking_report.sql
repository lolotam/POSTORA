-- ===========================================================================
-- Task 8 / M2 - the owner-only competitor tracking report reader.
--
-- Plan: docs/plans/2026-10-30-competitor-ui-and-retention.md
--   Task 2 ("Add bounded owner-only report projection") and the migration
--   inventory row M2.
--
-- Spec: docs/specs/2026-10-30-competitor-ui-and-retention.md
--   §5 "New read boundary and proposed DTO v1", §6 "Growth", §11 (S = 3 days).
--
-- APPLY AS supabase_admin. It owns the function below; postgres is not a
-- superuser on this stack and a REVOKE by a non-owner is a WARNING that
-- changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   public.read_own_competitor_tracking_report(p_request jsonb) returns jsonb
--
--   ONE new public object. It is the database half of the new
--   `competitor-tracking-report` Edge boundary: it returns a BOUNDED RAW
--   PROJECTION of the caller's own competitor history, and the Edge
--   assembler turns that projection into the public DTO v1.
--
--   It is deliberately NOT the public DTO. The frontend never talks to it:
--   the Edge function forwards the verified user's bearer, so the owner is
--   `auth.uid()` and nothing else.
--
-- THE OWNER IS auth.uid(). ALWAYS.
--
--   There is no owner argument, and no request key can name one. Every join
--   to a watchlist entry, a profile snapshot, a media snapshot, a coverage
--   row and a collection job carries the owner's own id, so a caller cannot
--   read another account's history even by forging an id. The function is
--   SECURITY DEFINER (it has to read rows the browser roles may only see
--   through it), and because it is SECURITY DEFINER it BYPASSES RLS - which
--   is exactly why the owner predicates are written out by hand here instead
--   of being left to the policies.
--
--   An admin is not special here. `read_own_competitor_quota()` grants an
--   admin UNLIMITED tracking; it does not grant an admin a view of other
--   people's competitors. An admin reading this report sees exactly what
--   they track themselves.
--
-- ERRORS ARE ERRORS
--
--   A malformed request, an unknown key, a bad cursor and a cursor from
--   another owner or another filter are all refused with a stable error
--   identifier and a SQLSTATE. They are never answered with an empty
--   payload: an empty list is a fact about the data, and a refusal is a
--   fact about the request, and the two must not look alike.
--
--   The identifiers are the only thing the Edge is allowed to read:
--
--     COMPETITOR_REPORT_UNAUTHENTICATED     no verified owner
--     COMPETITOR_REPORT_INVALID_REQUEST     the request shape is wrong
--     COMPETITOR_REPORT_INVALID_CURSOR      the cursor is unusable
--     COMPETITOR_REPORT_NOT_FOUND           no such entry of this owner
--
--   The messages carry no caller-supplied text, no SQL fragment and no
--   table name.
--
-- THE BOUNDS (all of them are constants, not guesses)
--
--   * list and detail return at most 50 rows, 20 by default;
--   * at most 32 daily profile observations per entry;
--   * at most 12 preceding media per displayed media item;
--   * at most 8 coverage rows per entry;
--   * at most 5000 media snapshot rows are scanned per detail read;
--   * the returned JSON is bounded by those numbers. There is no unbounded
--     JSON aggregation anywhere in this function.
--
-- THE CURSOR
--
--   Opaque, versioned, bounded (2048 characters) and owner-bound. It
--   carries the owner, a fingerprint of the request scope (action, state,
--   watchlist entry, period), the exact SQL position (a timestamp with
--   microsecond precision plus the row id) and nothing else.
--
--   The scope fingerprint is what makes a cursor from the active list
--   unusable on the removed list, a cursor for one entry unusable on
--   another, and a cursor from another owner unusable here. A cursor is a
--   position, never a permission.
--
--   The position is the exact instant, never a rounded millisecond: two
--   observations a microsecond apart are two different positions and the
--   keyset comparison never collapses them.
--
-- GROWTH, AND THE S = 3 DAYS BASELINE
--
--   Spec §11 (resolved 2026-10-30): S = 3 days.
--
--   For a period D of 7 or 30 days and the latest successful profile
--   observation L:
--
--     cutoff  = L.captured_at - D days
--     window  = [cutoff - 3 days, cutoff]
--     B       = the latest successful observation in the window whose source
--               is the source of L
--
--   B is selected DIRECTLY by that indexed cutoff. It is never picked out
--   of the 32 observations the response carries, and the whole history is
--   never scanned to find it.
--
--   Two further rules from spec §6:
--
--     * a source change OBSERVED between B and L disqualifies the
--       comparison. The comparison is not allowed to skip over it and use
--       a convenient same-source value from further back. The result is a
--       null growth with the reason `source_changed`.
--     * a missing or zero baseline produces null outputs with an explicit
--       reason. Null means unavailable, never zero.
--
--   The reason vocabulary used here is the one spec §11 resolves:
--   `first_observation`, `no_comparable_baseline`, `source_changed`,
--   `unavailable_metric`, `zero_baseline` and null for a comparable pair.
--
-- MEDIA
--
--   The latest observation of each media item is selected BEFORE the page
--   is cut, so a repeated daily capture of the same post never becomes two
--   rows and never consumes page space.
--
--   Each displayed media item carries up to 12 preceding media of its own
--   cohort (same source, same metric basis, strictly earlier publication
--   instant, mature by 48 hours, usable measurement). Those are the raw
--   baseline candidates; the canonical score is computed by the Edge from
--   `_shared/outlierScore.ts`, never here and never in the browser.
--
--   When a scan was capped and the eligibility of the baseline could not be
--   proven, the item says so with `baseline_incomplete` and carries no
--   score. A short baseline is never presented as a complete one.
--
-- WHAT THIS DOES NOT DO
--
--   * It does not call a provider, enqueue work or touch the network.
--   * It does not change any existing function, return type or grant.
--   * It does not create a second entitlement arbiter: the quota in the
--     response is the existing `read_own_competitor_quota()`.
--   * It does not expose a lease, a claim token, a credential context or a
--     raw provider error.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The indexes the reads need.
-- ===========================================================================
--
-- Three, and only three. Each one exists because a query in the function
-- below needs it, and each one is justified in the comment above it.
--
-- The keyset list reads the owner's entries of one state in
-- (created_at, id) order. Without this index the list would sort every
-- entry the owner has, which is unbounded for an unlimited admin.
CREATE INDEX idx_competitor_watchlist_owner_state_created
  ON public.competitor_watchlist (user_id, is_active, created_at DESC, id DESC);

COMMENT ON INDEX public.idx_competitor_watchlist_owner_state_created IS
  'Keyset paging for the competitor tracking report list: the owner''s '
  'entries of one state in (created_at DESC, id DESC) order. The id is the '
  'tie-break, so two entries created in the same microsecond still have a '
  'total order.';

-- The baseline candidate is selected by an indexed cutoff on the capture
-- instant: the window [cutoff - 3 days, cutoff] is a range, and the
-- candidate is the newest successful row of the same source inside it.
CREATE INDEX idx_competitor_profile_snapshots_watchlist_user_captured_at
  ON public.competitor_profile_snapshots (watchlist_id, user_id, captured_at DESC);

COMMENT ON INDEX public.idx_competitor_profile_snapshots_watchlist_user_captured_at IS
  'Indexed cutoff for the follower baseline: the newest successful '
  'observation of one tracked entry inside [cutoff - 3 days, cutoff]. The '
  'owner is part of the key, so the ownership predicate is in the index and '
  'not only in the query.';

-- The latest observation of one media item, and the "is there a newer one"
-- check that proves it.
CREATE INDEX idx_competitor_media_snapshots_watchlist_user_media_captured
  ON public.competitor_media_snapshots (watchlist_id, user_id, ig_media_id, captured_at DESC, id DESC);

COMMENT ON INDEX public.idx_competitor_media_snapshots_watchlist_user_media_captured IS
  'The latest observation of one media item of one tracked entry, and the '
  'newer-is-there check that proves it. The owner is part of the key, so '
  'the ownership predicate is in the index and not only in the query.';

-- ===========================================================================
-- 2. read_own_competitor_tracking_report
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_own_competitor_tracking_report(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_owner          uuid;
  v_action         text;
  v_state          text;
  v_period         integer;
  v_watchlist      uuid;
  v_limit          integer := 20;
  v_cursor_in      text;
  v_cursor_b64     text;
  v_cursor_text    text;
  v_cursor         jsonb;
  v_cursor_ts      timestamptz;
  v_cursor_key     text;
  v_scope          text;
  v_quota          jsonb;
  v_result         jsonb;
  v_key            text;
  v_num            numeric;
  -- The instant this read is evaluated at. One instant for the whole
  -- response, so the growth endpoints, the media maturity and the
  -- coverage all speak about the same moment.
  v_as_of          timestamptz := now();

  -- The bounds. Named, so a reviewer can see them, and not scattered
  -- through the query as literals.
  c_obs_cap        constant integer := 32;   -- daily profile observations per entry
  c_cand_cap       constant integer := 12;   -- preceding media per displayed item
  c_cov_cap        constant integer := 8;    -- coverage rows per entry
  c_media_scan_cap constant integer := 5000; -- media snapshot rows read per detail
BEGIN
  -- -------------------------------------------------------------------------
  -- The owner. There is no other way in.
  -- -------------------------------------------------------------------------
  v_owner := auth.uid();

  IF v_owner IS NULL THEN
    RAISE EXCEPTION
      'COMPETITOR_REPORT_UNAUTHENTICATED: the competitor tracking report needs an authenticated owner'
      USING ERRCODE = '42501';
  END IF;

  -- -------------------------------------------------------------------------
  -- The request shape. Strict: an unknown key is a refusal, not a silently
  -- ignored extra.
  -- -------------------------------------------------------------------------
  IF p_request IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION
      'COMPETITOR_REPORT_INVALID_REQUEST: the request must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  v_action := lower(btrim(COALESCE(p_request ->> 'action', '')));

  IF v_action NOT IN ('list', 'detail') THEN
    RAISE EXCEPTION
      'COMPETITOR_REPORT_INVALID_REQUEST: the action must be list or detail'
      USING ERRCODE = '22023';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_request) LOOP
    IF v_key NOT IN ('action', 'state', 'watchlist_id', 'period_days', 'limit', 'cursor') THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the request carries an unsupported key'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF v_action = 'list' THEN
    IF p_request ? 'watchlist_id' OR p_request ? 'period_days' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: a list request carries neither a watchlist id nor a period'
        USING ERRCODE = '22023';
    END IF;

    v_state := lower(btrim(COALESCE(p_request ->> 'state', '')));

    IF v_state NOT IN ('active', 'removed') THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the state must be active or removed'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_request ? 'state' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: a detail request carries no state'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_request -> 'watchlist_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the watchlist id must be a UUID string'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_watchlist := (p_request ->> 'watchlist_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the watchlist id must be a UUID string'
        USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(p_request -> 'period_days') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the period must be 7 or 30 days'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_num := (p_request ->> 'period_days')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the period must be 7 or 30 days'
        USING ERRCODE = '22023';
    END;

    IF v_num <> trunc(v_num) OR v_num NOT IN (7, 30) THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the period must be 7 or 30 days'
        USING ERRCODE = '22023';
    END IF;

    v_period := v_num::integer;
  END IF;

  IF p_request ? 'limit' THEN
    IF jsonb_typeof(p_request -> 'limit') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the limit must be a whole number between 1 and 50'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_num := (p_request ->> 'limit')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the limit must be a whole number between 1 and 50'
        USING ERRCODE = '22023';
    END;

    IF v_num <> trunc(v_num) OR v_num < 1 OR v_num > 50 THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_REQUEST: the limit must be a whole number between 1 and 50'
        USING ERRCODE = '22023';
    END IF;

    v_limit := v_num::integer;
  END IF;

  -- The scope fingerprint. It binds the cursor to the owner AND to the
  -- filters of this exact request: the action, the state, the entry and
  -- the period.
  v_scope := md5(
    v_owner::text || '|' || v_action || '|' ||
    COALESCE(v_state, '') || '|' || COALESCE(v_watchlist::text, '') || '|' ||
    COALESCE(v_period::text, '')
  );

  -- -------------------------------------------------------------------------
  -- The cursor.
  -- -------------------------------------------------------------------------
  IF p_request ? 'cursor' THEN
    IF jsonb_typeof(p_request -> 'cursor') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor must be a string'
        USING ERRCODE = '22023';
    END IF;

    v_cursor_in := p_request ->> 'cursor';

    IF v_cursor_in IS NULL OR btrim(v_cursor_in) = '' OR length(v_cursor_in) > 2048 THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is empty or longer than 2048 characters'
        USING ERRCODE = '22023';
    END IF;

    -- base64url back to base64, then padded. The padding is restored from
    -- the length, never trusted from the input.
    v_cursor_b64 := replace(replace(v_cursor_in, '-', '+'), '_', '/');
    v_cursor_b64 := v_cursor_b64 || repeat('=', (4 - length(v_cursor_b64) % 4) % 4);

    BEGIN
      v_cursor_text := convert_from(decode(v_cursor_b64, 'base64'), 'UTF8');
    EXCEPTION WHEN invalid_text_representation OR character_not_in_repertoire THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
        USING ERRCODE = '22023';
    END;

    BEGIN
      v_cursor := v_cursor_text::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
        USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(v_cursor) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
        USING ERRCODE = '22023';
    END IF;

    -- The version, the owner and the scope must all match. A cursor is a
    -- position inside one owner's one filter, never a permission.
    IF (v_cursor ->> 'v') IS DISTINCT FROM '1'
       OR (v_cursor ->> 'o') IS DISTINCT FROM v_owner::text
       OR (v_cursor ->> 'f') IS DISTINCT FROM v_scope THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor does not belong to this request'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_cursor_ts := (v_cursor ->> 'k')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
        USING ERRCODE = '22023';
    END;

    v_cursor_key := v_cursor ->> 'i';

    IF v_cursor_ts IS NULL OR v_cursor_key IS NULL OR btrim(v_cursor_key) = '' THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
        USING ERRCODE = '22023';
    END IF;

    -- The list cursor points at a watchlist row, the detail cursor at a
    -- media row. Each has to be the shape that action expects.
    IF v_action = 'list' THEN
      BEGIN
        v_cursor_key := (v_cursor ->> 'i')::uuid::text;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION
          'COMPETITOR_REPORT_INVALID_CURSOR: the cursor is not readable'
          USING ERRCODE = '22023';
      END;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- A detail read of an entry this owner does not have is refused here,
  -- before anything is assembled, and it is refused with the SAME error as
  -- an entry that does not exist at all. The two must be indistinguishable.
  -- -------------------------------------------------------------------------
  IF v_action = 'detail' THEN
    PERFORM 1
      FROM public.competitor_watchlist w
     WHERE w.id = v_watchlist
       AND w.user_id = v_owner;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'COMPETITOR_REPORT_NOT_FOUND: the competitor tracking report has no such entry'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- The quota of the same transaction, from the existing reader. This
  -- function does not arbitrate entitlement.
  v_quota := public.read_own_competitor_quota();

  -- -------------------------------------------------------------------------
  -- The projection.
  -- -------------------------------------------------------------------------
  v_result := (
    WITH
    -- The page of entries. For a list this is the keyset page of the
    -- owner's entries of one state; for a detail it is the single entry.
    page AS (
      SELECT w.id, w.username, w.label, w.is_active, w.removed_at, w.status,
             w.last_error_code, w.next_retry_at, w.source, w.created_at, w.updated_at
        FROM public.competitor_watchlist w
       WHERE w.user_id = v_owner
         AND (
           (v_action = 'list'
            AND w.is_active = (v_state = 'active')
            AND (v_cursor_ts IS NULL
                 OR (w.created_at, w.id) < (v_cursor_ts, v_cursor_key::uuid)))
           OR
           (v_action = 'detail' AND w.id = v_watchlist)
         )
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT (CASE WHEN v_action = 'list' THEN v_limit + 1 ELSE 1 END)
    ),
    -- The rows that are actually returned. The extra row of the page is the
    -- "there is more" evidence and is not part of the answer.
    shown AS (
      SELECT p.*, row_number() OVER (ORDER BY p.created_at DESC, p.id DESC) AS ord
        FROM (SELECT * FROM page ORDER BY created_at DESC, id DESC) p
       LIMIT v_limit
    ),
    -- The daily profile observations of every selected entry, newest first,
    -- at most 32 of them plus the one extra row that proves truncation.
    obs AS (
      SELECT s.id AS watchlist_id,
             o.captured_on, o.captured_at, o.followers_count, o.media_count, o.source,
             count(*) OVER (PARTITION BY s.id) AS obs_total
        FROM shown s
        CROSS JOIN LATERAL (
          SELECT p.captured_on, p.captured_at, p.followers_count, p.media_count, p.source
            FROM public.competitor_profile_snapshots p
           WHERE p.watchlist_id = s.id
             AND p.user_id = v_owner
             AND p.status = 'ok'
           ORDER BY p.captured_at DESC
           LIMIT (c_obs_cap + 1)
        ) o
    ),
    -- The latest successful observation of every selected entry. It is the
    -- observed end of every growth comparison. A LEFT JOIN, so an entry
    -- that was never captured still appears - with no observation, which
    -- is the `first_observation` case and not a missing row.
    latest_obs AS (
      SELECT s.id AS watchlist_id,
             o.captured_on, o.captured_at, o.followers_count, o.media_count, o.source
        FROM shown s
        LEFT JOIN LATERAL (
          SELECT p.captured_on, p.captured_at, p.followers_count, p.media_count, p.source
            FROM public.competitor_profile_snapshots p
           WHERE p.watchlist_id = s.id
             AND p.user_id = v_owner
             AND p.status = 'ok'
           ORDER BY p.captured_at DESC
           LIMIT 1
        ) o ON true
    ),
    -- The baseline candidate of each period, selected DIRECTLY by the
    -- indexed cutoff of the S = 3 days window, plus the observed source
    -- change between the two ends of the comparison.
    growth_base AS (
      SELECT l.watchlist_id,
             p.days,
             b.captured_at AS baseline_at,
             b.followers_count AS baseline_followers,
             EXISTS (
               SELECT 1
                 FROM public.competitor_profile_snapshots s
                WHERE s.watchlist_id = l.watchlist_id
                  AND s.user_id = v_owner
                  AND s.status = 'ok'
                  AND s.source <> l.source
                  AND s.captured_at > b.captured_at
                  AND s.captured_at < l.captured_at
             ) AS source_changed
        FROM latest_obs l
        CROSS JOIN (VALUES (7), (30)) AS p(days)
        LEFT JOIN LATERAL (
          SELECT b.captured_at, b.followers_count
            FROM public.competitor_profile_snapshots b
           WHERE b.watchlist_id = l.watchlist_id
             AND b.user_id = v_owner
             AND b.status = 'ok'
             AND b.source = l.source
             AND b.captured_at >= l.captured_at - make_interval(days => p.days) - interval '3 days'
             AND b.captured_at <= l.captured_at - make_interval(days => p.days)
           ORDER BY b.captured_at DESC
           LIMIT 1
        ) b ON true
    ),
    -- The growth verdict of each period.
    growth_calc AS (
      SELECT g.watchlist_id, g.days,
             l.captured_at, l.followers_count, l.source,
             g.baseline_at, g.baseline_followers, g.source_changed,
             CASE
               WHEN l.captured_at IS NULL THEN 'first_observation'
               WHEN l.followers_count IS NULL THEN 'unavailable_metric'
               WHEN g.baseline_at IS NULL THEN 'no_comparable_baseline'
               WHEN g.source_changed THEN 'source_changed'
               WHEN g.baseline_followers IS NULL THEN 'unavailable_metric'
               WHEN g.baseline_followers = 0 THEN 'zero_baseline'
               ELSE NULL
             END AS reason
        FROM growth_base g
        JOIN latest_obs l ON l.watchlist_id = g.watchlist_id
    ),
    growth AS (
      SELECT c.watchlist_id, c.days,
             jsonb_build_object(
               'period_days', c.days,
               'reason', c.reason,
               'observed_at', to_jsonb(c.captured_at),
               'observed_followers', c.followers_count,
               'observed_source', c.source,
               'baseline_at', to_jsonb(c.baseline_at),
               'baseline_followers', c.baseline_followers,
               'interval_days', CASE
                 WHEN c.baseline_at IS NOT NULL
                 THEN round(extract(epoch FROM (c.captured_at - c.baseline_at)) / 86400.0, 6)
               END,
               'interval_seconds', CASE
                 WHEN c.baseline_at IS NOT NULL
                 THEN round(extract(epoch FROM (c.captured_at - c.baseline_at)), 6)
               END,
               'absolute', CASE
                 WHEN c.reason IS NULL THEN c.followers_count - c.baseline_followers
               END,
               'percent', CASE
                 WHEN c.reason IS NULL
                 THEN round(100.0 * (c.followers_count - c.baseline_followers) / c.baseline_followers, 6)
               END
             ) AS payload
        FROM growth_calc c
    ),
    -- The capture coverage evidence of every selected entry, newest day
    -- first.
    cov AS (
      SELECT s.id AS watchlist_id,
             c.captured_on, c.captured_at, c.source, c.job_generation,
             c.capture_started_at, c.capture_ended_at, c.oldest_returned_at,
             c.ordering_verified, c.cursor_present, c.exhausted, c.truncated,
             c.gap_reason
        FROM shown s
        CROSS JOIN LATERAL (
          SELECT c.*
            FROM public.competitor_capture_coverage c
           WHERE c.watchlist_id = s.id
             AND c.user_id = v_owner
           ORDER BY c.captured_on DESC
           LIMIT (c_cov_cap + 1)
        ) c
    ),
    -- The current collection job of every selected entry. The lease, the
    -- claim token and the credential context are internal and are never
    -- selected here.
    job AS (
      SELECT s.id AS watchlist_id,
             j.status, j.job_generation, j.attempts, j.due_at, j.retry_at,
             j.last_attempt_at, j.last_partial_at, j.last_success_at,
             j.last_reason_code, j.captured_on
        FROM shown s
        CROSS JOIN LATERAL (
          SELECT j.*
            FROM public.instagram_collection_jobs j
           WHERE j.watchlist_id = s.id
             AND j.user_id = v_owner
             AND j.target_kind = 'competitor'
           ORDER BY j.captured_on DESC
           LIMIT 1
        ) j
    ),
    -- The media rows of the detail read, newest publication first, capped.
    -- One extra row proves the cap.
    --
    -- The metric basis is decided ONCE, here: a reel is measured by its
    -- public views, a feed or a carousel album by its public interactions,
    -- and an unknown, story or ad product type has no basis at all. Every
    -- later read of it uses this column, so the cohort rule cannot drift
    -- between the candidate selection and the response.
    media_scan AS (
      SELECT m.*,
             (CASE m.media_product_type
                WHEN 'REELS' THEN 'public_views'
                WHEN 'FEED' THEN 'public_interactions'
                WHEN 'CAROUSEL_ALBUM' THEN 'public_interactions'
                ELSE NULL END) AS metric_basis
        FROM (
          SELECT m.ig_media_id, m.published_at, m.captured_at, m.source,
                 m.media_product_type, m.media_type, m.thumbnail_url, m.caption,
                 m.permalink, m.like_count, m.comments_count, m.view_count, m.id
            FROM public.competitor_media_snapshots m
           WHERE m.watchlist_id = v_watchlist
             AND m.user_id = v_owner
             AND v_action = 'detail'
           ORDER BY m.published_at DESC, m.ig_media_id, m.captured_at DESC, m.id DESC
           LIMIT (c_media_scan_cap + 1)
        ) m
    ),
    -- Whether the media scan was capped. A capped scan that cannot prove
    -- the eligibility of a baseline says so instead of pretending.
    media_capped AS (
      SELECT COALESCE((SELECT count(*) > c_media_scan_cap FROM media_scan), false) AS capped
    ),
    -- The latest observation of each media item. Selected BEFORE the page
    -- is cut, so one post captured on many days is one row. The measured
    -- value follows from the basis: a reel has views, a feed has its
    -- interactions, and a missing measurement is never a zero.
    media_latest AS (
      SELECT DISTINCT ON (s.ig_media_id) s.*,
             (CASE s.metric_basis
                WHEN 'public_views' THEN s.view_count
                WHEN 'public_interactions' THEN s.like_count + s.comments_count
                ELSE NULL END) AS metric_value
        FROM media_scan s
       ORDER BY s.ig_media_id, s.captured_at DESC, s.id DESC
    ),
    media_page AS (
      SELECT m.ig_media_id, m.published_at, m.captured_at, m.source,
             m.media_product_type, m.media_type, m.thumbnail_url, m.caption,
             m.permalink, m.like_count, m.comments_count, m.view_count,
             m.metric_basis
        FROM media_latest m
       WHERE v_action = 'detail'
         AND (v_cursor_ts IS NULL
              OR (m.published_at, m.ig_media_id) < (v_cursor_ts, v_cursor_key))
       ORDER BY m.published_at DESC, m.ig_media_id DESC
       LIMIT (v_limit + 1)
    ),
    media_shown AS (
      SELECT p.*, row_number() OVER (ORDER BY p.published_at DESC, p.ig_media_id DESC) AS ord
        FROM (SELECT * FROM media_page ORDER BY published_at DESC, ig_media_id DESC) p
       LIMIT v_limit
    ),
    -- The preceding media of every displayed item, inside its own cohort:
    -- same source, same metric basis, strictly earlier publication instant,
    -- mature by 48 hours and carrying a usable measurement.
    media_cand AS (
      SELECT d.ig_media_id AS item_id,
             c.ig_media_id, c.published_at, c.captured_at, c.source,
             c.metric_basis, c.metric_value
        FROM media_shown d
        CROSS JOIN LATERAL (
          SELECT p.ig_media_id, p.published_at, p.captured_at, p.source,
                 p.metric_basis, p.metric_value
            FROM media_latest p
           WHERE p.source = d.source
             AND p.published_at < d.published_at
             AND p.ig_media_id <> d.ig_media_id
             AND p.metric_basis = d.metric_basis
             AND p.metric_value IS NOT NULL
             AND p.published_at <= v_as_of - interval '48 hours'
           ORDER BY p.published_at DESC, p.ig_media_id DESC
           LIMIT c_cand_cap
        ) c
    ),
    -- The assembled entry.
    entry_json AS (
      SELECT jsonb_build_object(
        'watchlist_id', s.id,
        'username', s.username,
        'label', s.label,
        'is_active', s.is_active,
        'removed_at', to_jsonb(s.removed_at),
        'status', s.status,
        'last_error_code', s.last_error_code,
        'next_retry_at', to_jsonb(s.next_retry_at),
        'source', s.source,
        'cleanup_eligible_at', to_jsonb(s.removed_at + interval '2160 hours'),
        'created_at', to_jsonb(s.created_at),
        'profile', (
          SELECT CASE
                   WHEN l.captured_at IS NULL THEN NULL
                   ELSE jsonb_build_object(
                     'followers_count', l.followers_count,
                     'media_count', l.media_count,
                     'captured_at', to_jsonb(l.captured_at),
                     'captured_on', to_jsonb(l.captured_on),
                     'source', l.source)
                 END
            FROM latest_obs l
           WHERE l.watchlist_id = s.id),
        'observations', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
                   'captured_on', to_jsonb(o.captured_on),
                   'captured_at', to_jsonb(o.captured_at),
                   'followers_count', o.followers_count,
                   'media_count', o.media_count,
                   'source', o.source)
                 ORDER BY o.captured_at DESC)
            FROM (SELECT o2.*
                    FROM obs o2
                   WHERE o2.watchlist_id = s.id
                   ORDER BY o2.captured_at DESC
                   LIMIT c_obs_cap) o), '[]'::jsonb),
        'observations_truncated', COALESCE((
          SELECT o.obs_total > c_obs_cap
            FROM obs o
           WHERE o.watchlist_id = s.id
           LIMIT 1), false),
        'growth', COALESCE((
          SELECT jsonb_object_agg(g.days::text, g.payload)
            FROM growth g
           WHERE g.watchlist_id = s.id), '{}'::jsonb),
        'coverage', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
                   'captured_on', to_jsonb(c.captured_on),
                   'captured_at', to_jsonb(c.captured_at),
                   'source', c.source,
                   'job_generation', c.job_generation,
                   'capture_started_at', to_jsonb(c.capture_started_at),
                   'capture_ended_at', to_jsonb(c.capture_ended_at),
                   'oldest_returned_at', to_jsonb(c.oldest_returned_at),
                   'ordering_verified', c.ordering_verified,
                   'cursor_present', c.cursor_present,
                   'exhausted', c.exhausted,
                   'truncated', c.truncated,
                   'gap_reason', c.gap_reason)
                 ORDER BY c.captured_on DESC)
            FROM (SELECT c2.*
                    FROM cov c2
                   WHERE c2.watchlist_id = s.id
                   ORDER BY c2.captured_on DESC
                   LIMIT c_cov_cap) c), '[]'::jsonb),
        'coverage_truncated', COALESCE((
          SELECT count(*) > c_cov_cap
            FROM cov c
           WHERE c.watchlist_id = s.id), false),
        'job', (
          SELECT jsonb_build_object(
                   'status', j.status,
                   'job_generation', j.job_generation,
                   'attempts', j.attempts,
                   'due_at', to_jsonb(j.due_at),
                   'retry_at', to_jsonb(j.retry_at),
                   'last_attempt_at', to_jsonb(j.last_attempt_at),
                   'last_partial_at', to_jsonb(j.last_partial_at),
                   'last_success_at', to_jsonb(j.last_success_at),
                   'last_reason_code', j.last_reason_code,
                   'captured_on', to_jsonb(j.captured_on))
            FROM job j
           WHERE j.watchlist_id = s.id)
      ) AS payload, s.ord
      FROM shown s
    ),
    -- The assembled media of the detail read.
    media_json AS (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ig_media_id', m.ig_media_id,
               'published_at', to_jsonb(m.published_at),
               'captured_at', to_jsonb(m.captured_at),
               'media_product_type', m.media_product_type,
               'media_type', m.media_type,
               'thumbnail_url', m.thumbnail_url,
               'permalink', m.permalink,
               'caption', m.caption,
               'like_count', m.like_count,
               'comments_count', m.comments_count,
               'view_count', m.view_count,
               'source', m.source,
               'metric_basis', m.metric_basis,
               'mature', (m.published_at <= v_as_of - interval '48 hours'),
               'baseline', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'ig_media_id', c.ig_media_id,
                          'published_at', to_jsonb(c.published_at),
                          'captured_at', to_jsonb(c.captured_at),
                          'source', c.source,
                          'metric_basis', c.metric_basis,
                          'value', c.metric_value)
                   ORDER BY c.published_at DESC, c.ig_media_id DESC)
                   FROM media_cand c
                  WHERE c.item_id = m.ig_media_id), '[]'::jsonb),
               'baseline_incomplete', (
                 (SELECT count(*) FROM media_cand c WHERE c.item_id = m.ig_media_id) < c_cand_cap
                 AND (SELECT capped FROM media_capped))
             ) ORDER BY m.ord), '[]'::jsonb) AS payload
        FROM media_shown m
    ),
    -- The position of the next page.
    cursor_pos AS (
      SELECT x.ts, x.key
        FROM (
          SELECT s.created_at AS ts, s.id::text AS key, s.ord
            FROM shown s
           WHERE v_action = 'list'
          UNION ALL
          SELECT m.published_at, m.ig_media_id, m.ord
            FROM media_shown m
           WHERE v_action = 'detail'
        ) x
       WHERE x.ord = v_limit
    ),
    has_more AS (
      SELECT CASE
               WHEN v_action = 'list' THEN (SELECT count(*) FROM page) > v_limit
               ELSE (SELECT count(*) FROM media_page) > v_limit
             END AS more
    ),
    cursor_out AS (
      SELECT CASE
               WHEN (SELECT more FROM has_more) AND c.ts IS NOT NULL
               THEN rtrim(replace(replace(replace(replace(
                      encode(convert_to(
                        jsonb_build_object(
                          'v', 1,
                          'o', v_owner::text,
                          'f', v_scope,
                          'k', to_char(c.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                          'i', c.key)::text,
                        'UTF8'),
                      'base64'),
                      E'\n', ''),
                      '+', '-'),
                      '/', '_'),
                    '=', ''))
               ELSE NULL
             END AS next_cursor
        FROM cursor_pos c
    )
    SELECT jsonb_build_object(
      'version', 1,
      'action', v_action,
      'as_of', to_jsonb(v_as_of),
      'capture_timezone', 'Asia/Kuwait',
      'quota', v_quota,
      'next_cursor', (SELECT next_cursor FROM cursor_out),
      'entries', CASE
                   WHEN v_action = 'list'
                   THEN COALESCE((SELECT jsonb_agg(e.payload ORDER BY e.ord) FROM entry_json e), '[]'::jsonb)
                   ELSE '[]'::jsonb
                 END,
      'entry', CASE
                  WHEN v_action = 'detail' THEN (SELECT e.payload FROM entry_json e LIMIT 1)
                  ELSE NULL
                END,
      'media', CASE
                 WHEN v_action = 'detail' THEN COALESCE((SELECT payload FROM media_json), '[]'::jsonb)
                 ELSE '[]'::jsonb
               END
    )
  );

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.read_own_competitor_tracking_report(jsonb) IS
  'The caller''s own bounded competitor tracking projection. The owner is '
  'auth.uid() and every join carries it: no request key can name another '
  'owner and an admin sees only what they track themselves. Strict request '
  'shape (list/detail, 20 by default and 50 at most), opaque owner-bound '
  'keyset cursor, at most 32 daily profile observations per entry, the '
  'S = 3 days baseline candidate selected by an indexed cutoff, at most 12 '
  'preceding media per displayed item and a capped media scan that reports '
  'incompleteness instead of a short baseline. It returns a raw projection '
  'for the Edge assembler, not the public DTO, and it calls no provider.';

-- ===========================================================================
-- 3. Grants.
-- ===========================================================================
--
-- Authenticated only.
--
-- This stack carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO
-- anon, authenticated and service_role, so the REVOKEs are load-bearing:
-- "REVOKE ... FROM PUBLIC" alone would leave every role holding EXECUTE.
--
-- The service role is revoked on purpose. The Edge function calls this
-- reader with the VERIFIED USER's bearer, so the database role is
-- `authenticated` and the owner is the user. A service-role call would
-- have no user to scope to, and the whole point of this boundary is that
-- there always is one.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.read_own_competitor_tracking_report(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.read_own_competitor_tracking_report(jsonb)
  TO authenticated;

COMMIT;
