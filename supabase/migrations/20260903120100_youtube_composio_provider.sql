-- 20260903120100_youtube_composio_provider.sql — Slice F provider columns.
--
-- Expand-only and idempotent: every statement is safe to re-run. Gives each
-- social_accounts row a publishing provider (spec §10.1) so process-post can
-- branch per row into the Composio YouTube path while native rows are untouched.
-- Also re-creates revoke_connector_connection with the needs_reauth update for
-- linked Composio accounts (spec §6.4, second paragraph).

ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.connector_connections(id) ON DELETE RESTRICT;

-- One block per constraint: two ADD CONSTRAINTs in a single ALTER roll back
-- together, so a duplicate_object on the first would silently skip the second.
DO $$ BEGIN
  ALTER TABLE public.social_accounts
    ADD CONSTRAINT social_accounts_auth_provider_check CHECK (auth_provider IN ('native','composio'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.social_accounts
    ADD CONSTRAINT social_accounts_provider_matches_connection CHECK ((auth_provider = 'composio') = (connection_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A Composio-backed channel holds no Google token of its own: Composio holds
-- it (spec §10.1). The column was NOT NULL for native rows, which still always
-- write one; a sentinel string here would be read as a real token by any path
-- that forgets to branch on auth_provider, so NULL is the only honest value.
-- DROP NOT NULL is a no-op once applied, so this stays idempotent.
ALTER TABLE public.social_accounts ALTER COLUMN access_token DROP NOT NULL;

-- Revocation and the refresh/health paths all look accounts up by connection.
CREATE INDEX IF NOT EXISTS social_accounts_connection_idx ON public.social_accounts (connection_id) WHERE connection_id IS NOT NULL;

-- Same body as 20260903120000, plus the needs_reauth update for Slice F
-- accounts. No dynamic SQL, no information_schema guard.
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
  UPDATE public.social_accounts SET needs_reauth = true WHERE connection_id = p_connection_id;
END $$;

REVOKE ALL ON FUNCTION public.revoke_connector_connection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_connector_connection(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
