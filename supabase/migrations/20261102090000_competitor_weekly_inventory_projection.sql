-- Preserve the deployed reader while adding one owner-scoped whole-window count.
-- Display pagination must not decide how many observed posts a week contains.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_competitor_media_owner_observed
  ON public.competitor_media_snapshots (watchlist_id, user_id, captured_at DESC)
  WHERE status = 'ok';

CREATE OR REPLACE FUNCTION public.read_own_competitor_tracking_report_v2(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $function$
DECLARE
  v_owner uuid := auth.uid();
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
  v_raw := public.read_own_competitor_tracking_report(p_request);
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

REVOKE ALL ON FUNCTION public.read_own_competitor_tracking_report_v2(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_own_competitor_tracking_report_v2(jsonb) TO authenticated;
COMMENT ON FUNCTION public.read_own_competitor_tracking_report_v2(jsonb) IS
  'Owner-only report projection with a distinct observed-post count independent of list/detail media pagination. Reuses the original strict reader and keeps its public DTO and cursors unchanged; no provider calls.';

NOTIFY pgrst, 'reload schema';
COMMIT;
