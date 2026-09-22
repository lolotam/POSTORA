-- Repairs log_system_event onto the real system_logs shape, and binds it to
-- its caller so the repair does not open a forgery hole.
--
-- WHY IT WAS BROKEN: IT NEVER WORKED
--
-- The function inserted into columns that have never existed:
--
--     INSERT INTO public.system_logs (
--       level, service, message, details, error_code, error_message, user_id)
--
-- public.system_logs was created on 2026-01-12 (20260112101005) as
-- (level, category, source, message, user_id, metadata) and has never been
-- reshaped. So this is not drift — the body was written against a schema that
-- did not exist at the time and does not exist now. Confirmed on production:
--
--     SELECT public.log_system_event('info','oauth-consent','probe', ...);
--     ERROR:  column "service" of relation "system_logs" does not exist
--     CONTEXT: PL/pgSQL function log_system_event(...) line 5
--
-- Both call sites swallow errors by design, so nobody noticed. The cost is
-- that the OAuth consent audit trail — who approved or denied which scopes for
-- which client — has recorded nothing since the consent flow shipped. There
-- are 0 rows with source 'oauth-consent' in production.
--
-- WHY THE GUARD SHIPS IN THE SAME MIGRATION
--
-- The function is SECURITY DEFINER and `authenticated` holds EXECUTE. That is
-- deliberate: 20260331074851 dropped the permissive INSERT policy on
-- system_logs, so a signed-in user has no other way to record a consent event.
-- But the old body took user_id, service and message straight from its
-- arguments. Repairing the columns alone would hand every signed-up account a
-- working "write any row into the admin audit log, attributed to anyone"
-- primitive. The repair and the guard are one change, not two.
--
-- The guard is: a caller with a user identity may log only their own
-- oauth-consent events. auth.uid() IS NULL covers both anon (no grant anyway,
-- see 20260922090000) and service_role (no `sub` claim), and neither has any
-- business here — service_role writes system_logs directly, which is what
-- _shared/logging.ts and process-post's own inserts already do.
--
-- THE SIGNATURE IS DELIBERATELY UNCHANGED, SO THREE PARAMETERS ARE VESTIGIAL
--
-- CREATE OR REPLACE with a different argument list ADDS an overload rather than
-- replacing the function, which would leave the broken original reachable; and
-- a browser running a cached bundle will keep sending the old arguments after
-- this is applied. So all seven stay.
--
-- p_user_id is ignored — user_id comes from auth.uid(), which is the whole
-- point. p_error_code and p_error_message have no caller at all now that
-- process-post is off this path, but since they cannot be removed they are
-- folded into metadata rather than silently discarded. Dropping the three is a
-- follow-up for once the frontend has rolled over.
--
-- WHAT THIS DOES NOT FIX
--
-- A signed-in user can still write an unbounded number of rows attributed to
-- themselves, with a message and details of their choosing. Capping that needs
-- a rate limit inside the function and a decision about what to do when the cap
-- is hit; it is a behaviour change beyond this repair. The blast radius is
-- bounded: the rows carry the author's own id and the fixed source
-- 'oauth-consent', so an admin can filter them out.

CREATE OR REPLACE FUNCTION public.log_system_event(
  p_level text,
  p_service text,
  p_message text,
  p_details jsonb DEFAULT NULL::jsonb,
  p_error_code text DEFAULT NULL::text,
  p_error_message text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_log_id uuid;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'log_system_event requires a signed-in caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_service IS DISTINCT FROM 'oauth-consent' THEN
    RAISE EXCEPTION 'log_system_event only records oauth-consent events'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.system_logs (level, category, source, message, user_id, metadata)
  VALUES (
    p_level,
    'auth',
    'oauth-consent',
    p_message,
    -- Not p_user_id: the caller does not get to say who acted.
    v_actor,
    COALESCE(p_details, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'error_code', p_error_code,
           'error_message', p_error_message))
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

-- `authenticated` is the only role with a reason to hold this. service_role
-- had EXECUTE and no longer needs it: process-post's logLocationEvent moves to
-- a direct insert in this same change, and every other service-role writer
-- already inserts into system_logs directly.
REVOKE EXECUTE ON FUNCTION public.log_system_event(text, text, text, jsonb, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_system_event(text, text, text, jsonb, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_system_event(text, text, text, jsonb, text, text, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.log_system_event(text, text, text, jsonb, text, text, uuid) TO authenticated;

DO $$
BEGIN
  -- One function, not two: a changed argument list would have added an
  -- overload and left the broken original reachable.
  ASSERT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'log_system_event') = 1,
    'log_system_event was overloaded rather than replaced';

  ASSERT NOT has_function_privilege('anon',
    'public.log_system_event(text, text, text, jsonb, text, text, uuid)', 'EXECUTE'),
    'anon regained EXECUTE on log_system_event';

  ASSERT has_function_privilege('authenticated',
    'public.log_system_event(text, text, text, jsonb, text, text, uuid)', 'EXECUTE'),
    'authenticated lost EXECUTE on log_system_event; the consent flow cannot log';
END $$;
