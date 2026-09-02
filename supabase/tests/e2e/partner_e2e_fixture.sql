-- partner_e2e_fixture.sql — E2E harness fixture, NOT a migration.
--
-- This file exists ONLY in throwaway harness databases (partner_api_harness).
-- It is installed by `docker exec ... psql < supabase/tests/e2e/partner_e2e_fixture.sql`
-- ONLY in E2E mode and must never be placed under supabase/migrations/.
-- The harness Postgres is a throwaway (scripts/db-harness.sh creates partner_api_harness);
-- this file has no place in production and would violate the migration immutability
-- contract if committed as a migration.

CREATE OR REPLACE FUNCTION public.partner_e2e_fixture(
  p_key_hash TEXT,
  p_key_prefix TEXT,
  p_scopes TEXT[],
  p_other_key_hash TEXT,
  p_other_key_prefix TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_a UUID := 'e2e00000-0000-4000-8000-000000000001';
  v_user_b UUID := 'e2e00000-0000-4000-8000-000000000002';
  v_ws_a   UUID := 'e2e00000-0000-4000-8000-000000000011';
  v_ws_b   UUID := 'e2e00000-0000-4000-8000-000000000012';
  v_acct_a UUID := 'e2e00000-0000-4000-8000-000000000021';
  v_acct_b UUID := 'e2e00000-0000-4000-8000-000000000022';
  v_key_a  UUID := 'e2e00000-0000-4000-8000-000000000031';
  v_key_b  UUID := 'e2e00000-0000-4000-8000-000000000032';
  v_media_b UUID := 'e2e00000-0000-4000-8000-000000000041';
  v_instance UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- -------------------------------------------------------------------------
  -- Idempotent cleanup: delete children before parents, respecting RESTRICT
  -- on dispatch intents and usage. Deletions are ordered so a re-run never
  -- fails on a leftover child row. All deletes are scoped to the fixed UUIDs
  -- this function owns — nothing outside e2e00000-... is touched.
  -- -------------------------------------------------------------------------
  DELETE FROM public.partner_webhook_deliveries WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_webhooks WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_dispatch_intents WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_api_idempotency WHERE key_id IN (v_key_a, v_key_b);
  DELETE FROM public.partner_api_usage WHERE workspace_id IN (v_ws_a, v_ws_b) OR key_id IN (v_key_a, v_key_b);
  DELETE FROM public.partner_api_rate_buckets WHERE key_id IN (v_key_a, v_key_b);
  DELETE FROM public.partner_api_posts WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_audit_logs WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_api_key_accounts WHERE key_id IN (v_key_a, v_key_b) OR workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.media_files WHERE id = v_media_b OR workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.partner_api_keys WHERE id IN (v_key_a, v_key_b);
  DELETE FROM public.whatsapp_messages WHERE social_account_id IN (v_acct_a, v_acct_b);
  DELETE FROM public.messaging_cache WHERE workspace_id IN (v_ws_a, v_ws_b);
  DELETE FROM public.whatsapp_contacts WHERE workspace_id IN (v_ws_a, v_ws_b);
  -- social_accounts before workspaces (workspace FK)
  DELETE FROM public.social_accounts WHERE id IN (v_acct_a, v_acct_b);
  DELETE FROM public.workspaces WHERE id IN (v_ws_a, v_ws_b);
  -- workspace_members if any (not created by this fixture, but clean for idempotency)
  DELETE FROM public.workspace_members WHERE workspace_id IN (v_ws_a, v_ws_b) OR user_id IN (v_user_a, v_user_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  -- -------------------------------------------------------------------------
  -- Users — mirror existing suites' auth.users inserts, with explicit required
  -- columns so the fixture is not dependent on defaults that may change.
  -- -------------------------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
  VALUES
    (v_user_a, v_instance, 'authenticated', 'authenticated', 'e2e-a@example.invalid', '$2a$10$e2eplaceholderhashhashhashhashhashhashhash12', now(), '{}'::jsonb, '{}'::jsonb, now(), now(), false, false),
    (v_user_b, v_instance, 'authenticated', 'authenticated', 'e2e-b@example.invalid', '$2a$10$e2eplaceholderhashhashhashhashhashhashhash12', now(), '{}'::jsonb, '{}'::jsonb, now(), now(), false, false);

  -- -------------------------------------------------------------------------
  -- Workspaces — one per user, not personal (the tenancy matrix tests use
  -- non-personal workspaces, and partner tables all scope by workspace_id).
  -- -------------------------------------------------------------------------
  INSERT INTO public.workspaces (id, owner_id, name, is_personal)
  VALUES
    (v_ws_a, v_user_a, 'e2e-ws-a', false),
    (v_ws_b, v_user_b, 'e2e-ws-b', false);

  -- Provide workspace_members for completeness (not required for service_role,
  -- but mirrors a real workspace and prevents future RLS surprises if tests
  -- ever use authenticated role).
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES
    (v_ws_a, v_user_a, 'owner'),
    (v_ws_b, v_user_b, 'owner')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- WhatsApp social_accounts — one per workspace, cloud_api, active, with
  -- fake phone_number_id (platform_user_id), fake token, and waba_id in
  -- account_metadata. Mirrors baseline schema's NOT NULL / CHECK requirements:
  --   platform CHECK includes whatsapp, workspace_id NOT NULL for whatsapp,
  --   connection_mode CHECK for whatsapp must be cloud_api|coexistence|evolution_qr
  -- -------------------------------------------------------------------------
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id, connection_mode, is_active, needs_reauth, account_metadata)
  VALUES
    (v_acct_a, v_user_a, 'whatsapp', '111111111111111', 'e2e-fake-token', v_ws_a, 'cloud_api', true, false, jsonb_build_object('waba_id', '999999999999999')),
    (v_acct_b, v_user_b, 'whatsapp', '222222222222222', 'e2e-fake-token', v_ws_b, 'cloud_api', true, false, jsonb_build_object('waba_id', '888888888888888'));

  -- -------------------------------------------------------------------------
  -- Partner keys — workspace A with caller-provided hash/prefix/scopes,
  -- workspace B as "other tenant" with all scopes. Both environment production,
  -- monthly_quota 5, bound to their account via partner_api_key_accounts.
  -- -------------------------------------------------------------------------
  INSERT INTO public.partner_api_keys (id, workspace_id, social_account_id, created_by, name, key_prefix, key_hash, scopes, environment, monthly_quota, rate_limit_per_min, current_usage_count, usage_reserved, usage_confirmed, usage_indeterminate)
  VALUES
    (v_key_a, v_ws_a, v_acct_a, v_user_a, 'e2e-key-a', p_key_prefix, p_key_hash, p_scopes, 'production', 5, 60, 0, 0, 0, 0),
    (v_key_b, v_ws_b, v_acct_b, v_user_b, 'e2e-key-b', p_other_key_prefix, p_other_key_hash, ARRAY['messages:send','messages:read','accounts:read','conversations:read','media:read','media:write','webhooks:read','webhooks:manage','posts:read','posts:write','posts:schedule','templates:read','usage:read'], 'production', 5, 60, 0, 0, 0, 0);

  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  VALUES
    (v_key_a, v_acct_a, v_ws_a),
    (v_key_b, v_acct_b, v_ws_b);

  -- -------------------------------------------------------------------------
  -- media_files row in workspace B so cross-tenant test has something real.
  -- workspace_id set, file_type image, mime image/jpeg, scan_state available,
  -- storage_bucket partner-media (private, service-role only), file_size small.
  -- -------------------------------------------------------------------------
  INSERT INTO public.media_files (id, user_id, workspace_id, created_by_key_id, file_path, file_type, file_size, mime_type, storage_bucket, scan_state, metadata)
  VALUES
    (v_media_b, v_user_b, v_ws_b, v_key_b, v_ws_b::text || '/e2e-media-' || v_media_b::text || '.jpg', 'image', 1234, 'image/jpeg', 'partner-media', 'available', jsonb_build_object('source','partner_api','original_filename','e2e.jpg'));

  RETURN jsonb_build_object(
    'workspace_a', v_ws_a,
    'workspace_b', v_ws_b,
    'account_a', v_acct_a,
    'account_b', v_acct_b,
    'key_a', v_key_a,
    'key_b', v_key_b,
    'media_b', v_media_b,
    'user_a', v_user_a,
    'user_b', v_user_b
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_e2e_fixture(TEXT, TEXT, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_e2e_fixture(TEXT, TEXT, TEXT[], TEXT, TEXT) TO service_role;

-- Harness-only: the production grant surface leaves service_role without SELECT on
-- partner_api_usage (it only INSERTs). The chain test verifies billable ledger
-- rows via SELECT, which would otherwise 42501. This GRANT exists only in the
-- throwaway harness; it is not a migration and must never be applied to prod.
GRANT SELECT ON public.partner_api_usage TO service_role;
GRANT SELECT ON public.partner_api_rate_buckets TO service_role;
