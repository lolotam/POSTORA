-- Shared bucket observation; writes continue through the existing fenced RPC.
BEGIN;
CREATE FUNCTION public.read_meta_analytics_provider_throttle(p_bucket_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $fn$
BEGIN
  PERFORM public.meta_analytics_assert_service();
  IF p_bucket_key IS NULL OR p_bucket_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'META_ANALYTICS_INVALID_BUCKET' USING ERRCODE='MAH01'; END IF;
  RETURN (SELECT jsonb_build_object('usage_percent',usage_percent,'throttled_until',throttled_until)
    FROM public.instagram_provider_throttle_buckets WHERE bucket_key=p_bucket_key);
END;
$fn$;
REVOKE ALL ON FUNCTION public.read_meta_analytics_provider_throttle(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_meta_analytics_provider_throttle(text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
