# Instagram context-less owner jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A claimed owner job whose account has no capability row is settled `unavailable` / `capability_missing` on its first claim instead of being re-leased every two minutes, and the daily service enqueue skips such accounts and reports how many it skipped.

**Architecture:** One migration replaces two SQL functions (the capability-unavailable settlement gains a context-less owner branch; the daily page enqueue filters owner candidates on an existing capability row and returns `skipped_reconnect_required`). The worker's `readJobContext` routes a context-less job to the existing `settleCapabilityMissing` helper instead of abandoning it. No report or UI change.

**Tech Stack:** Postgres (plpgsql, `SECURITY DEFINER`), Deno edge function `instagram-insights-sync`, `std@0.224.0` asserts, SQL suites under `supabase/tests` run by CI (`scripts/db-harness.sh`).

**Spec:** `docs/superpowers/specs/2026-11-05-instagram-context-missing-loop-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` before editing anything under `supabase/**`.
- The two replaced functions must be byte-identical to their previous definitions (`20261104120000_instagram_capability_unavailable_settlement.sql` for the settlement; `20261031091000_instagram_collection_daily_dispatch.sql` for the daily page) except for the changes named in the spec §4.1. Grants, `SECURITY DEFINER`, `search_path`, the `_http` wrapper and the competitor branch are unchanged.
- SA-15: no local Docker Postgres. SQL suites run in CI only; the implementer writes the SQL and its test, and the orchestrator verifies through CI on the PR.
- Deno gate (Git Bash, absolute paths, frozen lock, never add a dependency): `export DENO_DIR=/f/Dev/Runtimes/deno; W=<worktree>; M=$W/scripts/ci/deno-analytics.import-map.json; L=$W/scripts/ci/deno-analytics.lock; F=$W/supabase/functions/instagram-insights-sync; npx -y deno check --no-config --import-map=$M --lock=$L --frozen --node-modules-dir=none $F/worker.ts $F/workerStore.ts $F/handler.ts $F/index.ts && npx -y deno test --no-config --import-map=$M --lock=$L --frozen --node-modules-dir=none --allow-env $F/worker.test.ts $F/handler.test.ts $F/drainHandler.test.ts $F/store.test.ts`.
- Comments explain why, in the file's existing voice (the SQL files carry long header comments in prose; keep that style). No new log sink.
- Commit scoped to the task's files with `git -C <worktree> commit -m "…" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- <files>`. Do not push.

---

### Task 1: Migration — settle a context-less owner job; daily enqueue skips accounts without a capability row

**Files:**
- Create: `supabase/migrations/20261105200000_instagram_context_missing_settlement.sql`
- Modify: `supabase/tests/instagram_owner_enqueue_reconnect_required.sql` (append DO blocks before the final `ROLLBACK;`)

**Interfaces:**
- Produces: `complete_instagram_collection_job_capability_unavailable(uuid,uuid,bigint)` settles a context-less **owner** job whose `social_account_id` has no `instagram_account_capabilities` row (same UPDATE and JSON as the bound-context success branch, `reason_code = 'capability_missing'`); still raises `IG_COLLECTION_CONTEXT_MISSING` for any other context-less job. `enqueue_instagram_collection_daily_page(text, boolean)` returns the extra key `skipped_reconnect_required` (integer) in its accepted receipt and never enqueues an owner account without a capability row. Task 2's worker relies on the first; nothing relies on the second beyond the receipt.

- [ ] **Step 1: Read the two current definitions**

Read `supabase/migrations/20261104120000_instagram_capability_unavailable_settlement.sql` lines 60–200 and `supabase/migrations/20261031091000_instagram_collection_daily_dispatch.sql` lines 250–560 (the whole `enqueue_instagram_collection_daily_page` function, including every `RETURN jsonb_build_object(` so the new key is added to the accepted receipts consistently). Read the existing suite `supabase/tests/instagram_owner_enqueue_reconnect_required.sql` end to end (its fixture user `f3110000-…0001`, account `f3120000-…0001`, the role/claim `set_config` calls, and how `instagram_direct_collection_credential.sql` lines 940–1070 claims a job and calls the settlement) before writing.

