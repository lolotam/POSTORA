-- Explicit-owner service boundaries. Browser RPCs and service RPCs share one body.
-- No JWT claims are changed and no user token is minted.
BEGIN;

CREATE OR REPLACE FUNCTION public.competitor_quota_for_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner   uuid;
  v_limit   integer;
  v_active  integer;
BEGIN
  v_owner := p_user_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication is required to read a competitor quota'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF public.has_role(v_owner, 'admin'::public.app_role) THEN
    v_limit := -1;
  ELSE
    v_limit := public.effective_competitor_quota(v_owner);
  END IF;

  SELECT count(*)::integer INTO v_active
    FROM public.competitor_watchlist
   WHERE user_id = v_owner AND is_active;

  RETURN jsonb_build_object(
    'max_tracked_competitors', v_limit,
    'unlimited', (v_limit = -1),
    'tracked_active', v_active,
    'remaining', CASE WHEN v_limit IS NULL OR v_limit = -1 THEN NULL
                      ELSE GREATEST(0, v_limit - v_active) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.competitor_quota_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.competitor_quota_for_user(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.read_own_competitor_quota()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN

  RETURN public.competitor_quota_for_user(auth.uid());
END;
$wrapper$;

CREATE OR REPLACE FUNCTION public.add_competitor_watchlist_for_user(p_user_id uuid,
  p_username text,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner uuid;
  v_username text;
  v_label text;
  v_row public.competitor_watchlist%ROWTYPE;
  v_quota_message text;
BEGIN
  v_owner := p_user_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_ADD_DENIED: you must be signed in to track a competitor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_username := public.normalize_competitor_username(p_username);
  IF v_username IS NULL OR v_username = '' THEN
    RAISE EXCEPTION 'COMPETITOR_USERNAME_INVALID: Enter the competitor handle without the @.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_label IS NOT NULL AND char_length(p_label) > 120 THEN
    RAISE EXCEPTION 'COMPETITOR_LABEL_INVALID: The label must be at most 120 characters.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_label := p_label;

  -- Watchlist row first, when one is visible. The trigger takes the quota
  -- lock only if the branch below actually activates.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.user_id = v_owner
     AND w.platform = 'instagram'
     AND w.username = v_username
   FOR UPDATE;

  IF FOUND AND v_row.is_active THEN
    UPDATE public.competitor_watchlist
       SET label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', true
    );
  END IF;

  IF FOUND THEN
    -- Removed, and we hold the row. History stays on this row. Status is
    -- left for the trigger to reset; this statement does not write it.
    UPDATE public.competitor_watchlist
       SET is_active = true,
           status = CASE WHEN current_setting('role', true) = 'service_role' THEN 'pending' ELSE status END,
           removed_at = NULL,
           label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', v_row.is_active,
      'status', v_row.status,
      'reactivated', true,
      'already_tracked', false,
      'quota', public.competitor_quota_for_user(p_user_id)
    );
  END IF;

  BEGIN
    INSERT INTO public.competitor_watchlist
      (user_id, platform, username, label, is_active, status)
    VALUES
      (v_owner, 'instagram', v_username, v_label, true, 'pending')
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', false,
      'quota', public.competitor_quota_for_user(p_user_id)
    );
  EXCEPTION
    WHEN unique_violation THEN
      v_quota_message := NULL;
    WHEN check_violation THEN
      -- Quota is checked in the BEFORE INSERT trigger, before the unique
      -- index. A same-handle row that committed while we waited on the
      -- quota lock therefore surfaces as COMPETITOR_QUOTA_EXCEEDED when
      -- the owner is already at the cap, not as unique_violation. Any
      -- other check failure (the handle shape, for one) is not that race.
      IF SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%' THEN
        v_quota_message := SQLERRM;
      ELSE
        RAISE;
      END IF;
  END;

  -- The failed insert's subtransaction released its quota lock. Lock the
  -- watchlist row next, then decide from that locked image.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.user_id = v_owner
     AND w.platform = 'instagram'
     AND w.username = v_username
   FOR UPDATE;

  IF NOT FOUND THEN
    IF v_quota_message IS NOT NULL THEN
      RAISE EXCEPTION '%', v_quota_message
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'COMPETITOR_ADD_FAILED: the competitor could not be tracked'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_row.is_active THEN
    UPDATE public.competitor_watchlist
       SET label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', true
    );
  END IF;

  -- Inactive, and the insert was refused because the cap is full.
  -- Reactivation needs a slot as well.
  IF v_quota_message IS NOT NULL THEN
    RAISE EXCEPTION '%', v_quota_message
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.competitor_watchlist
     SET is_active = true,
           status = CASE WHEN current_setting('role', true) = 'service_role' THEN 'pending' ELSE status END,
         removed_at = NULL,
         label = COALESCE(v_label, label),
         updated_at = now()
   WHERE id = v_row.id
     AND user_id = v_owner
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'watchlist_id', v_row.id,
    'username', v_row.username,
    'is_active', v_row.is_active,
    'status', v_row.status,
    'reactivated', true,
    'already_tracked', false,
    'quota', public.competitor_quota_for_user(p_user_id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.add_competitor_watchlist_for_user(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_competitor_watchlist_for_user(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.add_competitor_watchlist(p_username text, p_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN

  RETURN public.add_competitor_watchlist_for_user(auth.uid(), p_username, p_label);
END;
$wrapper$;

CREATE OR REPLACE FUNCTION public.update_competitor_watchlist_for_user(p_user_id uuid,
  p_watchlist_id uuid,
  p_label text DEFAULT NULL,
  p_is_active boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner  uuid;
  v_row    public.competitor_watchlist%ROWTYPE;
BEGIN
  v_owner := p_user_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_UPDATE_DENIED: you must be signed in to manage a competitor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_label IS NOT NULL AND char_length(p_label) > 120 THEN
    RAISE EXCEPTION 'COMPETITOR_LABEL_INVALID: The label must be at most 120 characters.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Watchlist row first. A reactivation then locks the quota row inside
  -- the trigger. add_competitor_watchlist locks in this same order.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.id = p_watchlist_id
     AND w.user_id = v_owner
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPETITOR_NOT_FOUND: that competitor is not on your list'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_is_active IS TRUE AND NOT v_row.is_active THEN
    -- Reactivation. Quota and the pending reset belong to the trigger.
    -- Writing status here is a browser change of a server column, and the
    -- trigger rejects it.
    UPDATE public.competitor_watchlist
       SET is_active = true,
           status = CASE WHEN current_setting('role', true) = 'service_role' THEN 'pending' ELSE status END,
           removed_at = NULL,
           label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id
       AND user_id = v_owner;

  ELSIF p_is_active IS FALSE AND v_row.is_active THEN
    -- A soft removal. The history stays: the snapshots outlive the removal.
    UPDATE public.competitor_watchlist
       SET is_active = false,
           removed_at = now(),
           label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id;

  ELSE
    -- Label only, or a no-op activation of an already active entry.
    UPDATE public.competitor_watchlist
       SET label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id;
  END IF;

  -- The updated row, so the caller does not have to read it back. The
  -- removal marker is normalised by the trigger, so the row that is
  -- returned is the row that is stored.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.id = p_watchlist_id
     AND w.user_id = v_owner;

  RETURN jsonb_build_object(
    'watchlist_id', v_row.id,
    'username', v_row.username,
    'label', v_row.label,
    'is_active', v_row.is_active,
    'removed_at', v_row.removed_at,
    'status', v_row.status,
    -- The caller's own entitlement and usage, so the UI does not have to
    -- make a second call to find out whether a slot was consumed.
    'quota', public.competitor_quota_for_user(p_user_id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_competitor_watchlist_for_user(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_competitor_watchlist_for_user(uuid, uuid, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.update_competitor_watchlist(p_watchlist_id uuid, p_label text DEFAULT NULL, p_is_active boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN

  RETURN public.update_competitor_watchlist_for_user(auth.uid(), p_watchlist_id, p_label, p_is_active);
END;
$wrapper$;

CREATE OR REPLACE FUNCTION public.read_competitor_tracking_report_for_user(p_user_id uuid,
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
  v_owner := p_user_id;

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
  v_quota := public.competitor_quota_for_user(p_user_id);

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

REVOKE ALL ON FUNCTION public.read_competitor_tracking_report_for_user(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_competitor_tracking_report_for_user(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.read_own_competitor_tracking_report(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN

  RETURN public.read_competitor_tracking_report_for_user(auth.uid(), p_request);
END;
$wrapper$;

CREATE OR REPLACE FUNCTION public.read_competitor_tracking_report_v2_for_user(p_user_id uuid, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_owner uuid := p_user_id;
  v_raw jsonb;
  v_entry jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_id uuid;
  v_as_of timestamptz;
  v_anchor timestamptz;
  v_count bigint;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_REPORT_FORBIDDEN: a verified owner is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Reuse strict requests, owner-bound cursors, growth/cohorts and existing bounds.
  v_raw := public.read_competitor_tracking_report_for_user(p_user_id, p_request);
  v_as_of := (v_raw->>'as_of')::timestamptz;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(
    CASE WHEN v_raw->>'action'='list' THEN v_raw->'entries'
      ELSE jsonb_build_array(v_raw->'entry') END
  ) LOOP
    v_id := (v_entry->>'watchlist_id')::uuid;
    PERFORM 1 FROM public.competitor_watchlist w WHERE w.id=v_id AND w.user_id=v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'COMPETITOR_NOT_FOUND: the tracked entry is unavailable'
        USING ERRCODE = 'no_data_found';
    END IF;

    SELECT COALESCE(c.capture_ended_at,c.captured_at) INTO v_anchor
      FROM public.competitor_capture_coverage c
      WHERE c.watchlist_id=v_id AND c.user_id=v_owner AND c.captured_at<=v_as_of
      ORDER BY c.captured_on DESC,c.captured_at DESC LIMIT 1;
    IF v_anchor IS NULL THEN
      SELECT m.captured_at INTO v_anchor FROM public.competitor_media_snapshots m
        WHERE m.watchlist_id=v_id AND m.user_id=v_owner AND m.status='ok'
          AND m.captured_at<=v_as_of
        ORDER BY m.captured_at DESC LIMIT 1;
    END IF;

    -- A zero here is a measured count of stored observations, never a guess
    -- based on a missing media page. Completeness remains separate evidence.
    SELECT count(DISTINCT m.ig_media_id) INTO v_count
      FROM public.competitor_media_snapshots m
      WHERE m.watchlist_id=v_id AND m.user_id=v_owner AND m.status='ok'
        AND m.captured_at<=v_as_of
        AND m.published_at>=v_anchor-interval '168 hours' AND m.published_at<=v_anchor;
    v_entry := v_entry||jsonb_build_object('weekly_inventory',jsonb_build_object(
      'observed_count',v_count,
      'interval_start',to_jsonb(v_anchor-interval '168 hours'),
      'interval_end',to_jsonb(v_anchor)));
    v_entries := v_entries||jsonb_build_array(v_entry);
  END LOOP;

  IF v_raw->>'action'='list' THEN
    RETURN jsonb_set(v_raw,'{entries}',v_entries);
  END IF;
  RETURN jsonb_set(v_raw,'{entry}',v_entries->0);
END;
$function$;

REVOKE ALL ON FUNCTION public.read_competitor_tracking_report_v2_for_user(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_competitor_tracking_report_v2_for_user(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.read_own_competitor_tracking_report_v2(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN

  RETURN public.read_competitor_tracking_report_v2_for_user(auth.uid(), p_request);
END;
$wrapper$;

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_job_for_user(p_user_id uuid,
  p_target_kind text,
  p_target_id   uuid,
  p_mode        text DEFAULT 'normal'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner       uuid;
  v_target      jsonb;
  v_mode        text := lower(COALESCE(p_mode, 'normal'));
  v_captured_on date;
  v_accepted    timestamptz;
  v_last        timestamptz;
  v_job_id      uuid;
  v_generation  bigint;
  v_status      text;
  v_inserted    boolean := false;
  v_existed     boolean := false;
  v_allowed     jsonb;
  v_reason      text;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'IG_COLLECTION_UNAUTHORIZED' USING ERRCODE='42501'; END IF;

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET: a target id is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_mode NOT IN ('normal', 'force') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_MODE: mode must be normal or force'
      USING ERRCODE = '22023';
  END IF;

  v_owner := p_user_id;
  v_captured_on := (now() AT TIME ZONE 'Asia/Kuwait')::date;

  v_target := public.ig_collection_resolve_target(v_owner, p_target_kind, p_target_id);

  -- The owner is verified against the target row first. A foreign or
  -- missing target is indistinguishable from one that never existed.
  IF NOT COALESCE((v_target ->> 'found')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_NOT_FOUND: no such Instagram target for this user'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE((v_target ->> 'is_active')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_INACTIVE: the target is not active'
      USING ERRCODE = 'P0002';
  END IF;

  -- The rollout decision. It comes before the throttle, so a refusal
  -- never spends the accepted-request window.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, p_target_kind, p_target_id, NULL);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    v_reason := v_allowed ->> 'reason_code';

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_enqueue_refused',
      'reason_code', v_reason,
      'user_id', v_owner,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'details', jsonb_build_object('actor', 'owner', 'mode', v_mode)));

    RETURN jsonb_build_object(
      'accepted', false,
      'refused', true,
      'reason_code', v_reason,
      'captured_on', v_captured_on
    );
  END IF;

  -- The accepted-request window. It is consumed before anything is
  -- written, and the whole transaction rolls back if the enqueue fails,
  -- so a refused enqueue never burns the window.
  v_accepted := public.ig_collection_throttle_accept(
    'user_request', v_owner, p_target_kind, p_target_id, interval '15 minutes');

  IF v_accepted IS NULL THEN
    v_last := public.ig_collection_throttle_last_accepted(
      'user_request', p_target_kind, p_target_id);

    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'throttled',
      'retry_after_seconds', GREATEST(
        0,
        CEIL(EXTRACT(EPOCH FROM ((v_last + interval '15 minutes') - now())))::integer),
      'captured_on', v_captured_on
    );
  END IF;

  -- Whether the row already existed, so the answer can say 'created' or
  -- 'already_enqueued' honestly.
  SELECT EXISTS (
           SELECT 1 FROM public.instagram_collection_jobs AS j
            WHERE j.user_id = v_owner
              AND j.target_kind = p_target_kind
              AND j.target_id = p_target_id
              AND j.captured_on = v_captured_on)
    INTO v_existed;

  IF v_mode = 'force' THEN
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO UPDATE
       SET job_generation   = j.job_generation + 1,
           status           = 'queued',
           due_at           = now(),
           retry_at         = NULL,
           lease_token      = NULL,
           lease_expires_at = NULL,
           attempts         = 0,
           last_reason_code = NULL,
           -- The new revision starts with no connection context; the worker
           -- captures it again when it claims the work.
           context_viewer_social_account_id = NULL,
           context_credential_generation    = NULL,
           context_login_kind               = NULL,
           updated_at       = now()
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;
  ELSE
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO NOTHING
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;

    IF v_job_id IS NULL THEN
      SELECT j.id, j.job_generation, j.status
        INTO v_job_id, v_generation, v_status
        FROM public.instagram_collection_jobs AS j
       WHERE j.user_id = v_owner
         AND j.target_kind = p_target_kind
         AND j.target_id = p_target_id
         AND j.captured_on = v_captured_on;
    END IF;
  END IF;

  v_inserted := NOT v_existed;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', CASE WHEN v_mode = 'force' THEN 'forced'
                   WHEN v_inserted THEN 'enqueued'
                   ELSE 'already_enqueued' END,
    'job_id', v_job_id,
    'job_generation', v_generation,
    'status', v_status,
    'captured_on', v_captured_on,
    'created', v_inserted,
    'accepted_at', v_accepted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_job_for_user(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_job_for_user(uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_job(p_target_kind text, p_target_id uuid, p_mode text DEFAULT 'normal')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $wrapper$
BEGIN
  PERFORM public.ig_collection_assert_owner_caller();
  RETURN public.enqueue_instagram_collection_job_for_user(auth.uid(), p_target_kind, p_target_id, p_mode);
END;
$wrapper$;

-- The account-specific enqueue keeps the same policy, permission and idempotency fences as daily dispatch.
CREATE FUNCTION public.read_meta_analytics_enqueue_scope(p_user_id uuid, p_platform text, p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp SET lock_timeout = '3s' AS $fn$
DECLARE v_policy jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  PERFORM public.meta_analytics_lock_account(p_account_id, p_user_id, p_platform);
  v_policy := public.meta_analytics_collection_policy(p_platform);
  IF v_policy->>'state' = 'disabled' THEN RETURN jsonb_build_object('status','collection_disabled'); END IF;
  IF NOT (v_policy->'account_ids' @> jsonb_build_array(p_account_id::text)) THEN
    RETURN jsonb_build_object('status','not_eligible');
  END IF;
  RETURN jsonb_build_object('status','eligible');
END;
$fn$;
CREATE FUNCTION public.enqueue_meta_analytics_for_user(p_user_id uuid, p_platform text, p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp SET lock_timeout = '3s' AS $fn$
DECLARE v_scope jsonb; v_receipt jsonb; v_retry timestamptz; v_state text;
BEGIN
  v_scope := public.read_meta_analytics_enqueue_scope(p_user_id,p_platform,p_account_id);
  IF v_scope->>'status' <> 'eligible' THEN RETURN v_scope; END IF;
  -- Never force or reset an existing generation, lease, provider retry or operation.
  IF p_platform = 'facebook' THEN
    v_receipt := public.enqueue_fb_analytics_collection_job(p_user_id,p_account_id,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
    SELECT retry_at,state INTO v_retry,v_state FROM public.fb_analytics_collection_jobs
      WHERE id=(v_receipt->>'job_id')::uuid AND user_id=p_user_id AND social_account_id=p_account_id;
  ELSIF p_platform = 'threads' THEN
    v_receipt := public.enqueue_threads_analytics_collection_job(p_user_id,p_account_id,(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date,false);
    SELECT retry_at,state INTO v_retry,v_state FROM public.threads_analytics_collection_jobs
      WHERE id=(v_receipt->>'job_id')::uuid AND user_id=p_user_id AND social_account_id=p_account_id;
  ELSE RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  IF v_retry > clock_timestamp() THEN
    RETURN v_receipt || jsonb_build_object('status','throttled','retry_after_seconds',ceil(extract(epoch FROM v_retry-clock_timestamp()))::integer);
  END IF;
  RETURN v_receipt || jsonb_build_object('status',CASE WHEN v_state='pending' THEN 'queued' ELSE v_state END);
END;
$fn$;
REVOKE ALL ON FUNCTION public.read_meta_analytics_enqueue_scope(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.enqueue_meta_analytics_for_user(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_meta_analytics_enqueue_scope(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_meta_analytics_for_user(uuid,text,uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
