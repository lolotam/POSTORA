# Owned Meta analytics workers implementation plan

**Goal:** complete C3 collection, durable continuation and inactive scheduling for owned Facebook/Threads analytics under the existing completion design.

**Architecture:** platform-owned SQL queues and adapters, one internal coordinator, shared canonical calendar/metric/transport modules. New migrations extend the unmerged C2 candidate additively. No production activation is part of implementation.

**Required reading:** `ARCHITECTURE.md` §§12–17, 23–28, 31–37, 40, 45–46; the [C3 contract](../specs/2026-11-01-meta-owned-analytics-workers.md); the [history/job ADR](../specs/2026-11-01-meta-analytics-history-job-model.md); the existing C2 migration and platform provider modules. Execute inline; this plan does not request delegation.

## 1. Admission bootstrap and actual HTTP boundary

Files:

- Add `supabase/migrations/20261101140000_meta_owned_analytics_worker_admission.sql`.
- Add `supabase/tests/meta_owned_analytics_worker_admission.sql`; register it in `scripts/db-harness.sh`.
- Add `supabase/functions/meta-owned-analytics-sync/{index,handler,admission,store,permissionProvider}.ts` and their boundary/integration tests.
- Extend `_shared/metaAnalyticsTransport.ts` with the actual pre-request permit and wire both admission provider callers; preserve existing live consumers.
- Reflect real catalog RPCs in `src/integrations/supabase/types.ts`.

- [ ] Write the real SQL admission test first. Create synthetic two-owner Page/Threads rows and actual Facebook bindings using the C2 suite's shape. Require browser denial, off-policy refusal, complete expected-authority equality, correct operational/protected token separation and unchanged credential/settings/cron fingerprints.
- [ ] Run it against the labelled disposable harness; require missing admission RPC failure before implementation. Never run this fixture in production.
- [ ] Implement the two service-only credential readers under the existing preparation/locks, without new token storage, refresh captures or caller owner IDs.
- [ ] Add strict typed RPC decoding and bounded calls. Classify MAH refusals separately from unknown outcomes; drop raw driver messages and token-bearing provider URLs.
- [ ] Implement the explicit admission action and real debugger/identity adapter. Every network call repeats current authority/policy through the transport permit outside its provider catch; observation persistence repeats the SQL fence after HTTP.
- [ ] Prove valid/missing scopes, wrong identity/app, omitted Threads app ID, malformed/expired token, stale authority before/after HTTP, unknown timeout and no secret leakage through the registered handler. Verify no enqueue or schedule change occurs during this admission slice.
- [ ] Run the fresh SQL harness and affected Deno composition/type checks; apply guards and commit this coherent admission slice. Record it as partial C3, not a finished worker.

The SQL entrypoint contract is exact:

```sql
public.read_fb_analytics_admission_credential(
  p_account_id uuid, p_expected_authority jsonb DEFAULT NULL
) RETURNS jsonb;
public.read_threads_analytics_admission_credential(
  p_account_id uuid, p_expected_authority jsonb DEFAULT NULL
) RETURNS jsonb;
```

## 2. Durable dispatch and worker-state protocol

- [ ] Add `20261101141000_meta_owned_analytics_worker_progress.sql` and its SQL suite. Implement a private platform/due-date/policy-digest dispatch checkpoint and one-step current-policy advancement. Use existing enqueue business keys; never force an already enqueued generation.
- [ ] Add a fenced claimed-generation state reader and checkpoint page reservation/commit under the existing parent-first locks. Keep inventory outside numeric capture kinds. Database-generated reservation UUID, expected prior cursor/page count and payload digest must prove identical replay, conflicting replay and stale-generation refusal.
- [ ] Exercise more than 50 synthetic targets, policy changes, duplicate dispatch, expired due date, page restarts, repeated cursors, foreign IDs, 500-ID truncation and unknown advancement outcomes. No successful page/sweep may hide incomplete work.
- [ ] Implement `dispatch.ts` and wire `enqueue-daily` in the strict route. Reuse admission before enqueue. One action-wide 40s deadline/50-target counter persists across platform selection; no first-page restart loop.
- [ ] Refresh types from the disposable applied catalog, run the SQL suites plus 18 existing races, guard and commit.