- [ ] **Step 2: Write the failing SQL proof**

Append to `supabase/tests/instagram_owner_enqueue_reconnect_required.sql`, before `ROLLBACK;` (and before any `RESET ROLE;` that precedes it), three DO blocks that reuse the fixture user and add a second account `f3120000-0000-4000-8000-000000000002` (`platform_username 'reconnect_required_second'`) with a capability row inserted the way `instagram_capabilities.sql` line 175 does (`login_kind 'page_linked'`, `permission_read_state 'ok'`, `credential_generation 1`), and widen the fixture policy to `owners: all` for these blocks (upsert `collection_instagram_rollout_policy`):

```sql
DO $daily_page_skips_unenrolled$
DECLARE v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  v_result := public.enqueue_instagram_collection_daily_page('owner', true);
  ASSERT (v_result->>'accepted')::boolean, 'the daily page is accepted: ' || v_result;
  ASSERT (v_result->>'skipped_reconnect_required')::int = 1, 'one account without a capability row is reported skipped: ' || v_result;
  ASSERT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000002' AND target_kind='owner'),
    'the account with a capability row is enqueued';
  ASSERT NOT EXISTS(SELECT 1 FROM public.instagram_collection_jobs WHERE target_id='f3120000-0000-4000-8000-000000000001'),
    'the account without a capability row gets no job';
END $daily_page_skips_unenrolled$;

DO $contextless_owner_job_is_settled$
DECLARE v_job public.instagram_collection_jobs%ROWTYPE; v_claimed record; v_result jsonb;
BEGIN
  -- A job the OLD enqueue would have written: no context, account without a capability row.
  INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on,status,due_at)
  VALUES ('f3110000-0000-4000-8000-000000000001','owner','f3120000-0000-4000-8000-000000000001','f3120000-0000-4000-8000-000000000001',current_date,'queued',now()-interval '1 minute')
  RETURNING * INTO v_job;
  SELECT * INTO v_claimed FROM public.claim_instagram_collection_jobs('owner', 10) AS c WHERE c.job_id = v_job.id;
  ASSERT v_claimed.job_id IS NOT NULL, 'the job is claimed';
  v_result := public.complete_instagram_collection_job_capability_unavailable(v_job.id, v_claimed.claim_token, v_claimed.job_generation);
  ASSERT v_result->>'status' = 'unavailable' AND v_result->>'reason_code' = 'capability_missing', 'settled unavailable/capability_missing: ' || v_result;
  SELECT * INTO v_job FROM public.instagram_collection_jobs WHERE id = v_job.id;
  ASSERT v_job.status = 'unavailable' AND v_job.lease_token IS NULL AND v_job.lease_expires_at IS NULL AND v_job.last_reason_code = 'capability_missing',
    'the row is terminal with the lease cleared';
END $contextless_owner_job_is_settled$;

DO $contextless_job_with_capability_is_still_refused$
DECLARE v_job public.instagram_collection_jobs%ROWTYPE; v_claimed record; v_refused boolean := false;
BEGIN
  INSERT INTO public.instagram_collection_jobs(user_id,target_kind,target_id,social_account_id,captured_on,status,due_at)
  VALUES ('f3110000-0000-4000-8000-000000000001','owner','f3120000-0000-4000-8000-000000000002','f3120000-0000-4000-8000-000000000002',current_date - 1,'queued',now()-interval '1 minute')
  RETURNING * INTO v_job;
  -- Blank the context the claim bound, as a stale claim would look.
  SELECT * INTO v_claimed FROM public.claim_instagram_collection_jobs('owner', 10) AS c WHERE c.job_id = v_job.id;
  UPDATE public.instagram_collection_jobs SET context_viewer_social_account_id=NULL, context_credential_generation=NULL, context_login_kind=NULL WHERE id=v_job.id;
  BEGIN
    PERFORM public.complete_instagram_collection_job_capability_unavailable(v_job.id, v_claimed.claim_token, v_claimed.job_generation);
  EXCEPTION WHEN OTHERS THEN
    v_refused := split_part(SQLERRM, ':', 1) = 'IG_COLLECTION_CONTEXT_MISSING';
  END;
  ASSERT v_refused, 'a context-less job whose account has a capability row is still refused';
END $contextless_job_with_capability_is_still_refused$;
```

