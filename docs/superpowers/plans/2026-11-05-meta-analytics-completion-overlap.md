# Meta Analytics Completion Overlap Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Facebook/Threads daily collection job reaches `success` when its required cells are `available` for the account regardless of which job captured them, and a refused completion releases the job instead of wedging the drain.

**Architecture:** One migration redefines the two `complete_*_analytics_collection_job` functions (metric-coverage block no longer tied to the job's own captures). One worker change turns a `MAH05` from `complete_*` into a `failed/completion_refused` job completion instead of a drain-stopping `configuration_unavailable`.

**Tech Stack:** Postgres (plpgsql, Supabase self-hosted), Deno edge worker `meta-owned-analytics-sync`, SQL suites under `supabase/tests` run by `scripts/db-harness.sh` in CI, Deno tests with the CI import map.

**Spec:** `docs/superpowers/specs/2026-11-05-meta-analytics-completion-overlap-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` before touching `supabase/**`.
- The migration keeps both functions byte-identical to `supabase/migrations/20261101144500_meta_owned_analytics_capture_failures.sql` except the second `p_outcome='success'` block; `SECURITY DEFINER`, `SET search_path=public,pg_temp`, `SET lock_timeout='3s'` and the `MAH01`/`MAH04`/`MAH05` codes stay.
- The first `MAH05` block (checkpoint complete, no pending/failed operation, an `account_day` success) is untouched.
- `MAH05` from `claim_*` RPCs must still stop the worker with `configuration_unavailable`.
- Deno std imports use `std@0.224.0` (the frozen CI lock).
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `fix/meta-analytics-completion-overlap`, `main` only.
- Gates: SQL suites run in CI only (no local Docker, SA-15); Deno suites locally with the CI import map: `npx -y deno test --no-config --import-map=scripts/ci/deno-analytics.import-map.json --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none --allow-env <files>` with `DENO_DIR=/f/Dev/Runtimes/deno`.

---

## File map

| File | Responsibility |
|---|---|
| Create `supabase/migrations/20261105160000_meta_owned_analytics_completion_overlap.sql` | Redefine both completion functions with the subject-level coverage rule. |
| Modify `supabase/tests/meta_owned_analytics_capture_failures.sql` | Prove: overlapping-job success accepted; genuinely unavailable still refused. |
| Modify `supabase/functions/meta-owned-analytics-sync/deadline.ts` | `CompletionRefused` error type. |
| Modify `supabase/functions/meta-owned-analytics-sync/store.ts` | `complete()` raises `CompletionRefused` on `MAH05`. |
| Modify `supabase/functions/meta-owned-analytics-sync/worker.ts` | `collectJob` completes `failed/completion_refused` and returns `"refused"`. |
| Modify `supabase/functions/meta-owned-analytics-sync/termination.test.ts` | Worker behaviour on a refused completion; `claim_*` `MAH05` unchanged. |

---

### Task 1: Migration + SQL proof

**Files:**
- Create: `supabase/migrations/20261105160000_meta_owned_analytics_completion_overlap.sql`
- Modify: `supabase/tests/meta_owned_analytics_capture_failures.sql` (append two DO blocks before the final `ROLLBACK;`)

**Interfaces:**
- Produces: the same two function signatures as today (`complete_fb_analytics_collection_job(p_job_id uuid, p_claim_token uuid, p_job_generation bigint, p_outcome text, p_reason text DEFAULT NULL, p_retry_at timestamptz DEFAULT NULL)` and the Threads twin), with the relaxed coverage rule.

- [ ] **Step 1: Write the migration**

Copy the two `CREATE OR REPLACE FUNCTION public.complete_fb_analytics_collection_job …` / `…complete_threads_analytics_collection_job …` definitions from `supabase/migrations/20261101144500_meta_owned_analytics_capture_failures.sql` (lines 3–42 and 43–82) verbatim into the new file, under this header:

```sql
-- A completed collection is judged by the account's stored cells, not by
-- which job captured them.
--
-- OLD: the metric-coverage rule of a 'success' completion required every
-- required day and post cell to carry a capture_id of THIS job and
-- generation. Daily jobs overlap (job D owns days D-1 and D-2, job D+1
-- owns D and D-1, both inventory the same posts) and persist_*_analytics_
-- capture lets the later writer take the cell's capture_id, so an earlier
-- job could never reach 'success' once two jobs interleaved. On 2026-11-05
-- job b22ce0ec (Page 8d1872d2, due 2026-11-04) was refused with MAH05 on
-- every drain for three hours and, because the worker treated MAH05 as a
-- configuration failure, the whole Facebook drain stopped with it.
--
-- NEW: the coverage rule asks only that an 'available' cell exists for the
-- same user, account, day/post and metric. The first MAH05 block (this
-- job's checkpoint and operations) is unchanged. Everything else in both
-- functions is byte-for-byte the definition from
-- 20261101144500_meta_owned_analytics_capture_failures.sql.
```

Then edit ONLY the second `IF p_outcome='success' AND ( … )` block of each function:

Facebook — the day sub-query becomes:
```sql
    EXISTS(SELECT 1 FROM unnest(ARRAY[v_job.due_on-1,v_job.due_on-2]) day_value CROSS JOIN unnest(ARRAY['views','unique_viewers','engagements','followers']) key_value
      WHERE NOT EXISTS(SELECT 1 FROM public.fb_page_insight_daily d JOIN public.fb_analytics_metric_values m ON m.daily_id=d.id
        WHERE d.user_id=v_job.user_id AND d.social_account_id=v_job.social_account_id
          AND d.metric_date=day_value AND m.metric_key=key_value AND m.status='available'))
```
and the post sub-query becomes:
```sql
    OR EXISTS(SELECT 1 FROM public.fb_analytics_collection_checkpoints checkpoint CROSS JOIN unnest(checkpoint.post_ids) post_id CROSS JOIN unnest(ARRAY['views','unique_viewers']) key_value
      WHERE checkpoint.job_id=p_job_id AND checkpoint.job_generation=p_job_generation
        AND NOT EXISTS(SELECT 1 FROM public.fb_post_insight_snapshots p JOIN public.fb_analytics_metric_values m ON m.post_snapshot_id=p.id
          WHERE p.user_id=v_job.user_id AND p.social_account_id=v_job.social_account_id
            AND p.platform_post_id=post_id AND m.metric_key=key_value AND m.status='available'))
```

Threads — the same two edits on `threads_account_insight_daily` / `threads_analytics_metric_values` (`profile_views`) and `threads_post_insight_snapshots` (`views,likes,replies,reposts,quotes,shares`), and the followers sub-query becomes:
```sql
    OR NOT EXISTS(SELECT 1 FROM public.threads_analytics_metric_values m WHERE m.user_id=v_job.user_id AND m.social_account_id=v_job.social_account_id AND m.profile_observation_id IS NOT NULL AND m.metric_key='followers' AND m.status='available')
```
(`threads_analytics_metric_values` has `user_id` and `social_account_id` columns; the Facebook twin has the same shape.)

Nothing else in either function changes: diff the new file against the 20261101144500 definitions and confirm the only hunks are the header and these sub-queries.

- [ ] **Step 2: Write the failing SQL proof**

Append to `supabase/tests/meta_owned_analytics_capture_failures.sql` before `ROLLBACK;`. The suite already seeds owner `b1000000-…0001`, Facebook account `b4000000-…0001` (provider `784001`, credential `b5000000-…0001`) and Threads account `b3000000-…0001` (provider `780001`), prepares both accounts and sets the service role. Follow the capture pattern of `supabase/tests/meta_owned_analytics_history.sql` (`reserve_%s_analytics_capture` → `persist_%s_analytics_capture`, with `jsonb_build_object('kind','account_day','subject_id',<provider>,'metric_date',<date>,'metrics',jsonb_build_array(...))` and `'kind','post','subject_id',<post id>` for posts, and the worker-state RPC that records the checkpoint — read how `meta_owned_analytics_history.sql` marks `inventory_complete` and lists `post_ids`, and reuse exactly that call).

```sql
-- Overlapping jobs: job A (due D) persisted every required cell but was not
-- completed; job B (due D+1) re-persisted the same day and posts, so the
-- cells' capture_id now belongs to B. A's 'success' must be accepted.
DO $overlap$
DECLARE v_owner uuid:='b1000000-0000-4000-8000-000000000001';v_account uuid:='b4000000-0000-4000-8000-000000000001';
  v_date date:=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date;v_a jsonb;v_b jsonb;v_capture jsonb;v_payload jsonb;v_day date;v_key text;v_post text;
BEGIN
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_date-1,false);
  v_a:=public.claim_fb_analytics_collection_jobs(1)->0;
  -- (1) record A's inventory as complete with one post (reserve the first page, commit it with no next cursor)
  v_capture:=public.reserve_fb_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_fb_analytics_inventory_page((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY['784001_1'],NULL,false);
  -- (2) A persists every required cell as available: days D-2, D-3 x views/unique_viewers/engagements/followers; post 784001_1 x views/unique_viewers
  FOREACH v_day IN ARRAY ARRAY[v_date-2,v_date-3] LOOP
    FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
      v_capture:=public.reserve_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'day:'||v_day||':'||v_key,
        jsonb_build_object('kind','account_day','subject_id','784001','metric_date',v_day,'metrics',jsonb_build_array(v_key)));
      v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',1)),'received_at',clock_timestamp(),'observed_at',(v_capture->>'until')::timestamptz);
      PERFORM public.persist_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
    END LOOP;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'post:784001_1:'||v_key,
      jsonb_build_object('kind','post','subject_id','784001_1','metrics',jsonb_build_array(v_key)));
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',1)),'published_at',clock_timestamp()-interval '3 days','text','fixture','permalink',NULL,'received_at',clock_timestamp(),'observed_at',clock_timestamp());
    PERFORM public.persist_fb_analytics_capture((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  -- (3) job B (due D) re-persists day D-2 and the same post, taking the capture_id
  PERFORM public.enqueue_fb_analytics_collection_job(v_owner,v_account,v_date,false);
  v_b:=public.claim_fb_analytics_collection_jobs(1)->0;
  ASSERT (v_b->>'job_id')<>(v_a->>'job_id'),'overlap fixture needs a second job';
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||(v_date-2)||':'||v_key,
      jsonb_build_object('kind','account_day','subject_id','784001','metric_date',v_date-2,'metrics',jsonb_build_array(v_key)));
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),'received_at',clock_timestamp(),'observed_at',(v_capture->>'until')::timestamptz);
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:784001_1:'||v_key,
      jsonb_build_object('kind','post','subject_id','784001_1','metrics',jsonb_build_array(v_key)));
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),'published_at',clock_timestamp()-interval '3 days','text','fixture','permalink',NULL,'received_at',clock_timestamp(),'observed_at',clock_timestamp());
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  ASSERT NOT EXISTS(SELECT 1 FROM public.fb_analytics_metric_values m JOIN public.fb_analytics_captures c ON c.id=m.capture_id
    WHERE c.job_id=(v_a->>'job_id')::uuid AND m.post_snapshot_id IS NOT NULL),'overlap fixture: B took the post cells';
  -- (4) A's success is accepted although B owns the cells now
  PERFORM public.complete_fb_analytics_collection_job((v_a->>'job_id')::uuid,(v_a->>'claim_token')::uuid,(v_a->>'job_generation')::bigint,'success');
  ASSERT (SELECT state FROM public.fb_analytics_collection_jobs WHERE id=(v_a->>'job_id')::uuid)='success','an overlapped job completes';
  -- (5) a genuinely unavailable cell is still refused
  v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'post:784001_1:views:bad',
    jsonb_build_object('kind','post','subject_id','784001_1','metrics',jsonb_build_array('views')));
  v_payload:=jsonb_build_object('metrics',jsonb_build_object('views',jsonb_build_object('status','unavailable','reason','provider_error')),'published_at',clock_timestamp()-interval '3 days','text','fixture','permalink',NULL,'received_at',clock_timestamp(),'observed_at',clock_timestamp());
  PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  -- record B's inventory complete and B's day D-1 cells available, so only the unavailable post cell stands between B and success
  v_capture:=public.reserve_fb_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,NULL,0);
  PERFORM public.commit_fb_analytics_inventory_page((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'request_id')::uuid,ARRAY['784001_1'],NULL,false);
  FOREACH v_key IN ARRAY ARRAY['views','unique_viewers','engagements','followers'] LOOP
    v_capture:=public.reserve_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'day:'||(v_date-1)||':'||v_key,
      jsonb_build_object('kind','account_day','subject_id','784001','metric_date',v_date-1,'metrics',jsonb_build_array(v_key)));
    v_payload:=jsonb_build_object('metrics',jsonb_build_object(v_key,jsonb_build_object('status','available','value',2)),'received_at',clock_timestamp(),'observed_at',(v_capture->>'until')::timestamptz);
    PERFORM public.persist_fb_analytics_capture((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,(v_capture->>'capture_id')::uuid,v_payload);
  END LOOP;
  BEGIN
    PERFORM public.complete_fb_analytics_collection_job((v_b->>'job_id')::uuid,(v_b->>'claim_token')::uuid,(v_b->>'job_generation')::bigint,'success');
    RAISE EXCEPTION 'a job with an unavailable post cell was accepted';
  EXCEPTION WHEN SQLSTATE 'MAH05' THEN NULL;
  END;
END;
$overlap$;
```

`reserve_fb_analytics_inventory_page(job, claim, generation, NULL, 0)` returns `{ request_id }`; committing that request with `p_next_cursor = NULL, p_has_more = false` marks the checkpoint `inventory_complete` (see `supabase/tests/meta_owned_analytics_inventory.sql` lines 37–53). Operations are created and advanced by `reserve_*`/`persist_*_analytics_capture`. If the first `MAH05` block still refuses A after steps (1)–(3), read `read_fb_analytics_worker_state(...)->'operations'` and add whatever capture the account-day operation set still lists as pending — do not weaken the assertion. Write the Threads twin of this block (`threads_*` RPCs, provider `780001`, post `780001_1`, day metric `profile_views`, post metrics `views,likes,replies,reposts,quotes,shares`, plus one `profile` capture with `followers` available).

Expected before the migration: step (4) raises `MAH05` (the harness applies all migrations, so run the suite only with the migration present; the RED proof is the reviewer's reasoning plus the unchanged old assertions, not a local run).

- [ ] **Step 3: Local syntax check**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check meta-owned-analytics-sync/*.ts` (unchanged, sanity). There is no local Postgres (SA-15): the SQL proof runs in CI (`Postgres baseline plus delta`). Before pushing, read the migration diff against `20261101144500` once more and the appended test twice.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261105160000_meta_owned_analytics_completion_overlap.sql supabase/tests/meta_owned_analytics_capture_failures.sql
git commit -m "fix(db): judge an owned-analytics success by the account's cells, not the capturing job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Worker releases a refused completion

**Files:**
- Modify: `supabase/functions/meta-owned-analytics-sync/deadline.ts`
- Modify: `supabase/functions/meta-owned-analytics-sync/store.ts` (`complete`, ~line 184; the `MAH05` mapping in `call`, ~line 69)
- Modify: `supabase/functions/meta-owned-analytics-sync/worker.ts` (`collectJob`, ~lines 91–120)
- Test: `supabase/functions/meta-owned-analytics-sync/termination.test.ts`

**Interfaces:**
- Produces: `export class CompletionRefused extends Error { constructor(readonly sqlstate: "MAH05") }` in `deadline.ts`; `OwnedAnalyticsStore.complete` throws it when the `complete_*` RPC answers `{ error: { code: "MAH05" } }`; `collectJob` returns `"refused"` after completing `("failed", "completion_refused")`.

- [ ] **Step 1: Write the failing test**

In `termination.test.ts` the harness fakes RPC replies by name (see the `rpc` function around lines 40–60 that switches on `name`). Add:

```ts
Deno.test("a success the database refuses releases the job as failed and the drain goes on", async () => {
  const completions: Array<{ outcome: string; reason: string | null }> = [];
  let refusedOnce = false;
  // Build the same fully-collected fixture the existing "completes" test uses (inventory complete, every cell available),
  // but make the fake rpc answer complete_fb_analytics_collection_job like this:
  //   p_outcome === "success" && !refusedOnce → refusedOnce = true; return { data: null, error: { code: "MAH05", message: "META_ANALYTICS_INCOMPLETE_COLLECTION" } }
  //   otherwise → completions.push({ outcome: args.p_outcome, reason: args.p_reason }); return the normal completion receipt with state = args.p_outcome
  const result = await drainOwnedAnalytics(input);
  assertEquals(completions, [{ outcome: "failed", reason: "completion_refused" }]);
  assertEquals(result.status, "complete");
  assertEquals(result.counts.refused, 1);
});

Deno.test("MAH05 from a claim still stops the worker as configuration_unavailable", async () => {
  // fake rpc: claim_fb_analytics_collection_jobs → { data: null, error: { code: "MAH05" } }
  const refusal = await drainOwnedAnalytics(input).catch((error) => error);
  assert(refusal instanceof AnalyticsWorkerStopped);
  assertEquals(refusal.reason, "configuration_unavailable");
});
```

Fill the fixture from the existing fully-collected test in the same file (copy its `rpc` switch and `input`); do not invent new RPC names.

- [ ] **Step 2: Run the test to verify it fails**

Run: `DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --no-config --import-map=scripts/ci/deno-analytics.import-map.json --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none --allow-env supabase/functions/meta-owned-analytics-sync/termination.test.ts`
Expected: the first new test FAILS (the drain throws `AnalyticsWorkerStopped("configuration_unavailable")` instead of completing `failed`); the second passes already.

- [ ] **Step 3: Implement**

`deadline.ts` — add:
```ts
/** The database refused a job completion the worker believed complete (MAH05 from complete_*). */
export class CompletionRefused extends Error {
  constructor(readonly sqlstate: "MAH05") { super(`completion refused (${sqlstate})`); }
}
```

`store.ts` — in `call`, keep the existing `MAH05 → configuration_unavailable` mapping for every RPC **except** names starting with `complete_`; for those throw `new CompletionRefused("MAH05")`. The smallest change: give `call` an optional third parameter `onRefusal?: (code: string) => Error | null` that `complete()` passes as `(code) => code === "MAH05" ? new CompletionRefused("MAH05") : null`, and check it before the existing `MAH05` branch.

`worker.ts` — in `collectJob`, wrap the `success` completion:
```ts
    try {
      await input.store.complete(job, complete ? "success" : terminalTruncation ? "failed" : "partial", …);
    } catch (error) {
      if (!(error instanceof CompletionRefused) || !complete) throw error;
      // The database holds the stricter definition of "complete"; this job is finished either way.
      await input.store.complete(job, "failed", "completion_refused", null);
      return "refused";
    }
    return complete ? "success" : "partial";
```
and make sure `"refused"` is counted in `counts.refused` by the drain loop the same way provider refusals are (read how the loop maps the return value; do not add a new count).

- [ ] **Step 4: Run the tests to verify they pass**

Run the Task 2 Step 2 command plus the full worker set: `DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --no-config --import-map=scripts/ci/deno-analytics.import-map.json --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none --allow-env supabase/functions/meta-owned-analytics-sync/enqueue.test.ts supabase/functions/meta-owned-analytics-sync/composition.test.ts supabase/functions/meta-owned-analytics-sync/dispatch.test.ts supabase/functions/meta-owned-analytics-sync/collection.test.ts supabase/functions/meta-owned-analytics-sync/retention.test.ts supabase/functions/meta-owned-analytics-sync/truncation.test.ts supabase/functions/meta-owned-analytics-sync/termination.test.ts` and `DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check --no-config --import-map=scripts/ci/deno-analytics.import-map.json --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none supabase/functions/meta-owned-analytics-sync/*.ts`.
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/meta-owned-analytics-sync/deadline.ts supabase/functions/meta-owned-analytics-sync/store.ts supabase/functions/meta-owned-analytics-sync/worker.ts supabase/functions/meta-owned-analytics-sync/termination.test.ts
git commit -m "fix(analytics): a refused success completion releases the job instead of stopping the drain

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Gates, PR, migration on prod, merge

- [ ] Push `HEAD:refs/heads/fix/meta-analytics-completion-overlap`; open the PR (body: defect evidence from the spec §1, the two changes, gates, "migration applied before merge"); link and watch it.
- [ ] CI green on the exact head (the SQL proof runs there).
- [ ] Owner card → back up both functions (`pg_get_functiondef`, 0600) → apply the migration with `-U supabase_admin` in one transaction → verify `prosecdef`, `proconfig`, service-role EXECUTE → comment → squash-merge `--match-head-commit` → unwatch.
- [ ] Verify on prod: the edge sync hash of `meta-owned-analytics-sync/worker.ts`, the next drain receipt `ok:true`, and the pilot's 2026-11-05 job reaching `success` once its operations finish.
