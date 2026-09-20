-- Every partner key minted since the entitlement gate shipped has been unable to
-- reach an entitlement-gated endpoint, and nothing said so.
--
-- `assertEntitled` (supabase/functions/_shared/partnerEntitlement.ts) resolves a
-- workspace's owner through `partner_provisioned_workspaces` BEFORE it reads a
-- single feature flag:
--
--     if (!provisioning?.owner_user_id)
--       return await refuse("feature_not_entitled", "missing_provisioned_owner");
--
-- `create_partner_key` never wrote that row, and both tables were empty in
-- production, so every gated call returned 403 for every key regardless of scopes
-- or flags. The refusal names a feature, which is why it read as an entitlement
-- problem rather than a missing binding.
--
-- Two parts: mint the binding alongside the key from now on, and backfill the
-- keys already issued.

-- 1. Ensure a workspace has an owner binding. Idempotent, and deliberately
--    non-destructive: an existing binding is never re-pointed at a different
--    owner, because permission-shaped state must only ever widen deliberately
--    (AGENTS.md rule 5).
CREATE OR REPLACE FUNCTION public.partner_ensure_provisioned_workspace(
  p_workspace_id uuid,
  p_social_account_id uuid,
  p_environment text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_user_id uuid;
  v_principal_id uuid;
  v_principal_name text;
BEGIN
  -- An existing binding wins, whatever it says. Nothing below runs.
  IF EXISTS (SELECT 1 FROM public.partner_provisioned_workspaces
             WHERE workspace_id = p_workspace_id) THEN
    RETURN;
  END IF;

  -- The workspace predicate is structural, not advisory. Without it the two
  -- arguments are independent and a caller could bind any workspace to the owner
  -- of any account it can name; ON CONFLICT DO NOTHING would then make that
  -- binding permanent and block the legitimate one from ever repairing it.
  SELECT user_id INTO v_owner_user_id
  FROM public.social_accounts
  WHERE id = p_social_account_id
    AND workspace_id = p_workspace_id;

  -- Refusing here is the point. Returning quietly would mint exactly the key
  -- this migration exists to stop existing: one that authenticates and then
  -- 403s on every gated endpoint with a message blaming a feature flag.
  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'cannot provision workspace %: account % is not an owned account of it',
      p_workspace_id, p_social_account_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- An owner whose accounts span several workspaces must not be provisioned
  -- automatically. Some owner-scoped tables reached by entitlement-gated
  -- endpoints -- the auto-reply rules among them -- are keyed on user_id alone,
  -- so binding a multi-workspace identity would let a key bound to ONE workspace
  -- reach rules governing that same person's accounts in another. Refusing makes
  -- that a deliberate decision with a dedicated owner, instead of a silent
  -- consequence of minting a key.
  IF (SELECT count(DISTINCT workspace_id) FROM public.social_accounts
      WHERE user_id = v_owner_user_id) > 1 THEN
    RAISE EXCEPTION 'cannot provision workspace %: owner % holds accounts in several workspaces and owner-scoped rules would be shared across them',
      p_workspace_id, v_owner_user_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(p.email, 'workspace ' || p_workspace_id::text)
  INTO v_principal_name
  FROM public.profiles p WHERE p.id = v_owner_user_id;
  v_principal_name := COALESCE(v_principal_name, 'workspace ' || p_workspace_id::text);

  INSERT INTO public.partner_principals (id, name, is_active)
  VALUES (gen_random_uuid(), v_principal_name, true)
  RETURNING id INTO v_principal_id;

  INSERT INTO public.partner_provisioned_workspaces
    (workspace_id, principal_id, owner_user_id, environment)
  VALUES (p_workspace_id, v_principal_id, v_owner_user_id,
          COALESCE(p_environment, 'production'))
  ON CONFLICT (workspace_id) DO NOTHING;
END;
$function$;

-- PUBLIC alone is not enough on this stack: default privileges grant EXECUTE
-- directly to anon and authenticated, so a SECURITY DEFINER function revoked
-- only from PUBLIC stays callable through PostgREST by any API client. This
-- helper performs no caller authorization, so that would be a door onto it.
-- It is reached only from create_partner_key, which does its own authorization.
REVOKE ALL ON FUNCTION public.partner_ensure_provisioned_workspace(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- 2. Backfill every workspace holding a LIVE key but no binding. Runs before the
--    key-minting change so the two cannot disagree.
--
--    Revoked-only workspaces are skipped deliberately. Backfilling one would mint
--    a principal asserting a partner relationship that has already been ended, and
--    a revoked key cannot reach an entitlement check to benefit from it. If such a
--    workspace is ever issued a new key, step 3 provisions it at that moment.
DO $backfill$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (k.workspace_id)
           k.workspace_id, k.social_account_id, k.environment
    FROM public.partner_api_keys k
    WHERE k.social_account_id IS NOT NULL
      AND k.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.partner_provisioned_workspaces w
        WHERE w.workspace_id = k.workspace_id
      )
    ORDER BY k.workspace_id, k.created_at
  LOOP
    -- One unownable account must not abort the whole backfill; it is reported
    -- and the remaining workspaces still get their bindings.
    BEGIN
      PERFORM public.partner_ensure_provisioned_workspace(
        r.workspace_id, r.social_account_id, r.environment);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'skipped workspace %: %', r.workspace_id, SQLERRM;
    END;
  END LOOP;
END;
$backfill$;

-- 3. Mint the binding with the key. The signature is reproduced exactly,
--    defaults included: CREATE OR REPLACE with a changed argument list adds an
--    overload rather than replacing, and two candidates would then resolve
--    ambiguously from PostgREST.
CREATE OR REPLACE FUNCTION public.create_partner_key(p_workspace_id uuid, p_social_account_id uuid, p_name text, p_key_prefix text, p_key_hash text, p_scopes text[], p_rate_limit_per_min integer DEFAULT 60, p_monthly_quota integer DEFAULT NULL::integer, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_request_id text DEFAULT NULL::text, p_environment text DEFAULT 'production'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key_id UUID;
BEGIN
  IF NOT public.partner_caller_may_manage_keys(p_workspace_id) THEN
    RAISE EXCEPTION 'not authorized to create partner keys in this workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_key_hash IS NULL OR length(p_key_hash) <> 64 THEN
    -- A 64-char hex SHA-256 digest. Anything else is either a plaintext key
    -- reaching the database or a caller that forgot to hash -- both are
    -- credential-handling failures, not validation nits.
    RAISE EXCEPTION 'key_hash must be a 64-character SHA-256 hex digest'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_environment IS NULL OR p_environment NOT IN ('staging', 'production') THEN
    RAISE EXCEPTION 'environment must be staging or production'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The prefix is what the door checks before any lookup, so a row whose
  -- prefix disagrees with its environment would be a key one door mints and
  -- the other accepts. Refused at the mint, where it is a caller bug.
  IF public.partner_key_environment_for_prefix(p_key_prefix) <> p_environment THEN
    RAISE EXCEPTION 'key prefix % does not belong to environment %', p_key_prefix, p_environment
      USING ERRCODE = 'check_violation';
  END IF;

  -- The owner binding shares the transaction with the key, so a key can never
  -- again exist without the row that makes it usable.
  PERFORM public.partner_ensure_provisioned_workspace(
    p_workspace_id, p_social_account_id, p_environment);

  -- Both inserts and the audit row share this function's single transaction:
  -- a failure at any point leaves no key, no binding and no trail, rather than
  -- the orphaned key F3 describes.
  INSERT INTO public.partner_api_keys (
    workspace_id, social_account_id, created_by, name, key_prefix, key_hash,
    scopes, rate_limit_per_min, monthly_quota, expires_at, environment
  ) VALUES (
    p_workspace_id, p_social_account_id, auth.uid(), p_name, p_key_prefix,
    p_key_hash, COALESCE(p_scopes, '{}'), p_rate_limit_per_min, p_monthly_quota,
    p_expires_at, p_environment
  )
  RETURNING id INTO v_key_id;

  -- created_by is stamped from auth.uid() above and is deliberately NOT a
  -- parameter: an actor a caller can choose is an actor a caller can forge,
  -- and the audit trail's only value is that it cannot be.

  INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
  VALUES (v_key_id, p_social_account_id, p_workspace_id);

  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    p_workspace_id, v_key_id, auth.uid(), 'create', p_request_id,
    jsonb_build_object(
      'key_prefix', p_key_prefix,
      'scopes', to_jsonb(COALESCE(p_scopes, '{}')),
      'social_account_id', p_social_account_id,
      'expires_at', p_expires_at,
      'environment', p_environment
    )
  );

  RETURN v_key_id;
END;
$function$;