Adjust column names and the `claim_instagram_collection_jobs` row shape to what `instagram_durable_collection_jobs.sql` line 465 and `instagram_direct_collection_credential.sql` lines 940–1070 actually use (they are the authority); keep every assertion.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261105200000_instagram_context_missing_settlement.sql`, header comment in the prose style of the neighbours stating the incident (29 jobs re-claimed every 2 minutes for 21 accounts without a capability row on 2026-11-05) and the two changes. Then:

1. `CREATE OR REPLACE FUNCTION public.complete_instagram_collection_job_capability_unavailable(...)` copied from 20261104120000 with the `IF v_job.context_viewer_social_account_id IS NULL OR … THEN RAISE 'IG_COLLECTION_CONTEXT_MISSING' …` block replaced by:

```sql
  IF v_job.context_viewer_social_account_id IS NULL
     OR v_job.context_credential_generation IS NULL
     OR v_job.context_login_kind IS NULL THEN
    -- The claim binds the context from the capability row. An owner whose
    -- account has none could never be bound: that job is settled here, once,
    -- so it stops coming back every lease. Any other context-less job is a
    -- stale claim and is refused as before.
    IF v_job.target_kind = 'owner'
       AND NOT EXISTS (SELECT 1 FROM public.instagram_account_capabilities AS c
                        WHERE c.social_account_id = v_job.social_account_id) THEN
      PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
      UPDATE public.instagram_collection_jobs AS j
         SET status = 'unavailable', retry_at = NULL, lease_token = NULL, lease_expires_at = NULL,
             last_reason_code = v_reason, updated_at = now()
       WHERE j.id = p_job_id;
      RETURN jsonb_build_object('job_id', p_job_id, 'job_generation', v_job.job_generation,
                                'status', 'unavailable', 'outcome', 'unavailable', 'reason_code', v_reason);
    END IF;
    RAISE EXCEPTION 'IG_COLLECTION_CONTEXT_MISSING: the job has no bound connection context' USING ERRCODE = '22023';
  END IF;
