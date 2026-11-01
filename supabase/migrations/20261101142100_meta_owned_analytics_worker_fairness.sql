-- Two durable platform turns prevent a slow first platform monopolizing all drains.
BEGIN;
CREATE TABLE public.meta_analytics_worker_turns (
  platform text PRIMARY KEY CHECK(platform IN ('facebook','threads')),
  last_claimed_at timestamptz NOT NULL DEFAULT 'epoch' CHECK(isfinite(last_claimed_at))
);
ALTER TABLE public.meta_analytics_worker_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_analytics_worker_turns FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.meta_analytics_worker_turns(platform) VALUES('facebook'),('threads');

CREATE FUNCTION public.claim_meta_analytics_collection_job(p_platform text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=public,pg_temp SET lock_timeout='3s' AS $fn$
DECLARE v_platform text;v_jobs jsonb;
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_platform IS NULL OR p_platform NOT IN ('facebook','threads','all') THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_PLATFORM' USING ERRCODE='MAH01'; END IF;
  -- Ordering is a non-locking hint. Native claims retain parent-first locks
  -- and repeat current policy/authority before issuing a claim.
  FOR v_platform IN SELECT platform FROM public.meta_analytics_worker_turns
    WHERE p_platform='all' OR platform=p_platform ORDER BY last_claimed_at,platform LOOP
    IF v_platform='facebook' THEN v_jobs:=public.claim_fb_analytics_collection_jobs(1);
    ELSE v_jobs:=public.claim_threads_analytics_collection_jobs(1); END IF;
    IF jsonb_array_length(v_jobs)>0 THEN
      UPDATE public.meta_analytics_worker_turns SET last_claimed_at=clock_timestamp() WHERE platform=v_platform;
      RETURN v_jobs->0||jsonb_build_object('platform',v_platform);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.claim_meta_analytics_collection_job(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_meta_analytics_collection_job(text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
