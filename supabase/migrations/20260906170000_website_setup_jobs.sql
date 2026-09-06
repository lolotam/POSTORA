BEGIN;

CREATE TABLE public.ai_website_setup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.ai_knowledge_sources(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('whatsapp','facebook','instagram','threads','youtube')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed','applied')),
  result jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,social_account_id)
);
ALTER TABLE public.ai_website_setup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_website_setup_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ai_website_setup_jobs TO service_role;
CREATE INDEX ai_website_setup_jobs_queue ON public.ai_website_setup_jobs(status,created_at);

-- All service-role operations must use this structural relation, including claims
-- and completion. Source visibility changes revoke eligibility immediately.
CREATE FUNCTION public.website_setup_target_allowed(p_user uuid,p_source uuid,p_account uuid,p_platform text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS (
   SELECT 1 FROM ai_knowledge_sources s JOIN social_accounts a ON a.id=p_account
   WHERE s.id=p_source AND s.user_id=p_user AND s.source_type='website'
     AND a.user_id=p_user AND a.platform=p_platform AND a.is_active
     AND (s.visibility='shared' OR EXISTS (
       SELECT 1 FROM ai_knowledge_source_accounts l WHERE l.source_id=s.id
         AND l.social_account_id=a.id AND l.user_id=p_user))
 );
$$;
REVOKE ALL ON FUNCTION public.website_setup_target_allowed(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.website_setup_target_allowed(uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.create_ai_website_setup_job(p_source_id uuid,p_social_account_id uuid,p_platform text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_user uuid:=auth.uid();
BEGIN
 IF v_user IS NULL OR NOT website_setup_target_allowed(v_user,p_source_id,p_social_account_id,p_platform) THEN
   RAISE EXCEPTION 'Setup target unavailable' USING ERRCODE='42501';
 END IF;
 -- Serialize request/retry budgets for one owner; existing jobs remain idempotent.
 PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text,773));
 SELECT id INTO v_id FROM ai_website_setup_jobs WHERE source_id=p_source_id AND social_account_id=p_social_account_id;
 IF v_id IS NOT NULL THEN RETURN v_id; END IF;
 IF (SELECT count(*) FROM ai_website_setup_jobs WHERE user_id=v_user AND created_at>now()-interval '1 day')>=30 THEN
   RAISE EXCEPTION 'Daily setup generation limit reached' USING ERRCODE='P0001';
 END IF;
 INSERT INTO ai_website_setup_jobs(user_id,source_id,social_account_id,platform)
 VALUES(v_user,p_source_id,p_social_account_id,p_platform) RETURNING id INTO v_id;
 RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_ai_website_setup_job(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_ai_website_setup_job(uuid,uuid,text) TO authenticated;

CREATE FUNCTION public.read_ai_website_setup(p_user_id uuid,p_social_account_id uuid,p_platform text,p_job_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_jobs jsonb; v_config jsonb;
BEGIN
 IF p_job_id IS NOT NULL AND p_social_account_id IS NULL THEN
   SELECT social_account_id,platform INTO p_social_account_id,p_platform FROM ai_website_setup_jobs j
   WHERE j.id=p_job_id AND j.user_id=p_user_id
     AND website_setup_target_allowed(p_user_id,j.source_id,j.social_account_id,j.platform);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM social_accounts WHERE id=p_social_account_id AND user_id=p_user_id AND platform=p_platform AND is_active) THEN
   RAISE EXCEPTION 'Setup target unavailable' USING ERRCODE='42501';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(j)-'lease_token'-'lease_expires_at' ORDER BY j.created_at DESC),'[]') INTO v_jobs
 FROM (SELECT * FROM ai_website_setup_jobs j WHERE j.user_id=p_user_id AND j.social_account_id=p_social_account_id
   AND j.platform=p_platform AND (p_job_id IS NULL OR j.id=p_job_id)
   AND website_setup_target_allowed(p_user_id,j.source_id,j.social_account_id,j.platform)
   ORDER BY created_at DESC LIMIT 30) j;
 SELECT to_jsonb(c) INTO v_config FROM ai_agent_configs c WHERE c.user_id=p_user_id
   AND c.social_account_id=p_social_account_id AND c.platform=p_platform;
 RETURN jsonb_build_object('jobs',v_jobs,'config',v_config);
END;
$$;

CREATE FUNCTION public.retry_ai_website_setup(p_user_id uuid,p_job_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j ai_website_setup_jobs;
BEGIN
 SELECT * INTO j FROM ai_website_setup_jobs WHERE id=p_job_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR NOT website_setup_target_allowed(p_user_id,j.source_id,j.social_account_id,j.platform) THEN
   RAISE EXCEPTION 'Setup target unavailable' USING ERRCODE='42501';
 END IF;
 IF j.status<>'failed' OR j.attempts>=5 THEN RAISE EXCEPTION 'Setup cannot be retried' USING ERRCODE='P0001'; END IF;
 UPDATE ai_website_setup_jobs SET status='pending',error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=j.id;
 RETURN j.id;
END;
$$;

CREATE FUNCTION public.claim_ai_website_setup()
RETURNS SETOF public.ai_website_setup_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
 UPDATE ai_website_setup_jobs j SET status='failed',error='Knowledge indexing failed. Retry indexing, then retry setup.',updated_at=now()
 FROM ai_knowledge_sources s WHERE s.id=j.source_id AND s.user_id=j.user_id AND s.status='failed' AND j.status='pending';
 UPDATE ai_website_setup_jobs SET status='failed',error='Setup generation exceeded its retry limit.',updated_at=now()
 WHERE status='processing' AND lease_expires_at<now() AND attempts>=5;
 SELECT j.id INTO v_id FROM ai_website_setup_jobs j JOIN ai_knowledge_sources s ON s.id=j.source_id AND s.user_id=j.user_id
 WHERE s.status='ready' AND (j.status='pending' OR (j.status='processing' AND j.lease_expires_at<now())) AND j.attempts<5
   AND website_setup_target_allowed(j.user_id,j.source_id,j.social_account_id,j.platform)
 ORDER BY j.updated_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 RETURN QUERY UPDATE ai_website_setup_jobs SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
   lease_expires_at=now()+interval '3 minutes',updated_at=now() WHERE id=v_id RETURNING *;
END;
$$;

CREATE FUNCTION public.finish_ai_website_setup(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_rows integer;
BEGIN
 IF p_result IS NOT NULL AND (jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>50000) THEN
   RAISE EXCEPTION 'Invalid setup result';
 END IF;
 UPDATE ai_website_setup_jobs j SET status=CASE WHEN p_error IS NULL THEN 'ready' ELSE 'failed' END,
   result=p_result,error=left(p_error,300),lease_token=NULL,lease_expires_at=NULL,updated_at=now()
 WHERE j.id=p_job_id AND j.lease_token=p_lease_token AND j.status='processing' AND j.lease_expires_at>now()
   AND website_setup_target_allowed(j.user_id,j.source_id,j.social_account_id,j.platform);
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 RETURN v_rows=1;
END;
$$;

CREATE FUNCTION public.read_ai_website_setup_input(p_job_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j ai_website_setup_jobs; v_source jsonb; v_chunks jsonb;
BEGIN
 SELECT * INTO j FROM ai_website_setup_jobs WHERE id=p_job_id AND lease_token=p_lease_token
   AND status='processing' AND lease_expires_at>now();
 IF NOT FOUND OR NOT website_setup_target_allowed(j.user_id,j.source_id,j.social_account_id,j.platform) THEN
   RAISE EXCEPTION 'Setup target unavailable' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object('file_path',left(s.file_path,2048),'metadata',jsonb_build_object(
   'mode',s.metadata->>'mode','pages_total',s.metadata->'pages_total','pages_done',s.metadata->'pages_done'),
   'chunk_count',s.chunk_count)
 INTO v_source FROM ai_knowledge_sources s WHERE s.id=j.source_id AND s.user_id=j.user_id AND s.status='ready';
 IF v_source IS NULL THEN RAISE EXCEPTION 'Source is not ready'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO v_chunks FROM (
   SELECT left(content,6000) AS content,length(content) AS original_length,
     jsonb_build_object('source_url',left(metadata->>'source_url',2048)) AS metadata FROM ai_knowledge_chunks
   WHERE source_id=j.source_id AND user_id=j.user_id ORDER BY created_at,id LIMIT 160
 ) c;
 RETURN jsonb_build_object('source',v_source,'chunks',v_chunks);
END;
$$;
REVOKE ALL ON FUNCTION public.read_ai_website_setup_input(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_ai_website_setup_input(uuid,uuid) TO service_role;

-- The endpoint validates/merges through the canonical TS validators. Comparing
-- the exact read version under a row lock makes this merge atomic and ensures
-- neither a legacy writer nor a concurrent UI save can be overwritten.
CREATE FUNCTION public.apply_ai_website_setup(p_user_id uuid,p_job_id uuid,p_expected_updated_at timestamptz,
  p_business_profile jsonb,p_agent_behavior jsonb,p_business_profile_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j ai_website_setup_jobs; c ai_agent_configs;
BEGIN
 SELECT * INTO j FROM ai_website_setup_jobs WHERE id=p_job_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR NOT website_setup_target_allowed(p_user_id,j.source_id,j.social_account_id,j.platform) THEN
   RAISE EXCEPTION 'Setup target unavailable' USING ERRCODE='42501';
 END IF;
 IF j.status<>'ready' THEN RAISE EXCEPTION 'Setup draft is not ready' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(j.social_account_id::text,774));
 SELECT * INTO c FROM ai_agent_configs WHERE user_id=p_user_id AND social_account_id=j.social_account_id AND platform=j.platform FOR UPDATE;
 IF c.updated_at IS DISTINCT FROM p_expected_updated_at THEN
   RAISE EXCEPTION 'Configuration changed. Reload before applying.' USING ERRCODE='40001';
 END IF;
 IF c.id IS NULL THEN
   INSERT INTO ai_agent_configs(user_id,social_account_id,platform,business_profile,agent_behavior,business_profile_text)
   VALUES(p_user_id,j.social_account_id,j.platform,p_business_profile,p_agent_behavior,p_business_profile_text) RETURNING * INTO c;
 ELSE
   UPDATE ai_agent_configs SET business_profile=p_business_profile,agent_behavior=p_agent_behavior,
     business_profile_text=p_business_profile_text,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
 END IF;
 UPDATE ai_website_setup_jobs SET status='applied',updated_at=now() WHERE id=j.id;
 RETURN to_jsonb(c);
END;
$$;

REVOKE ALL ON FUNCTION public.read_ai_website_setup(uuid,uuid,text,uuid),public.retry_ai_website_setup(uuid,uuid),
 public.claim_ai_website_setup(),public.finish_ai_website_setup(uuid,uuid,jsonb,text),
 public.apply_ai_website_setup(uuid,uuid,timestamptz,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_ai_website_setup(uuid,uuid,text,uuid),public.retry_ai_website_setup(uuid,uuid),
 public.claim_ai_website_setup(),public.finish_ai_website_setup(uuid,uuid,jsonb,text),
 public.apply_ai_website_setup(uuid,uuid,timestamptz,jsonb,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