```

(`v_reason` is the function's existing constant `'capability_missing'`; if it is declared later than this point, move the declaration up rather than hard-coding the literal twice.)

2. `CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_daily_page(p_target_kind text, p_start boolean DEFAULT false)` copied from 20261031091000 with: (a) in the owner candidate SELECT over `public.social_accounts AS sa`, the predicate `AND EXISTS (SELECT 1 FROM public.instagram_account_capabilities AS c WHERE c.social_account_id = sa.id)` added right after `AND sa.is_active`; (b) a new `v_skipped integer := 0;` computed only in the owner branch as the COUNT of the same page window with `NOT EXISTS` in place of `EXISTS` (same `sa.platform`, `sa.is_active`, allowlist, cursor and anti-join predicates, same `LIMIT v_page_limit`); (c) `'skipped_reconnect_required', v_skipped` added to every accepted `RETURN jsonb_build_object(` of the function (the early "nothing to do" returns use 0). Keep the comment block above the candidates and add two sentences explaining why the capability filter lives in the WHERE (a skipped account is not a refused candidate, so it must not consume a page slot).

3. Re-issue the same `REVOKE`/`GRANT`/`COMMENT` statements the two source migrations end with for these functions.

- [ ] **Step 4: Self-check and commit**

`git diff --check` clean. Compare each new function body with its source definition (`diff <(sed -n 'a,bp' old) <(sed -n 'c,dp' new)`) and confirm only the intended hunks differ; put that diff summary in the report. Commit:

```bash
git -C <worktree> add supabase/migrations/20261105200000_instagram_context_missing_settlement.sql supabase/tests/instagram_owner_enqueue_reconnect_required.sql
git -C <worktree> commit -m "fix(db): settle a context-less Instagram owner job once and skip unenrolled accounts in the daily enqueue" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- supabase/migrations/20261105200000_instagram_context_missing_settlement.sql supabase/tests/instagram_owner_enqueue_reconnect_required.sql
```

---

### Task 2: Worker settles a context-less job instead of abandoning it

**Files:**
- Modify: `supabase/functions/instagram-insights-sync/worker.ts` (`readJobContext`, ~lines 1386–1407)
- Modify: `supabase/functions/instagram-insights-sync/worker.test.ts` (the test "a job without a bound context does not stall the next owner", ~line 851, plus one new test)

**Interfaces:**
- Consumes: Task 1's settlement accepting a context-less owner job (through the store's existing `settleCapabilityUnavailable`).
- Produces: nothing new; `OwnerJobOutcome`/`OwnerReasonCode` unchanged.

- [ ] **Step 1: Write the failing tests**

In `worker.test.ts`, change the existing test's expectations: `summary.abandoned === 0`, `summary.unavailable === 1`, `summary.completed === 1`, `summary.jobs[0]!.outcome === "unavailable"`, `summary.jobs[0]!.reasonCode === "capability_missing"`, and that the harness recorded exactly one `settleCapabilityUnavailable` call for the broken job (see how `workerTestSupport.ts` line ~760 records store calls). Add:

```ts
Deno.test("a context-less job the database refuses to settle is still abandoned to its lease", async () => {
  const broken = createClaimedJob({
    context: { viewer_social_account_id: null, credential_generation: null, login_kind: null, capability_present: false, permission_read_state: null, granted_scopes: [] },
  });
  const harness = createHarness({
    store: { jobs: [broken, createClaimedJob()], settleCapabilityUnavailable: "refuse" },
  });
  const summary = await runOwnerDrain(harness.ports);
  assertEquals(summary.abandoned, 1);
  assertEquals(summary.jobs[0]!.reasonCode, "capability_missing");
  assertEquals(summary.jobs[1]!.outcome, "completed");
  assertEquals(harness.events.some((e) => e.event === "owner_capability_settlement_refused"), true);
});
```

Use the harness's real way of making `settleCapabilityUnavailable` refuse (look at how the existing `capability_missing` tests around `settleCapabilityMissing` do it in `worker.test.ts`/`workerTestSupport.ts`) instead of the placeholder `"refuse"` above.

- [ ] **Step 2: Run the Deno gate; the two tests fail.**

- [ ] **Step 3: Implement**

In `readJobContext`, replace the `if (!verifyBoundContext(job)) { ports.log(... "context_missing" ...); return { kind: "end", step: { job: result(context, "abandoned", "context_missing"), stopRun: false } }; }` block with:

```ts
  if (!verifyBoundContext(job)) {
    // The claim could not bind a context: the account has no capability row.
    // Settled once, so the job stops coming back every lease; a settlement
    // the database refuses abandons it exactly as before, and the RUN
    // continues either way - one unusable job must not stall every other owner.
    return { kind: "end", step: await settleCapabilityMissing(context) };
  }
```

Update the doc comment above `readJobContext` accordingly (why, not what). `settleCapabilityMissing` is declared later in the file; function declarations hoist, so no move is needed.

- [ ] **Step 4: Run the Deno gate; all green. Commit:**

```bash
git -C <worktree> commit -m "fix(instagram-insights-sync): settle a context-less owner job once instead of re-leasing it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -- supabase/functions/instagram-insights-sync/worker.ts supabase/functions/instagram-insights-sync/worker.test.ts
```

---

### Task 3: Gates, review, PR, prod migration, merge (orchestrator)

- [ ] `clean-code-guard` on the worker diff; `test-guard` on both test changes.
- [ ] Deno gate on the branch; push; PR to `main` (body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`); CI runs the SQL suite.
- [ ] Codex `gpt-6-astra` medium review per task and of the branch.
- [ ] Owner card → apply migration `20261105200000` on prod with 0600 `pg_get_functiondef` backups → merge → verify `instagram-insights-sync` sync by hash → owner decides when to widen the rollout back to `owners: all`.
