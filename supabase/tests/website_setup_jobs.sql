-- Run only in a disposable PostgreSQL database named website_setup_test.
-- This focused fixture exercises the actual migration, not a mock SQL adapter.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'website_setup_test' THEN RAISE EXCEPTION 'Disposable database required'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
CREATE TABLE public.social_accounts(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),platform text,is_active boolean DEFAULT true);
CREATE TABLE public.ai_knowledge_sources(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),source_type text,status text,
 visibility text DEFAULT 'shared',file_path text,metadata jsonb,chunk_count integer DEFAULT 0);
CREATE TABLE public.ai_knowledge_source_accounts(source_id uuid,social_account_id uuid,user_id uuid);
CREATE TABLE public.ai_knowledge_chunks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid,user_id uuid,content text,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE public.ai_agent_configs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,social_account_id uuid UNIQUE,
 platform text,business_profile jsonb DEFAULT '{}',agent_behavior jsonb DEFAULT '{}',business_profile_text text,
 is_enabled boolean DEFAULT false,admin_phone_numbers text[] DEFAULT '{}',updated_at timestamptz DEFAULT now());
\ir ../migrations/20260906170000_website_setup_jobs.sql

INSERT INTO auth.users VALUES('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
INSERT INTO social_accounts(id,user_id,platform) VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','whatsapp'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','whatsapp');
INSERT INTO ai_knowledge_sources(id,user_id,source_type,status,file_path,metadata) VALUES
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','website','ready','https://example.com','{"mode":"page"}'),
 ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','website','ready','https://other.example','{"mode":"page"}');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',false);

DO $$ DECLARE job uuid; same_job uuid; claimed ai_website_setup_jobs; old_lease uuid; config jsonb; extraction_input jsonb;
BEGIN
 -- Cross-owner creation and platform mismatch are denied even inside definer SQL.
 BEGIN
  PERFORM create_ai_website_setup_job('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','whatsapp');
  RAISE EXCEPTION 'Cross-owner source accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM create_ai_website_setup_job('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','whatsapp');
  RAISE EXCEPTION 'Cross-owner account accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM create_ai_website_setup_job('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','instagram');
  RAISE EXCEPTION 'Wrong platform accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 job:=create_ai_website_setup_job('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','whatsapp');
 same_job:=create_ai_website_setup_job('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','whatsapp');
 IF job<>same_job THEN RAISE EXCEPTION 'Repeated create duplicated the job'; END IF;
 SELECT * INTO claimed FROM claim_ai_website_setup();
 old_lease:=claimed.lease_token;
 IF claimed.id<>job OR claimed.attempts<>1 THEN RAISE EXCEPTION 'Claim failed'; END IF;
 INSERT INTO ai_knowledge_chunks(source_id,user_id,content,metadata)
 VALUES(claimed.source_id,claimed.user_id,repeat('a',9000),'{"source_url":"https://example.com/products"}');
 extraction_input:=read_ai_website_setup_input(job,claimed.lease_token);
 IF length(extraction_input#>>'{chunks,0,content}')<>6000 OR (extraction_input#>>'{chunks,0,original_length}')::integer<>9000 THEN
   RAISE EXCEPTION 'Input did not preserve bounded extraction coverage';
 END IF;
 IF EXISTS(SELECT 1 FROM claim_ai_website_setup()) THEN RAISE EXCEPTION 'Active lease was claimed twice'; END IF;
 UPDATE ai_website_setup_jobs SET lease_expires_at=now()-interval '1 minute' WHERE id=job;
 SELECT * INTO claimed FROM claim_ai_website_setup();
 IF claimed.lease_token=old_lease OR claimed.attempts<>2 THEN RAISE EXCEPTION 'Expired lease not reclaimed'; END IF;
 IF finish_ai_website_setup(job,old_lease,'{}',NULL) THEN RAISE EXCEPTION 'Stale worker overwrote result'; END IF;
 -- Revoking source visibility also revokes an already-claimed worker.
 UPDATE ai_knowledge_sources SET visibility='restricted' WHERE id=claimed.source_id;
 IF finish_ai_website_setup(job,claimed.lease_token,'{}',NULL) THEN RAISE EXCEPTION 'Unlinked source completion accepted'; END IF;
 INSERT INTO ai_knowledge_source_accounts VALUES(claimed.source_id,claimed.social_account_id,claimed.user_id);
 IF NOT finish_ai_website_setup(job,claimed.lease_token,'{"business_profile":{"products":"Mugs"},"agent_behavior":{}}',NULL) THEN RAISE EXCEPTION 'Valid completion failed'; END IF;
 BEGIN
  PERFORM read_ai_website_setup('10000000-0000-0000-0000-000000000002',NULL,NULL,job);
  RAISE EXCEPTION 'Foreign user read job';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM apply_ai_website_setup('10000000-0000-0000-0000-000000000002',job,NULL,'{}','{}','');
  RAISE EXCEPTION 'Foreign user applied job';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 config:=apply_ai_website_setup(claimed.user_id,job,NULL,'{"products":"Mugs"}','{"tone":"formal"}','Products and services: Mugs');
 IF config->>'business_profile_text'<>'Products and services: Mugs' OR (config->>'is_enabled')::boolean THEN RAISE EXCEPTION 'Unsafe config creation'; END IF;
 UPDATE ai_website_setup_jobs SET status='ready' WHERE id=job;
 UPDATE ai_agent_configs SET is_enabled=true,admin_phone_numbers=ARRAY['private-number'],updated_at=now()+interval '1 second' WHERE id=(config->>'id')::uuid;
 BEGIN
  PERFORM apply_ai_website_setup(claimed.user_id,job,(config->>'updated_at')::timestamptz,'{}','{}','');
  RAISE EXCEPTION 'Concurrent config edit was overwritten';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 SELECT to_jsonb(c) INTO config FROM ai_agent_configs c WHERE id=(config->>'id')::uuid;
 config:=apply_ai_website_setup(claimed.user_id,job,(config->>'updated_at')::timestamptz,'{"products":"Cups"}','{}','Products and services: Cups');
 IF NOT (config->>'is_enabled')::boolean OR config->'admin_phone_numbers'<>'["private-number"]'::jsonb THEN RAISE EXCEPTION 'Operational settings were changed'; END IF;
 UPDATE ai_website_setup_jobs SET status='failed',attempts=4 WHERE id=job;
 PERFORM retry_ai_website_setup(claimed.user_id,job);
 SELECT * INTO claimed FROM claim_ai_website_setup();
 IF claimed.attempts<>5 THEN RAISE EXCEPTION 'Retry did not preserve the attempt budget'; END IF;
 PERFORM finish_ai_website_setup(job,claimed.lease_token,NULL,'Model unavailable');
 BEGIN
  PERFORM retry_ai_website_setup(claimed.user_id,job);
  RAISE EXCEPTION 'Retry budget was bypassed' USING ERRCODE='22000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
END $$;

DO $$ BEGIN
 IF has_table_privilege('authenticated','ai_website_setup_jobs','INSERT') OR
    has_function_privilege('authenticated','apply_ai_website_setup(uuid,uuid,timestamptz,jsonb,jsonb,text)','EXECUTE') OR
    has_function_privilege('anon','claim_ai_website_setup()','EXECUTE') THEN
   RAISE EXCEPTION 'Untrusted caller can forge trusted job state';
 END IF;
END $$;
SELECT 'website_setup_jobs: tenancy, visibility, leases, idempotence, CAS and operational preservation passed' AS result;
\echo website_setup_jobs: ALL CHECKS PASSED
