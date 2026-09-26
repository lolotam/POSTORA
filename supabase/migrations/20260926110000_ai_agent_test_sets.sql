-- Saved test sets for the agent Test tab (roadmap #3, Task 1: tables only).
--
-- WHY: an owner saves representative customer messages plus the checks each
-- reply must satisfy (intent, connector, must-contain/must-avoid text,
-- handoff) and re-runs them after persona, model or knowledge changes to
-- catch regressions. Cases hold the messages and expectations; runs hold one
-- row per Run-all with per-case results checkpointed into it as each case
-- finishes, so a run abandoned mid-flight (closed browser) reads back as
-- `interrupted` instead of silently vanishing (debate verdict rows 5, A).
--
-- Tenancy is structural, not just RLS: the service role bypasses RLS, so
-- each table's account link is a composite FK on
-- (social_account_id, user_id, platform) against
-- social_accounts_id_user_id_platform_key -- a row cannot point at another
-- owner's account even from code running as service role (same pattern as
-- 20260828190000_account_configs_prepare.sql). The `expected` shape is
-- enforced server-side by ai_agent_test_expected_valid() for the same
-- reason: client-side zod alone does not bind service-role writes.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Server-side validator for the case expectation object
-- ---------------------------------------------------------------------------
-- IMMUTABLE and reading nothing but its input, so it can back the CHECK
-- below. The CHECK needs no grants to call it, so none are given.

CREATE OR REPLACE FUNCTION public.ai_agent_test_expected_valid(e jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE
    WHEN e IS NULL THEN false
    WHEN jsonb_typeof(e) <> 'object' THEN false
    WHEN EXISTS (
      SELECT 1 FROM jsonb_object_keys(e) AS k
      WHERE k NOT IN ('intent', 'connector', 'contains', 'avoids', 'escalates')
    ) THEN false
    WHEN (e ? 'intent') AND NOT (
      jsonb_typeof(e -> 'intent') = 'string'
      AND (e ->> 'intent') IN ('pricing', 'order_status', 'complaint', 'lead', 'greeting', 'other')
    ) THEN false
    WHEN (e ? 'connector') AND NOT (
      jsonb_typeof(e -> 'connector') = 'string'
      AND char_length(e ->> 'connector') BETWEEN 1 AND 100
    ) THEN false
    -- The nested CASEs evaluate in order, so jsonb_array_elements is only
    -- ever called after the value has proven to be an array; calling it on
    -- a scalar or object would raise rather than return false.
    WHEN (e ? 'contains') AND CASE
      WHEN jsonb_typeof(e -> 'contains') <> 'array' THEN true
      WHEN (SELECT count(*) FROM jsonb_array_elements(e -> 'contains')) > 10 THEN true
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(e -> 'contains') AS v
        WHERE jsonb_typeof(v) <> 'string'
          OR char_length(v #>> '{}') NOT BETWEEN 1 AND 200
      ) THEN true
      ELSE false
    END THEN false
    WHEN (e ? 'avoids') AND CASE
      WHEN jsonb_typeof(e -> 'avoids') <> 'array' THEN true
      WHEN (SELECT count(*) FROM jsonb_array_elements(e -> 'avoids')) > 10 THEN true
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(e -> 'avoids') AS v
        WHERE jsonb_typeof(v) <> 'string'
          OR char_length(v #>> '{}') NOT BETWEEN 1 AND 200
      ) THEN true
      ELSE false
    END THEN false
    WHEN (e ? 'escalates') AND jsonb_typeof(e -> 'escalates') <> 'boolean' THEN false
    ELSE true
  END
$function$;

REVOKE EXECUTE ON FUNCTION public.ai_agent_test_expected_valid(jsonb) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- B. ai_agent_test_cases: one saved customer message plus its checks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_agent_test_cases (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  platform text NOT NULL,
  message text NOT NULL,
  expected jsonb NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_agent_test_cases
  DROP CONSTRAINT IF EXISTS ai_agent_test_cases_user_id_fkey;
ALTER TABLE public.ai_agent_test_cases
  ADD CONSTRAINT ai_agent_test_cases_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

-- Structural tenancy: the account must belong to the row owner on the same
-- platform. Backed by social_accounts_id_user_id_platform_key.
ALTER TABLE public.ai_agent_test_cases
  DROP CONSTRAINT IF EXISTS ai_agent_test_cases_account_same_owner_platform;
ALTER TABLE public.ai_agent_test_cases
  ADD CONSTRAINT ai_agent_test_cases_account_same_owner_platform
  FOREIGN KEY (social_account_id, user_id, platform)
  REFERENCES public.social_accounts (id, user_id, platform)
  ON DELETE CASCADE;

ALTER TABLE public.ai_agent_test_cases
  DROP CONSTRAINT IF EXISTS ai_agent_test_cases_message_length_check;
ALTER TABLE public.ai_agent_test_cases
  ADD CONSTRAINT ai_agent_test_cases_message_length_check
  CHECK (char_length(message) BETWEEN 1 AND 2000);

ALTER TABLE public.ai_agent_test_cases
  DROP CONSTRAINT IF EXISTS ai_agent_test_cases_expected_valid_check;
ALTER TABLE public.ai_agent_test_cases
  ADD CONSTRAINT ai_agent_test_cases_expected_valid_check
  CHECK (public.ai_agent_test_expected_valid(expected));

CREATE INDEX IF NOT EXISTS ai_agent_test_cases_account_position_idx
  ON public.ai_agent_test_cases (user_id, social_account_id, position);

ALTER TABLE public.ai_agent_test_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_test_cases_owner_select ON public.ai_agent_test_cases;
CREATE POLICY ai_agent_test_cases_owner_select
  ON public.ai_agent_test_cases FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_cases_owner_insert ON public.ai_agent_test_cases;
CREATE POLICY ai_agent_test_cases_owner_insert
  ON public.ai_agent_test_cases FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_cases_owner_update ON public.ai_agent_test_cases;
CREATE POLICY ai_agent_test_cases_owner_update
  ON public.ai_agent_test_cases FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_cases_owner_delete ON public.ai_agent_test_cases;
CREATE POLICY ai_agent_test_cases_owner_delete
  ON public.ai_agent_test_cases FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.ai_agent_test_cases FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agent_test_cases TO authenticated;

DROP TRIGGER IF EXISTS ai_agent_test_cases_updated_at ON public.ai_agent_test_cases;
CREATE TRIGGER ai_agent_test_cases_updated_at
  BEFORE UPDATE ON public.ai_agent_test_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- C. ai_agent_test_runs: one row per Run-all, checkpointed as cases finish
-- ---------------------------------------------------------------------------
-- `status` is the durable lifecycle from verdict row 5: the browser appends
-- each case result to `results` as soon as it finishes, flips `running` to
-- `completed` at the end, and a `running` row older than 30 minutes is shown
-- as `interrupted` on load. Comparison uses completed runs only.

CREATE TABLE IF NOT EXISTS public.ai_agent_test_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  platform text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}',
  results jsonb NOT NULL DEFAULT '[]'
);

