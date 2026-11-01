-- PostgREST 12 uses Hasql's retrying transaction session: business refusals
-- with SQLSTATE 40001 never reach the caller and continuously retry the same
-- stale claim. Preserve the accepted native SQL contracts and expose typed,
-- service-only HTTP wrappers translating only named collection refusals.
-- Real PostgreSQL serialization failures retain their original SQLSTATE.
BEGIN;

DO $dependencies$ BEGIN
  PERFORM 'public.persist_instagram_collection_snapshot(uuid,uuid,bigint,jsonb)'::regprocedure;
  PERFORM 'public.record_instagram_collection_job_progress(uuid,uuid,bigint,jsonb)'::regprocedure;
  PERFORM 'public.complete_instagram_collection_job(uuid,uuid,bigint,text,text)'::regprocedure;
  PERFORM 'public.record_instagram_provider_throttle(text,integer,timestamptz,uuid,uuid,bigint)'::regprocedure;
  PERFORM 'public.read_instagram_direct_collection_credential(uuid,uuid,bigint,bigint)'::regprocedure;
END $dependencies$;

CREATE FUNCTION public.persist_instagram_collection_snapshot_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_payload jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.persist_instagram_collection_snapshot(p_job_id,p_claim_token,p_job_generation,p_payload);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

CREATE FUNCTION public.record_instagram_collection_job_progress_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_payload jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.record_instagram_collection_job_progress(p_job_id,p_claim_token,p_job_generation,p_payload);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

CREATE FUNCTION public.complete_instagram_collection_job_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_outcome text, p_reason_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.complete_instagram_collection_job(p_job_id,p_claim_token,p_job_generation,p_outcome,p_reason_code);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

CREATE FUNCTION public.record_instagram_provider_throttle_http(
  p_bucket_key text, p_usage_percent integer, p_throttled_until timestamptz,
  p_job_id uuid DEFAULT NULL, p_claim_token uuid DEFAULT NULL, p_job_generation bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.record_instagram_provider_throttle(p_bucket_key,p_usage_percent,p_throttled_until,p_job_id,p_claim_token,p_job_generation);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

CREATE FUNCTION public.read_instagram_direct_collection_credential_http(
  p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_expected_credential_generation bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.read_instagram_direct_collection_credential(p_job_id,p_claim_token,p_job_generation,p_expected_credential_generation);
EXCEPTION WHEN serialization_failure THEN
  IF split_part(SQLERRM, ':', 1) IN ('IG_COLLECTION_CLAIM_STALE','IG_COLLECTION_CREDENTIAL_CHANGED','IG_COLLECTION_LOCK_RETRY') THEN
    RAISE EXCEPTION USING ERRCODE='PT409', MESSAGE='IG_COLLECTION_CLAIM_STALE: captured collection context is no longer current';
  END IF;
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_instagram_collection_snapshot_http(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_instagram_collection_job_progress_http(uuid,uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_instagram_collection_job_http(uuid,uuid,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_instagram_provider_throttle_http(text,integer,timestamptz,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_instagram_direct_collection_credential_http(uuid,uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_instagram_collection_snapshot_http(uuid,uuid,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_instagram_collection_job_progress_http(uuid,uuid,bigint,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job_http(uuid,uuid,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_instagram_provider_throttle_http(text,integer,timestamptz,uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_instagram_direct_collection_credential_http(uuid,uuid,bigint,bigint) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
