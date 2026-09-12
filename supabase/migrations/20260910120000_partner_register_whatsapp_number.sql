-- Additional WhatsApp numbers for a platform-provisioned workspace.
--
-- The FIRST number is created by provision_partner_tenant
-- (20260910100000_partner_platform_tier.sql), atomically with the workspace,
-- its owner membership and its key. This function is every number AFTER it:
-- the same placeholder row, the same binding row and the same audit row --
-- minus the workspace, the membership and the key, which already exist.
--
-- WHY AN RPC, NOT HANDLER INSERTS. The account row, the
-- partner_api_key_accounts binding and the partner_audit_logs row must commit
-- together: binding.ts anchors every /v1 read on the join table with no
-- fallback, so an account committed without its binding is invisible to the
-- very key that created it -- listing omits it and pairing refuses it as
-- unbound. A handler that inserts the account first and crashes before the
-- binding leaves exactly that orphan. One transaction here is the only order
-- that cannot.
--
-- The function is SECURITY DEFINER, service_role only: it revokes EXECUTE
-- from PUBLIC, anon and authenticated BY NAME. The BY NAME part is
-- load-bearing, not stylistic -- this database carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon/authenticated
-- (supabase/tests/baseline_schema.sql), which are DIRECT role grants that
-- REVOKE ... FROM PUBLIC does not remove. A function left that way is
-- callable by any anonymous PostgREST client -- and this one creates
-- accounts.
CREATE OR REPLACE FUNCTION public.register_partner_whatsapp_number(
  p_key_id UUID,
  p_workspace_id UUID,
  p_connection_name TEXT,
  p_risk_consent_accepted_by TEXT,
  p_risk_consent_accepted_at TIMESTAMPTZ,
  p_risk_consent_accepted_ip TEXT DEFAULT NULL,
  p_consent_version TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner      UUID;
  v_name       TEXT;
  v_max        INTEGER;
  v_count      INTEGER;
  v_account_id UUID := gen_random_uuid();
BEGIN
  -- 1. Estate/ownership, STRUCTURALLY. The calling key must belong to the
  -- workspace, and must not be revoked. Answered as not-found -- matching
  -- issue_partner_key_in_estate -- so key ids are not enumerable across
  -- workspaces, and so a revoked key is indistinguishable from a foreign one.
  -- Never trusted from the caller: the handler authenticates the key, the
  -- database re-proves it belongs here.
  IF NOT EXISTS (
    SELECT 1 FROM public.partner_api_keys k
     WHERE k.id = p_key_id
       AND k.workspace_id = p_workspace_id
       AND k.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'calling key is not an active key of workspace %', p_workspace_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 2. Resolve the owner. social_accounts.user_id is NOT NULL, so without the
  -- service identity recorded at provisioning time the insert cannot happen.
  -- A workspace that was never provisioned through the platform tier has no
  -- such identity -- that is a different caller error from a foreign key, and
  -- it gets its own message so the handler can map it.
  SELECT p.owner_user_id INTO v_owner
    FROM public.partner_provisioned_workspaces p
   WHERE p.workspace_id = p_workspace_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'workspace % was not provisioned through the platform tier', p_workspace_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Name validation. The browser door rejects a user-chosen connection name
  -- rather than silently substituting one (evolutionQrAccount.ts:
  -- normalizeConnectionName trims and requires 1 to 60 characters), because a
  -- substituted name would be attributed to someone's choice and shown as the
  -- account label everywhere. The same rule holds here, in the database,
  -- because a handler check is one refactor from being skipped. The trimmed
  -- value is what is stored, so the row never carries leading/trailing space.
  v_name := btrim(p_connection_name);
  IF v_name IS NULL OR v_name = '' OR char_length(v_name) > 60 THEN
    RAISE EXCEPTION 'connection name must be 1 to 60 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Consent validation. Direct QR is unofficial WhatsApp access with a real
  -- account-ban risk, and createAndGetQr records who accepted it. A partner
  -- call has no end-user click and no directly visible client IP, so the
  -- partner ATTESTS instead -- and an attestation with no identity and no
  -- timestamp is not evidence of anything. Refused here, before any write.
  IF p_risk_consent_accepted_by IS NULL OR btrim(p_risk_consent_accepted_by) = '' THEN
    RAISE EXCEPTION 'risk consent attestation requires accepted_by: who accepted the Direct QR risk'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_risk_consent_accepted_at IS NULL THEN
    RAISE EXCEPTION 'risk consent attestation requires accepted_at: when the Direct QR risk was accepted'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. The account quota. createAndGetQr calls enforceAccountQuota before
  -- creating anything, and lifting registration to the Partner API must not
  -- silently drop that server-side limit. The rule is reproduced exactly:
  -- admins are exempt (user_roles.role = 'admin'), a negative maximum means
  -- unlimited, otherwise the count of the owner's ACTIVE accounts must be
  -- below the maximum. Active only, matching the door: the placeholder below
  -- is inserted inactive, so pending numbers never consume quota -- again
  -- matching the door, which counts is_active = true.
  --
  -- The maximum comes from public.effective_user_quotas, the SQL arbiter for
  -- "what is this user allowed to do" (20260823140100): per-user override,
  -- then plan entitlement, then the free-tier floor, with -1 meaning
  -- unlimited. That is the same source of truth resolveMaxSocialAccounts
  -- (socialAccountQuota.ts) reads -- user_quotas.max_social_accounts, then
  -- the subscription plan's max_social_accounts, then the free floor -- via
  -- the canonical SQL path, which the quota migrations require instead of
  -- reading the plan columns directly. Two refinements of the arbiter differ
  -- deliberately from the TypeScript shortcut: a past_due subscription still
  -- entitles (dunning is not cancellation), and with no subscription the free
  -- plan ROW is read before the free literal. The handler maps the refusal
  -- below to 402, matching the door's "Social account quota reached".
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles r
     WHERE r.user_id = v_owner
       AND r.role = 'admin'::public.app_role
  ) THEN
    SELECT q.max_social_accounts INTO v_max
      FROM public.effective_user_quotas(v_owner) AS q;
    IF v_max >= 0 THEN
      SELECT count(*) INTO v_count
        FROM public.social_accounts a
       WHERE a.user_id = v_owner
         AND a.is_active = TRUE;
      IF v_count >= v_max THEN
        RAISE EXCEPTION 'social account quota exceeded for the workspace owner: % of % connected accounts in use', v_count, v_max
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- 4. The placeholder, matching what createAndGetQr writes: a fresh uuid id,
  -- platform 'whatsapp', a pending_ platform_user_id the activation RPC later
  -- claims to the linked number, the connection name as the username, an
  -- empty access token, evolution_qr mode, inactive until reconciliation
  -- activates it.
  --
  -- THE CONSENT OBJECT RECORDS THE GRADE, NOT JUST THE CLAIM. The metadata
  -- carries what the partner REPORTED (accepted_by/at/ip) alongside what
  -- Postora itself established (which key was authenticated, when the claim
  -- arrived, which text was accepted). evidence is always
  -- 'partner_attestation' on this path: this is a partner's claim, never an
  -- acceptance Postora directly witnessed. The browser door records its own
  -- grade there; collapsing the two would let a reported IP later read as one
  -- Postora saw.
  INSERT INTO public.social_accounts
    (id, user_id, workspace_id, platform, platform_user_id, platform_username,
     access_token, connection_mode, account_metadata, is_active)
  VALUES
    (v_account_id, v_owner, p_workspace_id, 'whatsapp',
     'pending_' || v_account_id::TEXT, v_name,
     '', 'evolution_qr',
     jsonb_build_object('connection_mode', 'evolution_qr',
                        'display_name', v_name,
                        'risk_consent', jsonb_build_object(
                          'accepted_by', p_risk_consent_accepted_by,
                          'accepted_at', p_risk_consent_accepted_at,
                          'accepted_ip', p_risk_consent_accepted_ip,
                          'evidence', 'partner_attestation',
                          'attested_by_key_id', p_key_id,
                          'recorded_at', now(),
                          'consent_version', p_consent_version
                        )),
     false);

  -- 5. The binding for the calling key. Without this row the key that created
  -- the number cannot see it: binding.ts has no fallback, so listing would
  -- omit it and pairing would refuse it as unbound. Committed in the same
  -- transaction as the account, so the orphan it prevents cannot happen.
  INSERT INTO public.partner_api_key_accounts (key_id, workspace_id, social_account_id)
  VALUES (p_key_id, p_workspace_id, v_account_id);

  -- 6. The audit row, matching the Task 1 functions: key_id is the WORKSPACE
  -- key -- the tenancy trigger refuses a row whose key does not belong to the
  -- stated workspace -- with the request id and the acting key in metadata.
  -- The acting key IS the workspace key here (unlike provisioning, where a
  -- platform key acts): it is recorded explicitly in metadata so the row is
  -- readable without joining.
  INSERT INTO public.partner_audit_logs (workspace_id, key_id, actor_id, action, request_id, metadata)
  VALUES (
    p_workspace_id, p_key_id, auth.uid(), 'create', p_request_id,
    jsonb_build_object(
      'social_account_id', v_account_id,
      'connection_name', v_name,
      'acting_key_id', p_key_id,
      'evidence', 'partner_attestation',
      'consent_version', p_consent_version
    )
  );

  -- 7. The new number's id. The caller needs nothing else: pairing takes over
  -- from here.
  RETURN jsonb_build_object('account_id', v_account_id);
END;
$$;

REVOKE ALL ON FUNCTION public.register_partner_whatsapp_number(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_partner_whatsapp_number(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) TO service_role;
