CREATE TABLE IF NOT EXISTS public.connector_connections (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connector_type                TEXT NOT NULL,
  toolkit                       TEXT NOT NULL,
  auth_strategy                 TEXT NOT NULL DEFAULT 'composio_oauth'
                                  CHECK (auth_strategy = 'composio_oauth'),
  composio_auth_config_id       TEXT NOT NULL,
  composio_connected_account_id TEXT UNIQUE,
  external_account_id           TEXT,
  external_account_label        TEXT,
  status                        TEXT NOT NULL DEFAULT 'initiated'
                                  CHECK (status IN ('initiated','active','failed','revoked')),
  failure_code                  TEXT,
  state_nonce                   TEXT,
  tool_schema_cache             JSONB,
  tool_schema_cached_at         TIMESTAMPTZ,
  initiated_by                  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at                  TIMESTAMPTZ,
  revoked_at                    TIMESTAMPTZ,
  last_used_at                  TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connector_connections_id_workspace_key UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_one_active_per_external
  ON public.connector_connections (workspace_id, connector_type, external_account_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS connector_connections_workspace_idx ON public.connector_connections (workspace_id, status);

ALTER TABLE public.ai_agent_tools DROP CONSTRAINT IF EXISTS ai_agent_tools_connector_type_check;
ALTER TABLE public.ai_agent_tools ADD CONSTRAINT ai_agent_tools_connector_type_check
  CHECK (connector_type IN (
    'supabase','mysql_postgres','woocommerce','shopify','salla','zid','formula','custom_rest',
    'myfatoorah','stripe','higgsfield','mcp_custom',
    'google_sheets','slack','google_calendar','hubspot','notion','airtable','youtube'));

ALTER TABLE public.ai_agent_tools
  ADD COLUMN IF NOT EXISTS auth_strategy TEXT NOT NULL DEFAULT 'manual_credentials',
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.connector_connections(id) ON DELETE RESTRICT;
-- One block per constraint: two ADD CONSTRAINTs in a single ALTER roll back
-- together, so a duplicate_object on the first would silently skip the second.
DO $$ BEGIN
  ALTER TABLE public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_auth_strategy_check CHECK (auth_strategy IN ('manual_credentials','composio_oauth'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_connection_matches_strategy CHECK ((auth_strategy = 'composio_oauth') = (connection_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The RESTRICT FK, revoke_connector_connection and admin_connector_connections
-- all look tools up by connection.
CREATE INDEX IF NOT EXISTS ai_agent_tools_connection_idx ON public.ai_agent_tools (connection_id) WHERE connection_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_agent_tools_connection_workspace_matches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws UUID; v_acct_ws UUID;
BEGIN
  IF NEW.connection_id IS NULL THEN RETURN NEW; END IF;
  SELECT workspace_id INTO v_ws FROM public.connector_connections WHERE id = NEW.connection_id;
  IF v_ws IS NULL THEN RAISE EXCEPTION 'connection % not found', NEW.connection_id USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = v_ws AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'tool owner is not a member of the connection workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.social_account_id IS NOT NULL THEN
    SELECT workspace_id INTO v_acct_ws FROM public.social_accounts WHERE id = NEW.social_account_id;
    IF v_acct_ws IS DISTINCT FROM v_ws THEN
      RAISE EXCEPTION 'account workspace does not match connection workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_agent_tools_connection_workspace_matches ON public.ai_agent_tools;
CREATE TRIGGER ai_agent_tools_connection_workspace_matches
  BEFORE INSERT OR UPDATE OF connection_id, social_account_id, user_id ON public.ai_agent_tools
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_tools_connection_workspace_matches();

CREATE TABLE IF NOT EXISTS public.connector_call_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  tool_id           UUID REFERENCES public.ai_agent_tools(id) ON DELETE SET NULL,
  connection_id     UUID REFERENCES public.connector_connections(id) ON DELETE SET NULL,
  social_account_id UUID,
  partner_key_id    UUID,
  connector_type    TEXT NOT NULL,
  auth_strategy     TEXT NOT NULL,
  action_name       TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('agent','partner','test','publish')),
  status            TEXT NOT NULL CHECK (status IN ('success','failed','refused','timeout')),
  error_code        TEXT,
  request_id        TEXT,
  latency_ms        INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_call_logs_ws_time_idx   ON public.connector_call_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connector_call_logs_type_time_idx ON public.connector_call_logs (connector_type, created_at DESC);
CREATE INDEX IF NOT EXISTS connector_call_logs_key_time_idx  ON public.connector_call_logs (partner_key_id, created_at DESC)
  WHERE partner_key_id IS NOT NULL;

ALTER TABLE public.connector_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_call_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Workspace members read connections" ON public.connector_connections;
CREATE POLICY "Workspace members read connections" ON public.connector_connections FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = connector_connections.workspace_id AND m.user_id = auth.uid()));
DROP POLICY IF EXISTS "Workspace members read call logs" ON public.connector_call_logs;
CREATE POLICY "Workspace members read call logs" ON public.connector_call_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = connector_call_logs.workspace_id AND m.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.connector_connections, public.connector_call_logs FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.workspace_connector_usage(p_workspace_id UUID, p_days INT DEFAULT 30)
RETURNS TABLE (tool_id UUID, connector_type TEXT, calls BIGINT, failures BIGINT, refused BIGINT, p50_latency_ms INT, last_used_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tool_id, l.connector_type, count(*), count(*) FILTER (WHERE l.status IN ('failed','timeout')),
         count(*) FILTER (WHERE l.status = 'refused'),
         percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::INT, max(l.created_at)
  FROM public.connector_call_logs l
  WHERE l.workspace_id = p_workspace_id
    AND EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid())
    AND l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90))
  GROUP BY l.tool_id, l.connector_type;
$$;

CREATE OR REPLACE FUNCTION public.admin_connector_overview()
RETURNS TABLE (active_connections BIGINT, workspaces_with_connections BIGINT, calls_30d BIGINT, failures_30d BIGINT, refused_30d BIGINT, p95_latency_30d INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY
  SELECT (SELECT count(*) FROM public.connector_connections WHERE status = 'active'),
         (SELECT count(DISTINCT workspace_id) FROM public.connector_connections WHERE status = 'active'),
         count(*), count(*) FILTER (WHERE status IN ('failed','timeout')), count(*) FILTER (WHERE status = 'refused'),
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::INT
  FROM public.connector_call_logs WHERE created_at >= now() - interval '30 days';
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_usage_by_type(p_days INT DEFAULT 30)
RETURNS TABLE (connector_type TEXT, auth_strategy TEXT, calls BIGINT, failures BIGINT, p50_latency_ms INT, p95_latency_ms INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT l.connector_type, l.auth_strategy, count(*), count(*) FILTER (WHERE l.status IN ('failed','timeout')),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms)::INT, percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::INT
  FROM public.connector_call_logs l WHERE l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days,1),90))
  GROUP BY l.connector_type, l.auth_strategy ORDER BY count(*) DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_usage_by_key(p_days INT DEFAULT 30)
