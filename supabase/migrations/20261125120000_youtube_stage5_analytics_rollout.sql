-- YouTube Stage 5 analytics: private rollout, non-reusable connection identity,
-- append-only purpose acceptance, one-snapshot decisions, and bound refresh I/O.
-- Apply as supabase_admin. No rollout key or acceptance row is seeded.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS app_settings_youtube_stage5_rollout_private ON public.app_settings;

CREATE POLICY app_settings_youtube_stage5_rollout_private
  ON public.app_settings
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (
    key NOT IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')
    OR public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    key NOT IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')
    OR public.has_role(auth.uid(), 'admin')
  );

ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS binding_incarnation uuid;

COMMENT ON COLUMN public.social_accounts.binding_incarnation IS
  'Random identity of one YouTube account-row incarnation. Existing rows stay NULL and read as the all-zero UUID; a delete and re-insert can never reuse the identity.';

CREATE OR REPLACE FUNCTION public.youtube_stage5_assign_binding_incarnation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.platform = 'youtube' THEN
      NEW.binding_incarnation := gen_random_uuid();
    ELSE
      NEW.binding_incarnation := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.platform = 'youtube' AND OLD.platform <> 'youtube' THEN
    NEW.binding_incarnation := gen_random_uuid();
  ELSIF NEW.platform = 'youtube' THEN
    NEW.binding_incarnation := OLD.binding_incarnation;
  ELSE
    NEW.binding_incarnation := NULL;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_social_accounts_youtube_binding_incarnation
  ON public.social_accounts;

CREATE TRIGGER trg_social_accounts_youtube_binding_incarnation
  BEFORE INSERT OR UPDATE ON public.social_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.youtube_stage5_assign_binding_incarnation();

CREATE TABLE IF NOT EXISTS public.youtube_analytics_purpose_consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id         text NOT NULL CHECK (btrim(channel_id) <> ''),
  social_account_id  uuid,
  event              text NOT NULL CHECK (event IN ('accepted', 'withdrawn')),
  purpose_version    integer NOT NULL CHECK (purpose_version > 0),
  locale             text NOT NULL CHECK (locale IN ('en', 'ar')),
  method             text NOT NULL DEFAULT 'in_app_panel' CHECK (method = 'in_app_panel'),
  request_id         text NOT NULL CHECK (btrim(request_id) <> ''),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.youtube_analytics_purpose_consents IS
  'Append-only owner/channel purpose events. social_account_id is a historical reference without a foreign key, so account deletion never mutates this record. Rows cascade only with their owner.';

CREATE INDEX IF NOT EXISTS youtube_analytics_purpose_consents_owner_channel_created_idx
  ON public.youtube_analytics_purpose_consents (owner_id, channel_id, created_at DESC);

ALTER TABLE public.youtube_analytics_purpose_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youtube_analytics_purpose_consents
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.youtube_analytics_stage5_parse_policy(
  p_policy     jsonb,
  p_account_id uuid
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_entry jsonb;
  v_uuid  uuid;
BEGIN
  IF p_policy IS NULL THEN
    RETURN 'missing';
  END IF;

  IF jsonb_typeof(p_policy) <> 'object' THEN
    RETURN 'invalid';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_policy) AS k(key)
     WHERE k.key NOT IN ('version', 'mode', 'account_ids')
  ) THEN
    RETURN 'invalid';
  END IF;

  IF jsonb_typeof(p_policy -> 'version') IS DISTINCT FROM 'number'
     OR (CASE
          WHEN jsonb_typeof(p_policy -> 'version') = 'number'
          THEN (p_policy ->> 'version')::numeric = 1
          ELSE false
        END) IS NOT TRUE THEN
    RETURN 'invalid';
  END IF;

  IF jsonb_typeof(p_policy -> 'mode') IS DISTINCT FROM 'string'
     OR p_policy ->> 'mode' NOT IN ('off', 'allowlist', 'all') THEN
    RETURN 'invalid';
  END IF;

  IF jsonb_typeof(p_policy -> 'account_ids') IS DISTINCT FROM 'array'
     OR (CASE
          WHEN jsonb_typeof(p_policy -> 'account_ids') = 'array'
          THEN jsonb_array_length(p_policy -> 'account_ids') > 200
          ELSE true
        END) THEN
    RETURN 'invalid';
  END IF;

  FOR v_entry IN
    SELECT value FROM jsonb_array_elements(p_policy -> 'account_ids')
  LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'string' THEN
      RETURN 'invalid';
    END IF;
    BEGIN
      v_uuid := v_entry #>> '{}';
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN 'invalid';
    END;
  END LOOP;

  IF p_policy ->> 'mode' = 'off' THEN
    RETURN 'off';
  END IF;

  IF p_policy ->> 'mode' = 'all' THEN
    RETURN 'ok';
  END IF;

  IF p_account_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(p_policy -> 'account_ids') AS e(value)
     WHERE e.value::uuid = p_account_id
  ) THEN
    RETURN 'ok';
  END IF;

  RETURN 'not_listed';