ALTER TABLE public.ai_agent_test_runs
  DROP CONSTRAINT IF EXISTS ai_agent_test_runs_user_id_fkey;
ALTER TABLE public.ai_agent_test_runs
  ADD CONSTRAINT ai_agent_test_runs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.ai_agent_test_runs
  DROP CONSTRAINT IF EXISTS ai_agent_test_runs_account_same_owner_platform;
ALTER TABLE public.ai_agent_test_runs
  ADD CONSTRAINT ai_agent_test_runs_account_same_owner_platform
  FOREIGN KEY (social_account_id, user_id, platform)
  REFERENCES public.social_accounts (id, user_id, platform)
  ON DELETE CASCADE;

ALTER TABLE public.ai_agent_test_runs
  DROP CONSTRAINT IF EXISTS ai_agent_test_runs_status_check;
ALTER TABLE public.ai_agent_test_runs
  ADD CONSTRAINT ai_agent_test_runs_status_check
  CHECK (status IN ('running', 'completed', 'interrupted'));

CREATE INDEX IF NOT EXISTS ai_agent_test_runs_account_started_idx
  ON public.ai_agent_test_runs (user_id, social_account_id, started_at DESC);

ALTER TABLE public.ai_agent_test_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agent_test_runs_owner_select ON public.ai_agent_test_runs;
CREATE POLICY ai_agent_test_runs_owner_select
  ON public.ai_agent_test_runs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_runs_owner_insert ON public.ai_agent_test_runs;
CREATE POLICY ai_agent_test_runs_owner_insert
  ON public.ai_agent_test_runs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_runs_owner_update ON public.ai_agent_test_runs;
CREATE POLICY ai_agent_test_runs_owner_update
  ON public.ai_agent_test_runs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS ai_agent_test_runs_owner_delete ON public.ai_agent_test_runs;
CREATE POLICY ai_agent_test_runs_owner_delete
  ON public.ai_agent_test_runs FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.ai_agent_test_runs FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agent_test_runs TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
