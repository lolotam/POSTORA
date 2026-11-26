-- YouTube analytics purpose events are scoped to one connection revision (D13 = B).
-- Apply as supabase_admin after 20261125120000_youtube_stage5_analytics_rollout.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.youtube_analytics_purpose_consents
  ADD COLUMN IF NOT EXISTS connection_revision text
    CHECK (connection_revision IS NULL OR connection_revision ~ '^[0-9a-f]{32}$');

COMMENT ON COLUMN public.youtube_analytics_purpose_consents.connection_revision IS
  '32-hex connection revision (account_id + binding_incarnation + binding_generation) under which the event was recorded. NULL marks a pre-D13-B event that no active connection revision matches.';

CREATE INDEX IF NOT EXISTS youtube_analytics_purpose_consents_owner_channel_revision_idx
  ON public.youtube_analytics_purpose_consents
    (owner_id, channel_id, connection_revision, created_at DESC, id DESC);

COMMENT ON TABLE public.youtube_analytics_purpose_consents IS
  'Append-only purpose events scoped per owner, channel, and connection revision. social_account_id is a historical reference without a foreign key, so account deletion never mutates this record. Rows cascade only with their owner.';

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
     AND c.connection_revision = v_revision
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
    owner_id, channel_id, social_account_id, connection_revision, event, purpose_version,
    locale, request_id, created_at
  ) VALUES (
    p_owner_id, v_channel_id, p_account_id, v_revision, p_event, p_purpose_version,
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
    AND c.connection_revision = (SELECT a.connection_revision FROM account_row AS a)
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

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_record_consent(uuid, uuid, text, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_record_consent(uuid, uuid, text, integer, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.youtube_analytics_stage5_decide(uuid, uuid, text, bigint, uuid, text[], integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youtube_analytics_stage5_decide(uuid, uuid, text, bigint, uuid, text[], integer, boolean)
  TO service_role;

DO $assert_connection_scoped_consent$
DECLARE
  v_fn text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.youtube_analytics_purpose_consents'::regclass
       AND attname = 'connection_revision'
       AND atttypid = 'text'::regtype
       AND NOT attisdropped AND NOT attnotnull AND NOT atthasdef
  ) THEN
    RAISE EXCEPTION 'connection_revision must be nullable text without a default';
  END IF;

  IF to_regclass('public.youtube_analytics_purpose_consents_owner_channel_revision_idx') IS NULL THEN
    RAISE EXCEPTION 'the owner/channel/connection revision index must exist';
  END IF;

  IF NOT (SELECT bool_and(
            p.prosecdef
            AND p.provolatile = 'v'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig))
           FROM pg_proc AS p
          WHERE p.oid IN (
            'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)'::regprocedure,
            'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure)) THEN
    RAISE EXCEPTION 'both consent functions must be VOLATILE SECURITY DEFINER with a pinned search_path';
  END IF;

  IF NOT (SELECT p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
           FROM pg_proc AS p
          WHERE p.oid = 'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'decide must remain a single-statement SQL function';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.youtube_analytics_stage5_record_consent(uuid,uuid,text,integer,text,text,text)',
    'public.youtube_analytics_stage5_decide(uuid,uuid,text,bigint,uuid,text[],integer,boolean)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_proc AS p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS x
          WHERE p.oid = v_fn::regprocedure AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'PUBLIC and browser roles must not execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role must execute %', v_fn;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class AS c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS x
     WHERE c.oid = 'public.youtube_analytics_purpose_consents'::regclass
       AND x.grantee = 0
  ) OR has_table_privilege('anon', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_table_privilege('authenticated', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_table_privilege('service_role', 'public.youtube_analytics_purpose_consents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'PUBLIC, browser roles, and service_role must hold no privilege on the acceptance table';
  END IF;
END
$assert_connection_scoped_consent$;

COMMIT;