## 3. Provider capture and resumable drain

- [ ] Add `worker.ts`, `facebookCollection.ts`, `threadsCollection.ts` and typed receipt/state decoding in `store.ts`. Wire `drain` from the actual entrypoint in the same change.
- [ ] Narrow `alignedDailySeries` to the window boundaries/buckets it actually reads; preserve existing full-window callers and their behavior. Add actual provider post-detail requests only where the worker needs metadata after restart.
- [ ] Plan the last closed provider-calendar day and correction day as durable operations before HTTP. Build operation identities from kind/subject/window, reserve before request, skip accepted operations on reclaim and persist response cells/metadata atomically.
- [ ] Exercise worker → real SQL → report read with true zero, omitted value, malformed bucket, wrong version, mixed cell failure causes, partial inventory and same-day supersession. A crash after a known/unknown commit must not reset completed operations or advance uncommitted state.
- [ ] Integrate persistent usage/backoff with both the existing Instagram and new workers as real consumers. Use only bucket-only Instagram throttle RPC calls, namespaced platform/app/authority keys, and each platform's own job completion.
- [ ] Prove timeouts for each dependency, ignored aborts, reserved final writes, stale permits, fairness, revoked authority and bounded post visits. Unknown store outcomes stop the complete invocation; known target refusals do not poison other eligible targets.
- [ ] Run affected existing provider/Instagram suites and new integration/termination suites, guards and commit.

## 4. Bounded retention and inactive schedules

- [ ] Add `retention.ts` using existing cleanup RPCs and the independent retention scope. Wire `retention` in the strict route. Pin a single UTC floor and share 50 visited targets/500 actual physical deletions across both platforms.
- [ ] Prove dry-run nonmutation, disabled/disconnected target eligibility, live-lease exclusion, no-op revisions and unknown commit termination through real SQL. Keep Instagram retention unchanged.
- [ ] Add `20261101143000_meta_owned_analytics_cron.sql` only once the six real route bodies in the C3 contract are accepted and tested. Install all six inactive; require pg_cron, pg_net and `get_cron_secret()` before any mutation.
- [ ] Test repeated installation, active-to-inactive reconciliation, secret rotation, missing prerequisites and unchanged unrelated jobs/settings. Parse/execute the exact stored request bodies against the registered handler with synthetic authorization.
- [ ] Complete the fresh SQL harness, races, Deno type/tests, frontend typecheck/build and immutable lint/i18n no-regression gate. Run `graphify update .`; exclude graph/cache artifacts and secrets from commits.

## 5. Review and deployment prerequisites

- [ ] Record exact tested candidate hashes, real executed counts, remaining omissions and source/test/docs guard results in `docs/journeys/`.
- [ ] Open/update the stacked C3 PR against C2 and link its full URL immediately after create/push. Keep migration merge/application and runtime deployment decisions separate. Do not deploy unapproved dependent schema/runtime.
- [ ] After separately approved application, verify actual catalog/ACLs/cache before dependent runtime deployment; then verify runtime SHA256 and disabled-state boot. No admission, token repair, deletion, collection or cron activation follows implicitly.
- [ ] Continue C4 persisted reports and C5 unified UI. Only their completed proofs plus the full Instagram G-X and separately approved live reconciliation/seven scheduled due dates can complete the overall goal.

## Local evidence commands

The disposable container must be exactly the inspected, labelled `postora-meta-history-pg-20261101`, database `meta_analytics_history_harness`, with `cron.launch_active_jobs=off`. Reuse `.tmp/prepare-meta-history-harness.sh` only after checking that identity; the repository harness owns baseline restoration and all registered SQL suites.

```powershell
python scripts/ci/test-meta-owned-analytics-races.py `
  --container postora-meta-history-pg-20261101 `
  --database meta_analytics_history_harness `
  --docker 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' `
  --report .tmp/c3-races.json
npm run typecheck
npm run build
```

Use Deno 2.9.8 with `--no-config --no-lock --node-modules-dir=none` for the affected modules/tests; restrict permissions to those each composition fixture actually needs. External imports failing locally are a failed/unavailable proof, never a passing test. The hosted CI must run the same required suite rather than rely on a prose assertion.
