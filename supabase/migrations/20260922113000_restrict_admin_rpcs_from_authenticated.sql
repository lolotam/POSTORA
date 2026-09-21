-- Closes the other half of the door 20260922090000 opened.
--
-- That migration took EXECUTE away from `anon`. It left `authenticated`
-- untouched, and SECURITY DEFINER still bypasses RLS, so every signed-up
-- account kept administrative access. Measured against production with a real
-- non-admin JWT:
--
--     SELECT count(*) FROM get_cron_jobs();              -> 22 rows
--     SELECT cleanup_old_token_refresh_history();        -> 1370 rows deleted
--
-- The second was run inside a rolled-back transaction, but nothing in the
-- function would have stopped it committing.
--
-- TWO SHAPES OF FIX, AND WHY
--
-- Where a function has no authenticated caller — it is invoked only by an edge
-- function under the service key, or by nothing at all — the fix is to revoke
-- EXECUTE from `authenticated`. That needs no body edit, so it cannot alter
-- behaviour by mistranscribing a body. `service_role` is unaffected.
--
-- Only where a function genuinely has an authenticated caller does it get an
-- in-function guard, because there the grant has to stay.
--
-- NOT TOUCHED, AND WHY
--
--   has_role, workspace_role, is_workspace_member
--     Evaluated inside 80, 29 and 12 RLS policies. A policy runs as the
--     querying role, so revoking makes policies error rather than authorise.
--
--   admin_partner_keys, admin_connector_* and the rest of the admin_* family
--     They look unguarded to a search of their own bodies, but each one calls
--     partner_hub_assert_admin(), which raises. Verified: a non-admin calling
--     admin_partner_keys() gets "PL/pgSQL function partner_hub_assert_admin()
--     line 4 at RAISE". A guard in a helper is still a guard.
--
--   log_system_event
--     Called from useOAuthConsent.ts by any signed-in user during the OAuth
--     consent flow, so `authenticated` has to keep it. It writes a log row from
--     caller-supplied text, so an authenticated account can still forge or spam
--     entries. Narrowing it means giving the consent flow another way to log,
--     which is a design change rather than a grant change.

-- ---------------------------------------------------------------------------
-- 1. No authenticated caller: revoke, leave the bodies alone.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target_name text;
  target regprocedure;
  revoked integer := 0;
  -- Reached only through an edge function holding the service key.
  edge_only constant text[] := ARRAY[
    'claim_ai_knowledge_excel_source',
    'cleanup_expired_otps',
    'get_active_ai_model_config',
    'get_cron_jobs',
    'toggle_cron_job'
  ];
  -- No call site anywhere in src/ or supabase/functions/. Several are admin
  -- reporting surfaces whose UI was never built; the rest are cron chores.
  uncalled constant text[] := ARRAY[
    'calculate_health_score',
    'cleanup_old_health_data',
    'get_checklist_progress',
    'get_coupon_stats',
    'get_edge_function_statuses',
    'get_email_stats',
    'get_health_history',
    'get_latest_health_snapshot',
    'get_notification_stats',
    'get_system_logs_filtered',
    'increment_template_use_count',
    'is_coupon_valid',
    'log_email_sent',
    'redeem_coupon',
    'render_email_template',
    'update_email_status'
  ];
BEGIN
  FOREACH target_name IN ARRAY (edge_only || uncalled) LOOP
    FOR target IN
      SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = target_name
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', target);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', target);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', target);
      revoked := revoked + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Revoked authenticated EXECUTE on % function(s).', revoked;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Real authenticated callers: keep the grant, add the guard.
-- ---------------------------------------------------------------------------

-- Called from AdminTokenHealth.tsx. The screen is admin-only, but a screen is
-- not enforcement — this deletes 1370 rows for anyone who asks.
CREATE OR REPLACE FUNCTION public.cleanup_old_token_refresh_history()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'cleanup_old_token_refresh_history is restricted to admins'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.token_refresh_history
  WHERE created_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$function$;

-- Called from useUserRole.tsx by every signed-in user, for their own id. An
-- admin check would break that, so this is owner-or-admin: you may ask about
-- yourself, an admin may ask about anyone. Stays SQL/STABLE so it remains
-- inlinable and cheap — useUserRole runs on most pages.
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id uuid)
RETURNS app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NOT NULL
         AND auth.uid() <> _user_id
         AND NOT public.has_role(auth.uid(), 'admin')
    THEN NULL::app_role
    ELSE COALESCE(
      (SELECT role FROM public.user_roles WHERE user_id = _user_id ORDER BY
        CASE role
          WHEN 'admin' THEN 1
          WHEN 'subscriber' THEN 2
          WHEN 'user' THEN 3
        END
        LIMIT 1),
      'user'::app_role
    )
  END
$function$;