END
$function$;

CREATE OR REPLACE FUNCTION public.youtube_analytics_stage5_record_consent(
  p_owner_id            uuid,
  p_account_id          uuid,
  p_event               text,
  p_purpose_version     integer,
  p_locale              text,
  p_request_id          text,
  p_expected_revision   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner_id            uuid;
  v_platform            text;
  v_channel_id          text;
  v_is_active           boolean;
  v_auth_provider       text;
  v_binding_generation  bigint;
  v_binding_incarnation uuid;
  v_latest              public.youtube_analytics_purpose_consents%ROWTYPE;
  v_policy              jsonb;
  v_revision            text;
BEGIN
  IF p_owner_id IS NULL OR p_account_id IS NULL
     OR p_event IS NULL OR p_event NOT IN ('accepted', 'withdrawn')
     OR p_purpose_version IS NULL OR p_purpose_version <= 0
     OR p_locale IS NULL OR p_locale NOT IN ('en', 'ar')
     OR p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT u.id INTO v_owner_id
    FROM auth.users AS u
   WHERE u.id = p_owner_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT sa.platform,
         sa.platform_user_id,
         sa.is_active,
         sa.auth_provider,
         sa.binding_generation,
         sa.binding_incarnation
    INTO v_platform,
         v_channel_id,
         v_is_active,
         v_auth_provider,
         v_binding_generation,
         v_binding_incarnation
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
     AND sa.user_id = p_owner_id
   FOR UPDATE;

  IF NOT FOUND OR v_platform <> 'youtube'
     OR v_channel_id IS NULL
     OR btrim(v_channel_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'yt_stage5_consent:' || p_owner_id::text || ':' || v_channel_id, 0));

  v_revision := substr(encode(sha256(convert_to(
    p_account_id::text || ':'
    || COALESCE(v_binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid)::text
    || ':' || v_binding_generation::text, 'utf8')), 'hex'), 1, 32);

  IF p_expected_revision IS NOT NULL
     AND v_revision IS DISTINCT FROM p_expected_revision THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'connection_changed');
  END IF;

  IF p_event = 'accepted' THEN
    IF NOT COALESCE(v_is_active, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;

    IF COALESCE(v_auth_provider, 'native') <> 'native' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'provider_unsupported');
    END IF;

    SELECT s.value INTO v_policy
      FROM public.app_settings AS s
     WHERE s.key = 'youtube_analytics_stage5_rollout';

    IF public.youtube_analytics_stage5_parse_policy(v_policy, p_account_id) <> 'ok' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_enabled');
    END IF;
  END IF;

  SELECT c.* INTO v_latest
    FROM public.youtube_analytics_purpose_consents AS c
   WHERE c.owner_id = p_owner_id
     AND c.channel_id = v_channel_id
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 1;

  IF v_latest.event = p_event
     AND v_latest.purpose_version = p_purpose_version THEN
    RETURN jsonb_build_object(
      'ok', true,
      'recorded', false,
      'channel_id', v_channel_id,
      'connection_revision', v_revision,
      'consent', jsonb_build_object('state', p_event, 'version', p_purpose_version)
    );
  END IF;

  INSERT INTO public.youtube_analytics_purpose_consents (
    owner_id, channel_id, social_account_id, event, purpose_version,
    locale, request_id, created_at
  ) VALUES (
    p_owner_id, v_channel_id, p_account_id, p_event, p_purpose_version,
    p_locale, p_request_id,
    GREATEST(
      clock_timestamp(),
      COALESCE(v_latest.created_at + interval '1 microsecond', '-infinity'::timestamptz)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'recorded', true,
    'channel_id', v_channel_id,
    'connection_revision', v_revision,
    'consent', jsonb_build_object('state', p_event, 'version', p_purpose_version)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.youtube_analytics_stage5_decide(
  p_owner_id             uuid,
  p_account_id           uuid,
  p_expected_channel     text DEFAULT NULL,
  p_expected_generation  bigint DEFAULT NULL,
  p_expected_incarnation uuid DEFAULT NULL,
  p_required_scopes      text[] DEFAULT ARRAY[]::text[],
  p_purpose_version      integer DEFAULT 1,
  p_with_credentials     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
WITH account_row AS MATERIALIZED (
  SELECT
    sa.id,
    sa.platform,
    sa.platform_user_id,
    COALESCE(sa.auth_provider, 'native') AS provider,
    sa.is_active,
    sa.binding_generation,
    COALESCE(sa.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid) AS effective_incarnation,
    sa.access_token,
    sa.refresh_token,
    sa.token_expires_at,
    COALESCE(sa.needs_reauth, false) AS needs_reauth,
    CASE
      WHEN jsonb_typeof(sa.account_metadata -> 'granted_scopes') = 'array'
      THEN COALESCE(
        (SELECT array_agg(e.value)
           FROM jsonb_array_elements_text(sa.account_metadata -> 'granted_scopes') AS e(value)),
        ARRAY[]::text[])
      ELSE ARRAY[]::text[]
    END AS granted_scopes,
    substr(encode(sha256(convert_to(
      p_account_id::text || ':'
      || COALESCE(sa.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid)::text
      || ':' || sa.binding_generation::text, 'utf8')), 'hex'), 1, 32) AS connection_revision
  FROM public.social_accounts AS sa
  WHERE sa.id = p_account_id
    AND sa.user_id = p_owner_id
),
rollout_setting AS MATERIALIZED (
  SELECT s.value
  FROM public.app_settings AS s
  WHERE s.key = 'youtube_analytics_stage5_rollout'
),
latest_consent AS MATERIALIZED (
  SELECT c.event, c.purpose_version
  FROM public.youtube_analytics_purpose_consents AS c
  WHERE c.owner_id = p_owner_id
    AND c.channel_id = (SELECT a.platform_user_id FROM account_row AS a)
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1
),
snapshot AS (
  SELECT
    a.*,
    public.youtube_analytics_stage5_parse_policy(s.value, p_account_id) AS policy_state,
    CASE
      WHEN c.event IS NULL THEN 'none'
      WHEN c.event = 'withdrawn' THEN 'withdrawn'
      WHEN c.event = 'accepted' AND c.purpose_version = p_purpose_version THEN 'accepted'
      ELSE 'outdated'
    END AS consent_state,
    (p_expected_channel IS NOT NULL
      AND p_expected_generation IS NOT NULL
      AND p_expected_incarnation IS NOT NULL) AS bound_mode,
    (p_owner_id IS NOT NULL
      AND p_account_id IS NOT NULL
      AND p_required_scopes IS NOT NULL
      AND p_purpose_version IS NOT NULL
      AND p_purpose_version > 0
      AND p_with_credentials IS NOT NULL
      AND ((p_expected_channel IS NULL AND p_expected_generation IS NULL AND p_expected_incarnation IS NULL)
        OR (p_expected_channel IS NOT NULL AND p_expected_generation IS NOT NULL AND p_expected_incarnation IS NOT NULL))
    ) AS valid_request
  FROM (SELECT 1) AS seed
  LEFT JOIN account_row AS a ON true
  LEFT JOIN rollout_setting AS s ON true
  LEFT JOIN latest_consent AS c ON true
),
decision AS (
  SELECT s.*,
    CASE
      WHEN NOT s.valid_request THEN 'invalid_request'
      WHEN NOT s.bound_mode AND (
        s.id IS NULL OR s.platform <> 'youtube'
        OR NOT COALESCE(s.is_active, false)
        OR s.platform_user_id IS NULL OR btrim(s.platform_user_id) = ''
      ) THEN 'not_found'
      WHEN s.bound_mode AND (
        s.id IS NULL OR s.platform <> 'youtube'
        OR NOT COALESCE(s.is_active, false)
        OR s.platform_user_id IS NULL OR btrim(s.platform_user_id) = ''
        OR s.platform_user_id IS DISTINCT FROM p_expected_channel
        OR s.binding_generation IS DISTINCT FROM p_expected_generation
        OR s.effective_incarnation IS DISTINCT FROM p_expected_incarnation
      ) THEN 'connection_changed'
      WHEN s.provider <> 'native' THEN 'provider_unsupported'
      WHEN s.policy_state <> 'ok' THEN 'not_enabled'
      WHEN s.consent_state <> 'accepted' THEN 'consent_required'
      WHEN s.needs_reauth OR (
        COALESCE(btrim(s.access_token), '') = ''
        AND COALESCE(btrim(s.refresh_token), '') = ''
      ) THEN 'reconnect_required'
      WHEN cardinality(s.granted_scopes) > 0
        AND NOT (s.granted_scopes @> p_required_scopes) THEN 'missing_scope'
      ELSE 'ok'
    END AS reason
  FROM snapshot AS s
)
SELECT jsonb_build_object(
  'ok', d.reason = 'ok',
  'reason', d.reason,
  'channel_id', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.platform_user_id END,
  'binding_generation', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.binding_generation END,
  'binding_incarnation', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.effective_incarnation END,
  'connection_revision', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.connection_revision END,
  'provider', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.provider END,
  'needs_reauth', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE d.needs_reauth END,
  'granted_scopes', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN NULL ELSE to_jsonb(d.granted_scopes) END,
  'consent', jsonb_build_object(
    'state', CASE WHEN d.reason IN ('invalid_request', 'not_found') THEN 'none' ELSE d.consent_state END,
    'version', CASE WHEN d.reason = 'invalid_request' THEN NULL ELSE p_purpose_version END
  )
) || CASE
  WHEN d.reason = 'ok' AND p_with_credentials THEN jsonb_build_object(
    'credentials', jsonb_build_object(
      'access_token', d.access_token,
      'refresh_token', d.refresh_token,
      'token_expires_at', d.token_expires_at
    )
  )
  ELSE '{}'::jsonb
END
FROM decision AS d
$function$;

CREATE OR REPLACE FUNCTION public.youtube_analytics_stage5_acquire_lease(
  p_owner_id             uuid,
  p_account_id           uuid,
  p_expected_channel     text,
  p_expected_generation  bigint,
  p_expected_incarnation uuid,
  p_required_scopes      text[],
  p_purpose_version      integer,
  p_ttl_seconds          integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account_id uuid;
  v_decision   jsonb;
BEGIN
  IF p_owner_id IS NULL OR p_account_id IS NULL
     OR p_expected_channel IS NULL OR p_expected_generation IS NULL
     OR p_expected_incarnation IS NULL OR p_required_scopes IS NULL
     OR p_purpose_version IS NULL OR p_purpose_version <= 0
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 5 AND 600 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT sa.id INTO v_account_id
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
     AND sa.user_id = p_owner_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'connection_changed');
  END IF;

  v_decision := public.youtube_analytics_stage5_decide(
    p_owner_id, p_account_id, p_expected_channel, p_expected_generation,
    p_expected_incarnation, p_required_scopes, p_purpose_version, false);

  IF NOT (v_decision ->> 'ok')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_decision ->> 'reason');
  END IF;

  RETURN public.acquire_youtube_refresh_lease(p_account_id, p_ttl_seconds);
END
$function$;

CREATE OR REPLACE FUNCTION public.youtube_analytics_stage5_store_token(
  p_owner_id             uuid,
  p_account_id           uuid,
  p_expected_channel     text,
  p_expected_generation  bigint,
  p_expected_incarnation uuid,
  p_lease_token          uuid,
  p_new_access_token     text,
  p_new_token_expires_at timestamptz,
  p_new_refresh_token    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account public.social_accounts%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_account_id IS NULL
     OR p_expected_channel IS NULL OR p_expected_generation IS NULL
     OR p_expected_incarnation IS NULL OR p_lease_token IS NULL
     OR p_new_access_token IS NULL OR btrim(p_new_access_token) = ''
     OR p_new_token_expires_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT sa.* INTO v_account
    FROM public.social_accounts AS sa
   WHERE sa.id = p_account_id
     AND sa.user_id = p_owner_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_account.platform <> 'youtube'
     OR COALESCE(v_account.auth_provider, 'native') <> 'native'
     OR NOT COALESCE(v_account.is_active, false)
     OR v_account.platform_user_id IS DISTINCT FROM p_expected_channel
     OR v_account.binding_generation IS DISTINCT FROM p_expected_generation
     OR COALESCE(v_account.binding_incarnation, '00000000-0000-0000-0000-000000000000'::uuid)
        IS DISTINCT FROM p_expected_incarnation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'connection_changed');
  END IF;

  RETURN public.store_youtube_refreshed_token_with_lease_neutral(
    p_account_id, p_lease_token, p_new_access_token,
    p_new_token_expires_at, p_new_refresh_token);
END
$function$;

REVOKE ALL ON FUNCTION public.youtube_stage5_assign_binding_incarnation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_stage5_assign_binding_incarnation()
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_parse_policy(jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_record_consent(uuid, uuid, text, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_record_consent(uuid, uuid, text, integer, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_decide(uuid, uuid, text, bigint, uuid, text[], integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_decide(uuid, uuid, text, bigint, uuid, text[], integer, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_acquire_lease(uuid, uuid, text, bigint, uuid, text[], integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_acquire_lease(uuid, uuid, text, bigint, uuid, text[], integer, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_store_token(uuid, uuid, text, bigint, uuid, uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_store_token(uuid, uuid, text, bigint, uuid, uuid, text, timestamptz, text)
  TO service_role;

DO $assert_boundary$
DECLARE
  v_fn      text;
  v_writers text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.social_accounts'::regclass
       AND attname = 'binding_incarnation'
       AND atttypid = 'uuid'::regtype
       AND NOT attisdropped AND NOT attnotnull AND atthasdef = false
  ) THEN
    RAISE EXCEPTION 'binding_incarnation must be nullable uuid without a default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger AS t
      JOIN pg_proc AS p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.social_accounts'::regclass
       AND t.tgname = 'trg_social_accounts_youtube_binding_incarnation'
       AND NOT t.tgisinternal
       AND NOT p.prosecdef
       AND 'search_path=public, pg_temp' = ANY (p.proconfig)
  ) THEN
    RAISE EXCEPTION 'the incarnation trigger must be SECURITY INVOKER with a pinned search_path';
  END IF;

  IF NOT (SELECT bool_and(COALESCE(
            p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig), false))
            FROM pg_proc AS p
           WHERE p.oid IN (
             'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)'::regprocedure,
             'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)'::regprocedure,
             'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure,
             'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)'::regprocedure,
             'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)'::regprocedure)) THEN
    RAISE EXCEPTION 'the five Stage 5 RPC/helper functions must be SECURITY DEFINER with a pinned search_path';
  END IF;

  IF NOT (SELECT p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
                AND p.provolatile = 'v'
            FROM pg_proc AS p
           WHERE p.oid = 'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'decide must be a single-statement VOLATILE SQL function';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)',
    'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)',
    'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)',
    'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)',
    'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)',
    'public.youtube_stage5_assign_binding_incarnation()'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc AS p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS x
          WHERE p.oid = v_fn::regprocedure AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'PUBLIC and browser roles must not execute %', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)',
    'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)',
    'public.youtube_analytics_stage5_acquire_lease(uuid,uuid,text,bigint,uuid,text[],integer,integer)',
    'public.youtube_analytics_stage5_store_token(uuid,uuid,text,bigint,uuid,uuid,text,timestamptz,text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role must execute %', v_fn;
    END IF;
  END LOOP;

  IF has_function_privilege('service_role',
       'public.youtube_analytics_stage5_parse_policy(jsonb,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the parser must not be directly executable by service_role';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class AS c
           WHERE c.oid = 'public.youtube_analytics_purpose_consents'::regclass) THEN
    RAISE EXCEPTION 'the acceptance table must have RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'youtube_analytics_purpose_consents'
  ) THEN
    RAISE EXCEPTION 'the acceptance table must carry no policies';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS x
     WHERE c.oid = 'public.youtube_analytics_purpose_consents'::regclass
       AND x.grantee = 0
  ) OR has_table_privilege('anon', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_table_privilege('authenticated', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_table_privilege('service_role', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'PUBLIC, browser roles, and service_role must hold no privilege on the acceptance table';
  END IF;

  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_writers
    FROM pg_proc AS p
    JOIN pg_roles AS r ON r.oid = p.proowner
   WHERE r.rolname = 'youtube_stage4_refresh';

  IF v_writers IS DISTINCT FROM
     ARRAY['store_youtube_refreshed_token', 'store_youtube_refreshed_token_with_lease',
           'store_youtube_refreshed_token_with_lease_neutral'] THEN
    RAISE EXCEPTION 'youtube_stage4_refresh must still own exactly the three trusted refresh functions';
  END IF;

  IF has_column_privilege('youtube_stage4_refresh', 'public.social_accounts', 'binding_incarnation', 'UPDATE') THEN
    RAISE EXCEPTION 'the narrow refresh role must not update binding_incarnation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_settings
     WHERE key IN ('youtube_analytics_stage5_rollout', 'youtube_analytics_stage5_scope_gate')
  ) THEN
    RAISE EXCEPTION 'the Stage 5 settings keys must not be seeded';
  END IF;

  IF EXISTS (SELECT 1 FROM public.youtube_analytics_purpose_consents) THEN
    RAISE EXCEPTION 'the acceptance table must be empty when this migration is applied';
  END IF;
END
$assert_boundary$;

COMMIT;