RETURNS TABLE (partner_key_id UUID, key_name TEXT, key_prefix TEXT, workspace_id UUID, workspace_name TEXT, calls BIGINT, failures BIGINT, p95_latency_ms INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT l.partner_key_id, k.name, k.key_prefix, l.workspace_id, w.name, count(*),
    count(*) FILTER (WHERE l.status IN ('failed','timeout')), percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms)::INT
  FROM public.connector_call_logs l
  LEFT JOIN public.partner_api_keys k ON k.id = l.partner_key_id
  LEFT JOIN public.workspaces w ON w.id = l.workspace_id
  WHERE l.partner_key_id IS NOT NULL AND l.created_at >= now() - make_interval(days => LEAST(GREATEST(p_days,1),90))
  GROUP BY l.partner_key_id, k.name, k.key_prefix, l.workspace_id, w.name ORDER BY count(*) DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_connector_connections(p_workspace_id UUID DEFAULT NULL)
RETURNS TABLE (id UUID, workspace_id UUID, workspace_name TEXT, connector_type TEXT, toolkit TEXT, external_account_label TEXT, status TEXT, failure_code TEXT, dependent_tools BIGINT, connected_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  RETURN QUERY SELECT c.id, c.workspace_id, w.name, c.connector_type, c.toolkit, c.external_account_label, c.status, c.failure_code,
    (SELECT count(*) FROM public.ai_agent_tools t WHERE t.connection_id = c.id), c.connected_at, c.last_used_at, c.revoked_at
  FROM public.connector_connections c JOIN public.workspaces w ON w.id = c.workspace_id
  WHERE p_workspace_id IS NULL OR c.workspace_id = p_workspace_id
  ORDER BY c.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.admin_partner_key_connector_activity(p_key_id UUID, p_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, connector_type TEXT, action_name TEXT, status TEXT, error_code TEXT, latency_ms INT, request_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.partner_hub_assert_admin();
  IF NOT EXISTS (SELECT 1 FROM public.partner_api_keys WHERE partner_api_keys.id = p_key_id) THEN
    RAISE EXCEPTION 'partner key not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT l.id, l.created_at, l.connector_type, l.action_name, l.status, l.error_code, l.latency_ms, l.request_id
  FROM public.connector_call_logs l WHERE l.partner_key_id = p_key_id
  ORDER BY l.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200);
END $$;

CREATE OR REPLACE FUNCTION public.revoke_connector_connection(p_connection_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ws UUID;
BEGIN
  SELECT workspace_id INTO v_ws FROM public.connector_connections WHERE id = p_connection_id AND status IN ('initiated','active');
  IF v_ws IS NULL THEN RAISE EXCEPTION 'connection not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT (public.has_role(auth.uid(), 'admin') OR EXISTS (
      SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = v_ws AND m.user_id = auth.uid() AND m.role IN ('owner','admin'))) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.connector_connections SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = p_connection_id;
  UPDATE public.ai_agent_tools SET is_enabled = false WHERE connection_id = p_connection_id;
END $$;

DO $$ DECLARE f TEXT; BEGIN
  FOREACH f IN ARRAY ARRAY['workspace_connector_usage(uuid,int)','admin_connector_overview()','admin_connector_usage_by_type(int)',
    'admin_connector_usage_by_key(int)','admin_connector_connections(uuid)','admin_partner_key_connector_activity(uuid,int)','revoke_connector_connection(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP; END $$;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('connector_logs_retention','connector_connections_sweep');
SELECT cron.schedule('connector_logs_retention', '17 3 * * *',
  $$DELETE FROM public.connector_call_logs WHERE created_at < now() - interval '90 days'$$);
SELECT cron.schedule('connector_connections_sweep', '*/15 * * * *',
  $$UPDATE public.connector_connections SET status='failed', failure_code='expired', updated_at=now() WHERE status='initiated' AND created_at < now() - interval '1 hour'$$);
NOTIFY pgrst, 'reload schema';
