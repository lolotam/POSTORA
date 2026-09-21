-- Stops `anon` executing SECURITY DEFINER functions that have no caller guard.
--
-- PostgREST exposes every function in `public` as /rest/v1/rpc/<name>, and the
-- anon key is embedded in the frontend bundle by design, so anything `anon` may
-- execute is reachable by any visitor. SECURITY DEFINER additionally means the
-- body runs with RLS bypassed. Twenty-seven such functions had no auth.uid(),
-- no has_role and no RAISE anywhere in their bodies.
--
-- Reachability was confirmed against production before writing this, using a
-- deliberate type error so nothing was executed: with only the anon key,
--
--     POST /rest/v1/rpc/add_user_credits {"p_user_id":"NOTAUUID", ...}
--       -> 400 invalid input syntax for type uuid
--
-- A 400 cast error means PostgREST resolved the function and began binding
-- arguments as `anon`; a missing grant answers 404. `add_user_credits` is a bare
-- INSERT ... ON CONFLICT DO UPDATE SET balance = balance + p_amount, so an
-- unauthenticated caller could set any user's credit balance. `toggle_cron_job`
-- similarly takes a job id and a boolean.
--
-- THREE FUNCTIONS ARE DELIBERATELY NOT LISTED HERE.
--
-- has_role (80 policies), workspace_role (29) and is_workspace_member (12) are
-- evaluated *inside* RLS policy expressions. A policy runs as the querying role,
-- so revoking EXECUTE from anon or authenticated makes those policies error
-- instead of authorise, and breaks access control across the database rather
-- than tightening it. They are read-only predicates over arguments the caller
-- already supplies, so the exposure is a role lookup, not a write.
--
-- WHAT THIS DOES NOT FIX
--
-- Several of these take a user id as a parameter rather than deriving it from
-- auth.uid() — `use_credits(p_user_id, p_amount)` and `add_user_credits` among
-- them. Once a caller is authenticated, nothing stops them naming another user.
-- Closing that needs a guard inside each function body and a decision per
-- function about who may act on whom; it is a behaviour change, not a grant
-- change, and is deliberately left to a follow-up.
--
-- `authenticated` and `service_role` keep EXECUTE throughout: the admin screens
-- call these as a signed-in admin, and the edge functions call them with the
-- service key.

DO $$
DECLARE
  target_name text;
  target regprocedure;
  revoked integer := 0;
  -- Mutating: unauthenticated writes to credits, quotas, coupons, cron and logs.
  mutating constant text[] := ARRAY[
    'add_user_credits',
    'use_credits',
    'redeem_coupon',
    'set_user_quotas_for_plan',
    'toggle_cron_job',
    'increment_template_use_count',
    'claim_ai_knowledge_excel_source',
    'cleanup_expired_otps',
    'cleanup_old_health_data',
    'cleanup_old_token_refresh_history',
    'log_email_sent',
    'update_email_status',
    'log_system_event'
  ];
  -- Read-only, but operational data no anonymous visitor should see: system
  -- logs, cron state, edge-function health, email and coupon statistics.
  reads constant text[] := ARRAY[
    'get_cron_jobs',
    'get_system_logs_filtered',
    'get_edge_function_statuses',
    'get_email_stats',
    'get_notification_stats',
    'get_coupon_stats',
    'get_health_history',
    'get_latest_health_snapshot',
    'calculate_health_score',
    'get_checklist_progress',
    'render_email_template',
    'is_coupon_valid',
    'get_active_ai_model_config',
    'get_user_role'
  ];
BEGIN
  FOREACH target_name IN ARRAY (mutating || reads) LOOP
    -- By oid rather than by name: revoking a name would miss overloads, and
    -- naming an argument list would break the moment a signature changes.
    FOR target IN
      SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = target_name
    LOOP
      -- PUBLIC as well: a PUBLIC grant alone keeps anon able to execute, so
      -- revoking only the role leaves the hole open.
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', target);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', target);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', target);
      revoked := revoked + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Revoked anon/PUBLIC EXECUTE on % function(s).', revoked;

  -- The RLS predicates must still be callable by the roles that evaluate
  -- policies. If this ever fails, something above over-reached.
  ASSERT has_function_privilege('anon', 'public.has_role(uuid, app_role)', 'EXECUTE'),
    'has_role lost anon EXECUTE; RLS policies would fail closed';
  ASSERT has_function_privilege('authenticated', 'public.has_role(uuid, app_role)', 'EXECUTE'),
    'has_role lost authenticated EXECUTE; RLS policies would fail closed';
END $$;
