-- Higgsfield OAuth, model catalog, and async generation jobs. Safe to re-run.
ALTER TABLE public.provider_api_keys ALTER COLUMN api_key DROP NOT NULL;
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'api_key';
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS access_token text;
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS refresh_token text;
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE public.provider_api_keys ADD COLUMN IF NOT EXISTS account_id text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='provider_api_keys_credential_present') THEN
  ALTER TABLE public.provider_api_keys ADD CONSTRAINT provider_api_keys_credential_present CHECK (api_key IS NOT NULL OR access_token IS NOT NULL);
 END IF;
END $$;

ALTER TABLE public.ai_providers ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'api_key';
INSERT INTO public.ai_providers (provider_code,name,api_endpoint,api_key_env_var,api_type,auth_type,supports_streaming,is_active)
VALUES ('higgsfield','Higgsfield Hub','https://mcp.higgsfield.ai/mcp','HIGGSFIELD_ACCESS_TOKEN','higgsfield','oauth',false,true)
ON CONFLICT (provider_code) DO UPDATE SET name=EXCLUDED.name,api_endpoint=EXCLUDED.api_endpoint,api_type=EXCLUDED.api_type,auth_type=EXCLUDED.auth_type,supports_streaming=EXCLUDED.supports_streaming,is_active=EXCLUDED.is_active;

CREATE TABLE IF NOT EXISTS public.higgsfield_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
 access_token text NOT NULL, refresh_token text, expires_at timestamptz, scope text, account_id text, account_email text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.higgsfield_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS higgsfield_connections_client_select ON public.higgsfield_connections;
DROP POLICY IF EXISTS higgsfield_connections_client_delete ON public.higgsfield_connections;
CREATE POLICY higgsfield_connections_client_select ON public.higgsfield_connections FOR SELECT TO authenticated USING (auth.uid()=user_id);
CREATE POLICY higgsfield_connections_client_delete ON public.higgsfield_connections FOR DELETE TO authenticated USING (auth.uid()=user_id);
-- Status-only projection for the browser. Two things make this safe, and both are
-- required: the WHERE clause scopes rows to the caller, and security_invoker makes
-- the underlying table's RLS apply to the view as well. Without security_invoker a
-- view runs as its DEFINER (the migration role), which bypasses RLS entirely and
-- would expose every user's account_email to every authenticated caller.
CREATE OR REPLACE VIEW public.higgsfield_connection_status AS
 SELECT user_id, account_email, expires_at, true AS connected
 FROM public.higgsfield_connections
 WHERE user_id = auth.uid();
ALTER VIEW public.higgsfield_connection_status SET (security_invoker = on);
-- Tokens must never be client-readable: revoke the base table outright. The
-- owner-select policy above therefore never grants a token read; it exists so that
-- a future explicit GRANT cannot widen access beyond the owner.
REVOKE ALL ON public.higgsfield_connections FROM anon, authenticated;
GRANT DELETE ON public.higgsfield_connections TO authenticated;
-- security_invoker means the caller needs SELECT on the base table for the view to
-- resolve; grant only the non-secret columns, never access_token/refresh_token.
GRANT SELECT (user_id, account_email, expires_at) ON public.higgsfield_connections TO authenticated;
GRANT SELECT ON public.higgsfield_connection_status TO authenticated;

