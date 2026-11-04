-- 20261104130000_instagram_owner_period_reach.sql
--
-- The exact unique reach of an owner account over a period of closed Kuwait
-- days.
--
-- Why a table of its own:
--   Reach is a count of UNIQUE accounts. The daily rows of
--   ig_account_insight_daily each carry the unique reach of ONE day, and an
--   account reached on two days is in both, so a sum of daily reach counts it
--   twice. The report therefore had no period reach at all. Meta answers the
--   unique reach of a whole range with one `total_value` request of at most
--   thirty days; this table stores that answer.
--
-- What it stores:
--   One row per (account, metric, since_date, until_date). `value` is the
--   provider total. A range the provider did not report is `unavailable` with
--   a NULL value - it is never a zero.
--
-- How it is written:
--   Only through persist_instagram_owner_period_total, behind the accepted
--   collection fence (ig_collection_load_fenced_job): the claim, the lease,
--   the generation, the bound context and the rollout admission. The range
--   must END on the job's last closed day (captured_on - 1), so a job can
--   never write a period it was not asked to capture.
--
-- How it is read:
--   read_instagram_owner_report_snapshot is replaced with the same signature
--   and the same grants; it now also returns `period_totals`.
--
-- RLS, grants and ownership mirror ig_account_insight_daily: owners read
-- their own rows, the service role writes, nobody else touches the table.
BEGIN;

DO $dependencies$ BEGIN
  PERFORM 'public.ig_collection_assert_service_caller()'::regprocedure;
  PERFORM 'public.ig_collection_load_fenced_job(uuid,uuid,bigint,boolean,uuid)'::regprocedure;
  PERFORM 'public.ig_collection_assert_lease_live(timestamptz)'::regprocedure;
  PERFORM 'public.ig_collection_date(jsonb,text)'::regprocedure;
  PERFORM 'public.ig_collection_timestamp(jsonb,text)'::regprocedure;
  PERFORM 'public.ig_collection_text(jsonb,text,integer)'::regprocedure;
  PERFORM 'public.ig_collection_metric_int(jsonb,text)'::regprocedure;
  PERFORM 'public.update_updated_at_column()'::regprocedure;
  PERFORM 'public.read_instagram_owner_report_snapshot(uuid,uuid,timestamptz)'::regprocedure;
END $dependencies$;

-- ===========================================================================
-- 1. The table.
-- ===========================================================================

CREATE TABLE public.ig_account_insight_period_totals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  social_account_id  uuid NOT NULL,
  metric             text NOT NULL,
  period_days        integer NOT NULL,
  since_date         date NOT NULL,
  until_date         date NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  provider_timezone  text NOT NULL,
  value              bigint,
  status             text NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ig_account_insight_period_totals_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT ig_account_insight_period_totals_range_key
    UNIQUE (social_account_id, metric, since_date, until_date),

  -- Only unique reach needs a period total: every other account metric is a
  -- plain count and its period value IS the sum of its days.
  CONSTRAINT ig_account_insight_period_totals_metric_chk
    CHECK (metric = 'reach'),
  -- Meta refuses a since/until range longer than thirty days, and a one-day
  -- period is the daily row itself.
  CONSTRAINT ig_account_insight_period_totals_days_chk
    CHECK (period_days BETWEEN 2 AND 30),
  CONSTRAINT ig_account_insight_period_totals_range_chk
    CHECK (until_date - since_date + 1 = period_days),
  CONSTRAINT ig_account_insight_period_totals_period_chk
    CHECK (period_end > period_start),
  CONSTRAINT ig_account_insight_period_totals_provider_timezone_chk
    CHECK (char_length(provider_timezone) > 0 AND char_length(provider_timezone) <= 64),
  CONSTRAINT ig_account_insight_period_totals_status_chk
    CHECK (status IN ('ok', 'unavailable')),
  -- A stored total is a number the provider reported; an unavailable range
  -- carries no number at all. A missing value is never a zero.
  CONSTRAINT ig_account_insight_period_totals_value_chk
    CHECK ((status = 'ok' AND value IS NOT NULL AND value >= 0)
           OR (status = 'unavailable' AND value IS NULL))
);

CREATE INDEX idx_ig_account_insight_period_totals_owner_until
  ON public.ig_account_insight_period_totals (user_id, until_date DESC);
CREATE INDEX idx_ig_account_insight_period_totals_account_until
  ON public.ig_account_insight_period_totals (social_account_id, until_date DESC);

COMMENT ON TABLE public.ig_account_insight_period_totals IS
  'The provider''s exact unique reach of an Instagram owner account over a '
  'range of closed Asia/Kuwait days (2 to 30 days, the longest range Meta '
  'accepts). One row per (account, metric, since_date, until_date). It is '
  'never derived from the daily rows: a sum of daily reach double-counts an '
  'account reached on several days.';

CREATE TRIGGER update_ig_account_insight_period_totals_updated_at
  BEFORE UPDATE ON public.ig_account_insight_period_totals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 2. RLS and grants, mirroring ig_account_insight_daily.
