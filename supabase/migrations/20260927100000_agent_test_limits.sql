-- Server-side caps for the agent Test tab (closes issue #208).
--
-- WHAT: (a) a run holds at most 25 per-case results -- the browser already
-- caps a run at 25 cases, so a larger `results` array can only come from a
-- forged write; (b) an account holds at most 100 saved test cases.
--
-- WHY: quota/billing-adjacent limits must be enforced server-side
-- (ARCHITECTURE.md SS38); client-side caps alone do not bind service-role
-- writes. The per-account cap is a trigger (not a CHECK) because CHECK
-- cannot see other rows; the advisory lock serialises concurrent inserts
-- for the same account so two racing inserts cannot both pass the count.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Cap run results at 25 entries
-- ---------------------------------------------------------------------------
ALTER TABLE public.ai_agent_test_runs
  DROP CONSTRAINT IF EXISTS ai_agent_test_runs_results_cap_check;
ALTER TABLE public.ai_agent_test_runs
  ADD CONSTRAINT ai_agent_test_runs_results_cap_check
  CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 25);

-- ---------------------------------------------------------------------------
-- B. Cap saved test cases at 100 per (user_id, social_account_id)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_agent_test_cases_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- Unrelated updates (neither account link changed) skip the count.
  IF TG_OP = 'UPDATE'
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.social_account_id IS NOT DISTINCT FROM OLD.social_account_id THEN
    RETURN NEW;
  END IF;

  -- Serialise writers for the destination account within this transaction,
  -- so concurrent inserts cannot both observe a count below the cap.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.user_id::text || ':' || NEW.social_account_id::text, 0));

  IF TG_OP = 'UPDATE' THEN
    SELECT count(*) INTO v_count
    FROM public.ai_agent_test_cases
    WHERE user_id = NEW.user_id
      AND social_account_id = NEW.social_account_id
      AND id <> NEW.id;
  ELSE
    SELECT count(*) INTO v_count
    FROM public.ai_agent_test_cases
    WHERE user_id = NEW.user_id
      AND social_account_id = NEW.social_account_id;
  END IF;

  IF v_count >= 100 THEN
    RAISE EXCEPTION 'ai_agent_test_cases_cap'
      USING ERRCODE = 'check_violation',
            DETAIL = 'At most 100 saved test cases per account.';
  END IF;

  RETURN NEW;
END
$function$;

-- Trigger functions need no EXECUTE grant.
REVOKE ALL ON FUNCTION public.ai_agent_test_cases_enforce_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ai_agent_test_cases_cap ON public.ai_agent_test_cases;
CREATE TRIGGER ai_agent_test_cases_cap
  BEFORE INSERT OR UPDATE OF user_id, social_account_id
  ON public.ai_agent_test_cases
  FOR EACH ROW EXECUTE FUNCTION public.ai_agent_test_cases_enforce_cap();

COMMIT;

NOTIFY pgrst, 'reload schema';