CREATE TABLE IF NOT EXISTS public.oauth_clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_code text NOT NULL, issuer text NOT NULL, redirect_uri text NOT NULL,
 client_id text NOT NULL, client_secret text, registration_response jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_code,redirect_uri)
);
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oauth_clients_deny ON public.oauth_clients;
CREATE POLICY oauth_clients_deny ON public.oauth_clients FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.oauth_states (
 state text PRIMARY KEY, provider_code text NOT NULL, code_verifier text NOT NULL, redirect_uri text NOT NULL,
 scope_kind text NOT NULL CHECK (scope_kind IN ('platform','user')), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
 return_to text, expires_at timestamptz NOT NULL DEFAULT (now()+interval '10 minutes'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states(expires_at);
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oauth_states_deny ON public.oauth_states;
CREATE POLICY oauth_states_deny ON public.oauth_states FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.ai_generation_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 provider text NOT NULL, model_id text NOT NULL, modality text NOT NULL CHECK (modality IN ('image','video')),
 credential_source text NOT NULL CHECK (credential_source IN ('platform','byo')), status text NOT NULL DEFAULT 'queued',
 provider_job_id text, params jsonb NOT NULL DEFAULT '{}'::jsonb, result_url text, media_file_id uuid, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_user_created ON public.ai_generation_jobs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_provider_job ON public.ai_generation_jobs(provider_job_id);
ALTER TABLE public.ai_generation_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_generation_jobs_owner_select ON public.ai_generation_jobs;
CREATE POLICY ai_generation_jobs_owner_select ON public.ai_generation_jobs FOR SELECT TO authenticated USING (auth.uid()=user_id);

INSERT INTO public.ai_models (provider_id,model_id,name,description,capabilities,is_active)
SELECT p.id,v.model_id,v.name,v.description,v.capabilities,true FROM public.ai_providers p CROSS JOIN (VALUES
 ('cinematic_studio_3_0','Higgsfield Cinema Studio 3.0','Cinema-grade video',ARRAY['video']::text[]),
 ('cinematic_studio_video_v2','Higgsfield Cinema Studio Video v2','Cinematic video',ARRAY['video']::text[]),
 ('marketing_studio_video','Higgsfield Marketing Studio Video','Product ads',ARRAY['video']::text[]),
 ('nano_banana_2','Nano Banana 2','High-quality images',ARRAY['image']::text[]),
 ('nano_banana_pro','Nano Banana Pro','Top quality images',ARRAY['image']::text[]),
 ('gpt_image_2','GPT Image 2','Text rendering and editing',ARRAY['image']::text[]),
 ('soul_2','Higgsfield Soul 2.0','Realistic UGC',ARRAY['image']::text[]),
 ('cinematic_studio_2_5','Cinema Studio Image 2.5','Cinematic stills',ARRAY['image']::text[]),
 ('marketing_studio_image','Marketing Studio Image','Product image ads',ARRAY['image']::text[])
) v(model_id,name,description,capabilities) WHERE p.provider_code='higgsfield'
ON CONFLICT (provider_id,model_id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,capabilities=EXCLUDED.capabilities,is_active=true;

-- ---------------------------------------------------------------------------
-- AI generation quota
--
-- Modelled on reserve_partner_quota (20260813120000): RESERVE before dispatch,
-- SETTLE or RELEASE after, rather than a single increment-then-check. A generation
-- that the provider rejects must not consume the user's daily allowance, and a
-- check-then-increment would race two concurrent requests past the limit.
--
-- Only PLATFORM-credential generations are metered. A user generating on their own
-- Higgsfield connection pays the provider directly, so charging them Postora quota
-- as well would bill them twice for one image.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_quotas
  ADD COLUMN IF NOT EXISTS max_ai_generations_per_day integer DEFAULT 20,
  ADD COLUMN IF NOT EXISTS ai_generations_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_generations_reset_date date;

CREATE OR REPLACE FUNCTION public.reserve_ai_generation_quota(p_user_id uuid)
RETURNS TABLE (allowed boolean, usage_count integer, daily_limit integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_count integer;
BEGIN
  -- Roll the daily window and increment in one statement so concurrent callers
  -- serialise on the row rather than both reading a stale count.
  UPDATE public.user_quotas q
     SET ai_generations_today =
           CASE WHEN q.ai_generations_reset_date IS DISTINCT FROM CURRENT_DATE
                THEN 1 ELSE q.ai_generations_today + 1 END,
         ai_generations_reset_date = CURRENT_DATE,
         updated_at = now()
   WHERE q.user_id = p_user_id
   RETURNING q.max_ai_generations_per_day, q.ai_generations_today
        INTO v_limit, v_count;

  -- No quota row means no plan limits have been provisioned for this user yet;
  -- deny rather than grant unlimited access.
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  -- A NULL limit is the documented "unlimited" sentinel used elsewhere in this table.
  RETURN QUERY SELECT (v_limit IS NULL OR v_count <= v_limit), v_count, v_limit;
END;
$$;

-- Called when the provider definitively rejected the job. Never called for an
-- indeterminate outcome: the generation may still complete and bill upstream.
CREATE OR REPLACE FUNCTION public.release_ai_generation_quota(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.user_quotas
     SET ai_generations_today = GREATEST(0, ai_generations_today - 1),
         updated_at = now()
   WHERE user_id = p_user_id
     AND ai_generations_reset_date = CURRENT_DATE;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_generation_quota(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_generation_quota(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_generation_quota(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_generation_quota(uuid) TO service_role;
