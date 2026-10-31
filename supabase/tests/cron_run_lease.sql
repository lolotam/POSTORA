-- supabase/tests/cron_run_lease.sql
-- One process-scheduled-posts run at a time (migration 20261031100000).
-- One transaction, synthetic holders, labelled ASSERTs, ROLLBACK, sentinel last.
-- Assumes the migration is already applied. No secrets and no real accounts.
BEGIN;

-- L1-L5: the first holder takes the lease, a second is refused, the first extends it.
DO $$
DECLARE
  h_a uuid := 'c7c7c7c7-1111-4111-8111-c7c7c7c7c7c7';
  h_b uuid := 'c7c7c7c7-2222-4222-8222-c7c7c7c7c7c7';
BEGIN
  ASSERT public.acquire_cron_run_lease('lease-test', h_a, interval '3 minutes'),
    'L1 the first holder takes a free lease';
  ASSERT (SELECT holder = h_a AND expires_at = now() + interval '3 minutes'
            FROM public.cron_run_leases WHERE job = 'lease-test'),
    'L2 the row records the holder and the expiry';
  ASSERT NOT public.acquire_cron_run_lease('lease-test', h_b, interval '3 minutes'),
    'L3 a second holder is refused while the lease is live';
  ASSERT (SELECT holder = h_a FROM public.cron_run_leases WHERE job = 'lease-test'),
    'L4 the refused call leaves the holder unchanged';
  -- Two statements: in one ASSERT the subquery would run first, as an init plan.
  ASSERT public.acquire_cron_run_lease('lease-test', h_a, interval '5 minutes'),
    'L5 the holder extends its own lease';
  ASSERT (SELECT expires_at = now() + interval '5 minutes' FROM public.cron_run_leases WHERE job = 'lease-test'),
    'L5b the extension moves the expiry';
  ASSERT public.acquire_cron_run_lease('other-job', h_b, interval '3 minutes'),
    'L6 leases are per job';
END $$;

-- E1-E2: an expired lease is taken over by the next holder.
DO $$
DECLARE
  h_a uuid := 'c7c7c7c7-1111-4111-8111-c7c7c7c7c7c7';
  h_c uuid := 'c7c7c7c7-3333-4333-8333-c7c7c7c7c7c7';
BEGIN
  UPDATE public.cron_run_leases
     SET acquired_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
   WHERE job = 'lease-test';
  ASSERT public.acquire_cron_run_lease('lease-test', h_c, interval '3 minutes'),
    'E1 a new holder takes an expired lease';
  ASSERT (SELECT holder = h_c AND acquired_at = now() FROM public.cron_run_leases WHERE job = 'lease-test'),
    'E2 the takeover records the new holder and resets acquired_at';
  ASSERT NOT public.release_cron_run_lease('lease-test', h_a),
    'E3 the expired holder cannot release the new holder''s lease';
END $$;

-- R1-R2: only the holder releases, and a released lease is free again.
DO $$
DECLARE
  h_b uuid := 'c7c7c7c7-2222-4222-8222-c7c7c7c7c7c7';
  h_c uuid := 'c7c7c7c7-3333-4333-8333-c7c7c7c7c7c7';
BEGIN
  ASSERT public.release_cron_run_lease('lease-test', h_c), 'R1 the holder releases its lease';
  ASSERT NOT EXISTS (SELECT 1 FROM public.cron_run_leases WHERE job = 'lease-test'), 'R2 the row is gone';
  ASSERT public.acquire_cron_run_lease('lease-test', h_b, interval '3 minutes'),
    'R3 a released lease is free for the next holder';
END $$;

-- V1-V4: malformed calls are refused.
DO $$
DECLARE
  h_a uuid := 'c7c7c7c7-1111-4111-8111-c7c7c7c7c7c7';
  v_refused boolean;
BEGIN
  v_refused := false;
  BEGIN PERFORM public.acquire_cron_run_lease('', h_a, interval '1 minute');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true; END;
  ASSERT v_refused, 'V1 an empty job is refused';
  v_refused := false;
  BEGIN PERFORM public.acquire_cron_run_lease('lease-v', NULL, interval '1 minute');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true; END;
  ASSERT v_refused, 'V2 a null holder is refused';
  v_refused := false;
  BEGIN PERFORM public.acquire_cron_run_lease('lease-v', h_a, interval '0');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true; END;
  ASSERT v_refused, 'V3 a zero ttl is refused';
  v_refused := false;
  BEGIN PERFORM public.acquire_cron_run_lease('lease-v', h_a, interval '2 hours');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true; END;
  ASSERT v_refused, 'V4 a ttl over one hour is refused';
END $$;

-- G1-G6: only the service role may call the functions or read the table.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.acquire_cron_run_lease(text, uuid, interval)', 'EXECUTE'),
    'G1 authenticated cannot acquire a lease';
  ASSERT NOT has_function_privilege('anon', 'public.acquire_cron_run_lease(text, uuid, interval)', 'EXECUTE'),
    'G2 anon cannot acquire a lease';
  ASSERT has_function_privilege('service_role', 'public.acquire_cron_run_lease(text, uuid, interval)', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.release_cron_run_lease(text, uuid)', 'EXECUTE'),
    'G3 the service role can acquire and release';
  ASSERT NOT has_function_privilege('authenticated', 'public.release_cron_run_lease(text, uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.release_cron_run_lease(text, uuid)', 'EXECUTE'),
    'G4 browser roles cannot release a lease';
  ASSERT NOT has_table_privilege('authenticated', 'public.cron_run_leases', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.cron_run_leases', 'SELECT'),
    'G5 browser roles cannot read the lease table';
  ASSERT (SELECT bool_and(prosecdef AND 'search_path=public' = ANY (proconfig))
            FROM pg_proc WHERE oid IN ('public.acquire_cron_run_lease(text, uuid, interval)'::regprocedure,
                                       'public.release_cron_run_lease(text, uuid)'::regprocedure)),
    'G6 both functions are SECURITY DEFINER with search_path pinned';
END $$;

ROLLBACK;

\echo '=== cron_run_lease: ALL CHECKS PASSED ==='