-- ===========================================================================

ALTER TABLE public.ig_account_insight_period_totals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read their own rows" ON public.ig_account_insight_period_totals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.ig_account_insight_period_totals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ig_account_insight_period_totals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ig_account_insight_period_totals TO service_role;

-- ===========================================================================
-- 3. The fenced writer.
--
-- Payload:
--   { "metric": "reach", "period_days": 30,
--     "since_date": "YYYY-MM-DD", "until_date": "YYYY-MM-DD",
--     "period_start": "...", "period_end": "...",
--     "provider_timezone": "Asia/Kuwait",
--     "status": "ok" | "unavailable", "value": <integer> | null }
--
-- Receipt: { "job_id", "job_generation", "written": 1 } - the same shape as
-- the snapshot writer's, so the worker binds it the same way.
-- ===========================================================================

CREATE FUNCTION public.persist_instagram_owner_period_total(
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
  v_job          public.instagram_collection_jobs%ROWTYPE;
  v_metric       text;
  v_days         integer;
  v_since        date;
  v_until        date;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_tz           text;
  v_status       text;
  v_value        bigint;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, true, NULL);

  IF v_job.target_kind <> 'owner' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: a period total belongs to an owner job'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: the payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  v_metric := public.ig_collection_text(p_payload, 'metric', 32);
  IF v_metric IS DISTINCT FROM 'reach' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: the only period metric is reach'
      USING ERRCODE = '22023';
  END IF;

  -- COALESCE: an absent key must be refused here, not slip through a NULL
  -- comparison and fail later as a NOT NULL violation.
  IF COALESCE(jsonb_typeof(p_payload -> 'period_days'), 'null') <> 'number'
     OR (p_payload ->> 'period_days') !~ '^[0-9]{1,2}$' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: period_days must be a whole number of days'
      USING ERRCODE = '22023';
  END IF;
  v_days := (p_payload ->> 'period_days')::integer;

  v_since        := public.ig_collection_date(p_payload, 'since_date');
  v_until        := public.ig_collection_date(p_payload, 'until_date');
  v_period_start := public.ig_collection_timestamp(p_payload, 'period_start');
  v_period_end   := public.ig_collection_timestamp(p_payload, 'period_end');
  v_tz           := public.ig_collection_text(p_payload, 'provider_timezone', 64);

  IF v_since IS NULL OR v_until IS NULL OR v_period_start IS NULL
     OR v_period_end IS NULL OR v_tz IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: the range, its instants and its timezone are required'
      USING ERRCODE = '22023';
  END IF;

  -- The range ends on the job's last closed day. A job never writes a
  -- period it was not asked to capture.
  IF v_until <> v_job.captured_on - 1 THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: a period total ends on the last closed day of its job'
      USING ERRCODE = '22023';
  END IF;

  IF v_days < 2 OR v_days > 30 OR v_since <> v_until - (v_days - 1) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: a period total spans 2 to 30 whole days'
      USING ERRCODE = '22023';
  END IF;

  v_status := lower(public.ig_collection_text(p_payload, 'status', 32));
  IF v_status IS NULL OR v_status NOT IN ('ok', 'unavailable') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: a period total is ok or unavailable'
      USING ERRCODE = '22023';
  END IF;

  -- A non-number, a negative or a fractional value is refused by the
  -- accepted metric reader, never turned into a zero.
  v_value := public.ig_collection_metric_int(p_payload, 'value');
  IF (v_status = 'ok' AND v_value IS NULL) OR (v_status = 'unavailable' AND v_value IS NOT NULL) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: an ok total carries a value and an unavailable one carries none'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  INSERT INTO public.ig_account_insight_period_totals AS t (
    user_id, social_account_id, metric, period_days, since_date, until_date,
    period_start, period_end, provider_timezone, value, status, captured_at
  )
  VALUES (
    v_job.user_id, v_job.social_account_id, v_metric, v_days, v_since, v_until,
    v_period_start, v_period_end, v_tz, v_value, v_status, now()
  )
  ON CONFLICT (social_account_id, metric, since_date, until_date) DO UPDATE
     SET period_days       = EXCLUDED.period_days,
         period_start      = EXCLUDED.period_start,
         period_end        = EXCLUDED.period_end,
         provider_timezone = EXCLUDED.provider_timezone,
         value             = EXCLUDED.value,
         status            = EXCLUDED.status,
         captured_at       = EXCLUDED.captured_at;

  RETURN jsonb_build_object(
    'job_id', v_job.id,
    'job_generation', v_job.job_generation,
    'written', 1
  );
END;
$function$;

