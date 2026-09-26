-- supabase/tests/agent_test_limits.sql
BEGIN;
DO $$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_acct uuid := gen_random_uuid();
  v_acct2 uuid := gen_random_uuid();
  v_results25 jsonb := (SELECT jsonb_agg(g) FROM generate_series(1, 25) g);
  v_results26 jsonb := (SELECT jsonb_agg(g) FROM generate_series(1, 26) g);
  v_i integer;
  v_moved uuid;
BEGIN
  -- Fixtures. platform 'facebook' avoids the whatsapp-needs-workspace check;
  -- expected '{}' satisfies ai_agent_test_expected_valid.
  INSERT INTO auth.users (id, email)
  VALUES (v_owner, 'limits-owner-' || v_owner::text || '@example.invalid');
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, access_token)
  VALUES
    (v_acct, v_owner, 'facebook', 'limits-acct-' || v_acct::text, 'token-a'),
    (v_acct2, v_owner, 'facebook', 'limits-acct2-' || v_acct2::text, 'token-b');

  -- L1/L2/L3: the guardrails exist.
  ASSERT EXISTS (SELECT 1 FROM pg_constraint
           WHERE conname = 'ai_agent_test_runs_results_cap_check'
             AND conrelid = 'public.ai_agent_test_runs'::regclass),
    'L1 results cap check exists';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger
           WHERE tgname = 'ai_agent_test_cases_cap'
             AND tgrelid = 'public.ai_agent_test_cases'::regclass
             AND NOT tgisinternal),
    'L2 account cap trigger exists';
  ASSERT (SELECT count(*) FROM pg_proc
           WHERE proname = 'ai_agent_test_cases_enforce_cap') = 1,
    'L3 no overload added to the cap function';

  -- L4: a run with exactly 25 results inserts.
  INSERT INTO public.ai_agent_test_runs (user_id, social_account_id, platform, results)
  VALUES (v_owner, v_acct, 'facebook', v_results25);
  ASSERT (SELECT count(*) FROM public.ai_agent_test_runs
           WHERE user_id = v_owner AND social_account_id = v_acct) = 1,
    'L4 25 results accepted';

  -- L5: 26 results are rejected.
  BEGIN
    INSERT INTO public.ai_agent_test_runs (user_id, social_account_id, platform, results)
    VALUES (v_owner, v_acct, 'facebook', v_results26);
    RAISE EXCEPTION 'L5 failed: 26 results accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- L6: a non-array results value is rejected.
  BEGIN
    INSERT INTO public.ai_agent_test_runs (user_id, social_account_id, platform, results)
    VALUES (v_owner, v_acct, 'facebook', '{"oops":true}'::jsonb);
    RAISE EXCEPTION 'L6 failed: non-array results accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- L7: the 100th saved case for an account succeeds.
  FOR v_i IN 1..99 LOOP
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected)
    VALUES (v_owner, v_acct, 'facebook', 'case ' || v_i::text, '{}');
  END LOOP;
  INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected)
  VALUES (v_owner, v_acct, 'facebook', 'case 100', '{}');
  ASSERT (SELECT count(*) FROM public.ai_agent_test_cases
           WHERE user_id = v_owner AND social_account_id = v_acct) = 100,
    'L7 100th case accepted';

  -- L8: the 101st case for the same account raises check_violation.
  BEGIN
    INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected)
    VALUES (v_owner, v_acct, 'facebook', 'case 101', '{}');
    RAISE EXCEPTION 'L8 failed: 101st case accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- L9: a different account of the same user still accepts inserts.
  INSERT INTO public.ai_agent_test_cases (user_id, social_account_id, platform, message, expected)
  VALUES (v_owner, v_acct2, 'facebook', 'other account case', '{}');
  ASSERT (SELECT count(*) FROM public.ai_agent_test_cases
           WHERE user_id = v_owner AND social_account_id = v_acct2) = 1,
    'L9 sibling account unaffected';

  -- L10: an unrelated UPDATE on a row of a full account succeeds (no count).
  UPDATE public.ai_agent_test_cases
  SET message = 'edited in place'
  WHERE user_id = v_owner AND social_account_id = v_acct AND message = 'case 1';
  ASSERT (SELECT count(*) FROM public.ai_agent_test_cases
           WHERE user_id = v_owner AND social_account_id = v_acct
             AND message = 'edited in place') = 1,
    'L10 message-only update on full account succeeds';

  -- L11: moving a row into a full account is rejected.
  SELECT id INTO v_moved FROM public.ai_agent_test_cases
  WHERE user_id = v_owner AND social_account_id = v_acct2 LIMIT 1;
  BEGIN
    UPDATE public.ai_agent_test_cases
    SET social_account_id = v_acct
    WHERE id = v_moved;
    RAISE EXCEPTION 'L11 failed: move into full account accepted' USING ERRCODE = 'assert_failure';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