-- The non-retrying HTTP wrapper: PostgREST retries SQLSTATE 40001, so the
-- named collection refusals are translated to PT409, exactly as for the
-- accepted writers (20261101023000_instagram_collection_http_fences.sql).
CREATE FUNCTION public.persist_instagram_owner_period_total_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_payload jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.persist_instagram_owner_period_total(p_job_id,p_claim_token,p_job_generation,p_payload);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_instagram_owner_period_total(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_instagram_owner_period_total_http(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_instagram_owner_period_total(uuid,uuid,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_instagram_owner_period_total_http(uuid,uuid,bigint,jsonb) TO service_role;

COMMENT ON FUNCTION public.persist_instagram_owner_period_total(uuid,uuid,bigint,jsonb) IS
  'Stores the provider''s unique reach of a range of closed Kuwait days for '
  'the fenced owner job. The range must end on captured_on - 1 and span 2 to '
  '30 days. A missing total is unavailable, never a zero.';

-- ===========================================================================
-- 4. The report snapshot, now with the period totals.
--
-- Same signature, same grants (CREATE OR REPLACE keeps them). Every key the
-- earlier version returned is returned unchanged.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_instagram_owner_report_snapshot(p_user_id uuid,p_account_id uuid,p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
DECLARE v_owner uuid;v_media jsonb;v_daily jsonb;v_profiles jsonb;v_period_totals jsonb;v_collection jsonb;
BEGIN
  IF auth.role()='authenticated' THEN v_owner:=auth.uid();
  ELSIF auth.role()='service_role' THEN v_owner:=p_user_id;
  ELSE RAISE EXCEPTION 'REPORT_CALLER_NOT_ALLOWED' USING ERRCODE='42501';END IF;
  IF v_owner IS NULL OR p_as_of IS NULL OR NOT isfinite(p_as_of) THEN
    RAISE EXCEPTION 'REPORT_INVALID_REQUEST' USING ERRCODE='MAH01';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.social_accounts WHERE id=p_account_id AND user_id=v_owner AND platform='instagram' AND is_active) THEN
    RAISE EXCEPTION 'REPORT_ACCOUNT_NOT_FOUND' USING ERRCODE='MAH02';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_media FROM (
    SELECT id,user_id,social_account_id,post_id,ig_media_id,published_at,captured_at,captured_on,capture_timezone,media_product_type,media_type,permalink,thumbnail_url,status,views,reach,likes,comments,saved,shares,total_interactions,follows,profile_visits,replies,ig_reels_avg_watch_time_ms FROM public.ig_media_insight_snapshots
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_media)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_daily FROM (
    SELECT id,user_id,social_account_id,metric_date,provider_date,period_start,period_end,provider_timezone,status,captured_at,reach,views,accounts_engaged,total_interactions,likes,comments,saves,shares,follows,unfollows FROM public.ig_account_insight_daily
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_daily)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_profiles FROM (
    SELECT id,user_id,social_account_id,observed_at,observed_on,capture_timezone,status,followers_count,media_count FROM public.ig_account_profile_observations
    WHERE user_id=v_owner AND social_account_id=p_account_id AND observed_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_profiles)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO v_period_totals FROM (
    SELECT id,user_id,social_account_id,metric,period_days,since_date,until_date,period_start,period_end,provider_timezone,status,value,captured_at FROM public.ig_account_insight_period_totals
    WHERE user_id=v_owner AND social_account_id=p_account_id AND captured_at<=p_as_of ORDER BY id LIMIT 20001
  ) r;
  IF jsonb_array_length(v_period_totals)>20000 THEN RAISE EXCEPTION 'REPORT_HISTORY_BOUND_EXCEEDED' USING ERRCODE='MAH05';END IF;
  SELECT jsonb_build_object('status',j.status,'last_attempt_at',j.last_attempt_at,
    'last_success_at',(SELECT max(last_success_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id AND last_success_at<=p_as_of),
    'last_partial_at',(SELECT max(last_partial_at) FROM public.instagram_collection_jobs WHERE user_id=v_owner AND social_account_id=p_account_id AND target_kind='owner' AND target_id=p_account_id AND last_partial_at<=p_as_of),
    'next_retry_at',j.retry_at,'reason_code',j.last_reason_code,'inventory',jsonb_build_object(
      'truncated',COALESCE(c.inventory_truncated,false),'partial',COALESCE(c.inventory_partial,j.status='partial'),
      'window_covered',COALESCE(c.inventory_window_covered,false))) INTO v_collection
    FROM public.instagram_collection_jobs j LEFT JOIN public.instagram_collection_job_checkpoints c
      ON c.job_id=j.id AND c.job_generation=j.job_generation AND c.user_id=v_owner AND c.updated_at<=p_as_of
    WHERE j.user_id=v_owner AND j.social_account_id=p_account_id AND j.target_kind='owner' AND j.target_id=p_account_id
      AND greatest(j.created_at,j.updated_at,j.last_attempt_at,j.last_success_at,j.last_partial_at)<=p_as_of
    ORDER BY j.captured_on DESC,j.id DESC LIMIT 1;
  RETURN jsonb_build_object('account_id',p_account_id,'owner_id',v_owner,'media',v_media,'daily',v_daily,'profiles',v_profiles,'period_totals',v_period_totals,'collection',v_collection);
END;$fn$;

NOTIFY pgrst, 'reload schema';
COMMIT;
