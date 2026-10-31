# Instagram collection rollout controls implementation plan

Date: 2026-10-30. Status: documents only; future implementation assignment required. Production steps are listed, **not authorized**.

**Goal:** independently approve one owner account, one competitor/viewer pair, then wider collection while global credential mode remains legacy. Implement the [spec](../specs/2026-10-30-instagram-collection-rollout-controls.md), supplying [Task 11](2026-10-30-instagram-release-gates.md)'s missing D1/daily-dispatch/C1 prerequisites. This is a bounded follow-on to parent Tasks 4, 6 and 7, not a replacement for their provider/report contracts.

**Architecture:** SQL owns eligibility and tenant scope at enqueue/claim/write; service adapters consume typed decisions and obtain a fresh job-scoped permit before each provider request. Daily dispatch persists bounded progress in Postgres; cron only triggers authenticated routes. Reuse existing handler/worker/store separation and generation/lease fences. No UI, credential-store redesign, production operation or new orchestration service is required here.

**Baseline:** `E:\Dev\Worktrees\postora_new\collection-rollout-docs`, `docs/collection-rollout-controls`, `a8e5868b061e8f766eb3934acfd59e99c1f5bc93`. Source findings are in spec §1. The author read code and repository documents only; source presence is not deployment evidence. The current delivery changes only this plan, its spec and the three requested sections of the Task 11 spec.

Before future implementation read [ARCHITECTURE.md](../../ARCHITECTURE.md) **in full**, especially §0/1, §3–4, §12–17, §23–28, §31–39 and §45–46; [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md), [PROJECT_AGENT.md](../../PROJECT_AGENT.md), directory rules, both Task 11 documents, and the [parent](2026-10-26-instagram-insights-and-competitor-tracking.md) §4, Tasks 4/6/7, §9, §12–14 and protected-cutover progress. Every future delegation brief must include these readings; no delegation/model choice is made by this plan.

Execute **one numbered task at a time**, review its tests and diff, then advance. Tests precede each production change. An unavailable dependency remains a blocker, not permission to widen scope or weaken a test. This authoring request explicitly permits the final scoped local commit; the historical delegate no-commit clause below still applies to future implementation delegates unless their assignment overrides it.

## Global constraints — parent §4, quoted verbatim

1. Read `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` (§3–4, §12–17, §23–28, §31–39), `PROJECT_AGENT.md`, this plan and the source spec before changing code. Follow directory-scoped instructions.
2. Implement only the numbered task(s) assigned. Do not commit, push, merge, deploy, run production SQL, modify secrets or touch the standalone n8n node repository. The orchestrator reviews and commits scoped files.

> These constraints bind a **delegated implementer**, whose work the orchestrator reviews and then commits as a scoped local commit. The orchestrating session follows the full CLAUDE.md Task Execution Workflow (including the scoped local commit for every task); nothing in this plan replaces or waives it.
3. Preserve unrelated user work and existing API behavior. No broad refactors, platform-version migration, scraping index, Facebook insights, hashtag search, Ad Library, or optional work without explicit approval.
4. Derive caller identity from verified auth. Service-role reads and writes must structurally enforce resource ownership, including denormalized user IDs and post/account links. RLS alone does not protect service-role work.
5. Null means unavailable, never zero. Failed reads/writes are failures, never empty data or successful syncs. Validate untrusted inputs/responses, sanitize client errors, redact logs, and log every refusal/early exit.
6. No token-prefix heuristics, raw tokens in frontend/contracts/logs, browser-readable new credentials, or provider URLs containing credentials in logs. Provider calls use explicit timeout, bounded retries and trusted-host cursor construction.
7. Scheduled and on-demand work uses atomic durable claims, expiring leases, checkpoints, idempotent upserts and bounded wall-clock/request budgets. No unbounded waitUntil jobs or browser-owned scheduling.
8. Keep UI → application ports/domain; infrastructure implements ports; only feature composition roots wire infrastructure. React Query hooks belong to UI, not framework-independent application modules. New modules must have real production callers.
9. Rehearse additive migrations and tenant-negative tests before release. Apply and verify prerequisites before deploying dependent functions/frontend. Enable new schedules only after functions boot and readiness is verified.

## Migration reservations and dependencies

| Alias | Exact new migration | Dependency |
|---|---|---|
| R1 | `supabase/migrations/<version per release-gates §5>_instagram_collection_rollout_controls.sql` | Existing capability/binding/durable-job/lifecycle/direct-reader migrations and Task 8 M1 v2 writer. |
| R2 | `supabase/migrations/<version per release-gates §5>_instagram_collection_daily_dispatch.sql` | R1 admission contract, existing competitor due-date/result schema. |
| C1 | `supabase/migrations/<version per release-gates §5>_instagram_collection_cron.sql` | R1/R2 and completed owner/competitor registered dispatch/drain routes. |

Collision check (corrected): the authoring baseline's claim that `20261030100000` was the only 20261030 migration is stale. Main now holds `20261030090000` to `20261030150000`, including M1–M4 (#306), `20261030140000_sweep_ai_image_staging_cron.sql` and `20261030150000_record_published_story.sql` (#313), so the earlier R1/R2/C1 timestamps are withdrawn. Each version is assigned when its task creates the file: unused in `supabase/migrations/`, newer than every migration on main and the harness baseline marker at that time, and in the order R1 < R2 < C1. `20261030140000` and `20261030150000` are already taken on main (`sweep_ai_image_staging_cron`, `record_published_story`), so no 20261030 slot is reserved. Recheck before creating files and against the live ledger only under future production approval. Never renumber an applied migration; stop if ownership/collision changed.

R1/R2/C1 follow M4 numerically. Task 8 M2–M4 remain separately owned: include them if landed in the complete baseline-plus-delta ledger; do not implement or falsely mark them delivered here. Preserve M1 v1/v2 result compatibility and coordinate its shared fence consumers. Apply and verify all missing reviewed prerequisites before deploying dependent runtime; do not depend on main auto-deploy or the reconciler to migrate SQL.

## Numbered implementation tasks

### 1. Make SQL the rollout admission authority — R1

**Create:** R1; `supabase/tests/instagram_collection_rollout_controls.sql`; `supabase/tests/instagram_collection_rollout_race_fixture.sql`.

**Modify:** `src/integrations/supabase/types.ts`; `scripts/db-harness.sh`; `supabase/tests/README.md`.

**Modify (fixture setup only, preserving existing assertions):** `supabase/tests/{instagram_durable_collection_jobs,instagram_direct_collection_credential,competitor_collection_results,competitor_capture_coverage,meta_account_refresh_lifecycle}.sql`; `supabase/tests/{instagram_durable_collection_jobs_race_fixture,meta_page_token_reconciliation_race_fixture}.sql`. These inspected suites exercise affected RPCs. Seed an explicit synthetic enabled policy/eligible authority inside their existing rollback or cleanup lifecycle so the new default-off gate does not invalidate unrelated lease/credential assertions. Keep the new rollout suite's independent missing/off/denial fixtures; do not globally enable collection in the harness or bypass the new predicate.

**Contract:** spec §2 and §3. Add the default private JSON policy and internal canonical evaluator; add `authorize_instagram_collection_provider_call(uuid,uuid,bigint) returns jsonb`. Amend existing enqueue, all claim candidate passes/locked claim, viewer attach and common write/context fences in the **new** migration. Cover competitor v1/v2 and direct reader with current eligibility without changing token storage. Add no client-selected owner to the permit RPC.

- [ ] Prerequisite: all three steps of the release-gates Task 6 bootstrap have landed (CODEOWNERS and its branch protection; the gate App, its default-branch-restricted key environment and the gate workflow; the gate context required on main and pinned to the App after its first post); do not open the R1 PR before then.
- [ ] Assign R1's version per spec §5 on current `main`, filling R1's version in the canonical manifest (the release-gates spec §5 ordered-migrations table, the only manifest the checker reads) in the same PR as the migration, or the gate fails it as `manifest_rewritten` (unused, newer than every migration and the baseline marker, after the previous series member); renumber before merging if main gains a newer migration; squash-merge, then record the merge snapshot (first parent of the squash commit, its newest migration version and baseline marker); the Task 11 evidence JSON copies it.
- [ ] Tests first: master/policy off/missing/malformed/read failure, strict policy schema and list bounds, no browser policy/service-RPC access, own/foreign/nonexistent equivalence, forged service owner and target kind, mixed service batches, admin bypass denial and no force throttle mutation on exclusion. Assert both accepted receipts and new refusal unions.
- [ ] Seed old queued/retry/partial/expired-lease/finalize-only jobs for excluded same-owner/shared-grant/foreign accounts. Assert every claim pass returns eligible jobs only, including an eligible job behind >500 excluded rows. Check excluded rows' attempts/generations/success timestamps unchanged.
- [ ] Add pinned-viewer SQL negatives: mismatched owner, other approved owner's viewer, direct login, inactive/reauth/denied/unknown capabilities, replaced binding/generation. Do not use compatibility linkage as a direct-token authority. Include absent/expired direct operational credential without exposing its value.
- [ ] Implement fixed-search-path/minimal-ACL helpers and bounded sanitized refusal rows in existing `system_logs`. Normal refusal returns commit its audit; exception-path audit is an adapter responsibility after rollback. Do not change global mode, OAuth pilot list or edited policy values. Preserve successful RPC projections and classify new failures strictly.
- [ ] Define and exercise real two-session interleavings for enqueue vs exclusion, claim vs exclusion, attach vs viewer removal, result write vs exclusion, reconnect vs permit, and both lock acquisition orders. Reuse established sorted account/parent→job order; a policy writer must not introduce a settings→account lock inversion. Document the permit authorization instant and in-flight limitation.
- [ ] Add `get_instagram_collection_rollout_policy` (canonical policy plus SHA-256 fingerprint) and `set_instagram_collection_rollout_policy` (row lock, compare `p_expected_fingerprint` with the recomputed current fingerprint, canonicalize, require asserted `p_actor`/`p_approval_ref`, audit in the same transaction), and a trigger refusing any other write to the key. Test RC-17's two-session stale add/remove race.
- [ ] Run V2 full SQL harness and manual races; compare grants/types and accepted function signatures. Register the main suite and explicitly classify the manual fixture; retain every existing suite. Catalog evidence must show no browser privilege expansion.

**Acceptance:** RC-01–08, RC-13–15, RC-17 (SQL portions). **Dependencies:** accepted baseline; no production application. **Exit:** tested additive SQL prerequisite and exact refusal contract, not a running collector.

### 2. Wire owner per-account admission and per-request authorization

**Create:** `supabase/functions/instagram-insights-sync/rollout.test.ts`.

**Modify:** `supabase/functions/instagram-insights-sync/{index,handler,store,receipts,worker,workerStore,providerTransport,graphProvider,directGraphProvider}.ts`; adjacent existing `{handler,store,handlers,drainHandler,worker,workerStore,graphProvider,directGraphProvider,workerTermination}.test.ts`; `workerTestSupport.ts` only for injected guard/refusal fixtures.

**Contract:** replace the blanket global-protected gate with SQL admission and existing trusted per-account credential selection. Keep global-mode validation, own-only bearer identity, master-off short circuit and existing direct/Page transport. Adapt SQL refusal receipts; bind a fresh permit callback to the actual request loop, including internal retries/pagination. No new generic shared collection helper.

- [ ] Tests first: one allowlisted A under global legacy progresses; same-owner B/shared-grant C/foreign D never resolve a usable job or issue HTTP. Use pre-existing pending jobs as well as fresh enqueue and targetless drain. Assert calls keyed by target and credential identity, not only total calls.
- [ ] Pin direct tests to actual fenced reader semantics, trusted classification/generation and no Facebook-linkage requirement. Pin Page-linked tests to protected User binding and no metadata/Page fallback; errors/missing authority never trigger exploratory HTTP. Readiness must include token expiry, not presence only.
- [ ] Add refusal after claim and between provider retries/pages/media calls; fail permit read/malformed envelope/audit and verify no subsequent HTTP or successful write. Preserve rollback-aware result fences, per-account fairness and bounded budgets. An already-authorized call is classified as in flight, not erased from evidence.
- [ ] Exercise actual `index.ts` composition, own-only admin status/enqueue, privileged drain auth, off-state with unavailable new SQL, report readability through existing report route and no scope/health mutation from rollout refusal.
- [ ] Run V1 owner and protected-cutover/OAuth/refresh compatibility suites; V3 typecheck. Show non-test `index → worker/store → permit → request` calls. Do not edit `_shared/protectedAccountCutover.ts` or OAuth/refresh behavior to compensate for an invented direct store.

**Acceptance:** RC-01–03, RC-05–09 where applicable, RC-13–16. **Depends on:** Task 1. **Exit:** local one-owner exclusion proof; no pilot activation.

### 3. Wire competitor target/viewer isolation

**Create:** `supabase/functions/competitor-snapshot-sync/rollout.test.ts`.

**Modify:** `supabase/functions/competitor-snapshot-sync/{index,handler,store,syncWorker,types,receipts,graphProvider}.ts`; adjacent `{handler,route,store,syncWorker,sqlContract,graphProvider}.test.ts`.

**Contract:** independent competitor policy; strict watchlist→approved viewer pair in allowlist mode; protected same-owner candidates in all mode. Retain existing selector ordering only within the eligible candidate set and existing v2 coverage writer. Use SQL attach and per-request guard; the global-mode check alone is no longer the gate.

- [ ] Tests first: competitor off while owner pilot runs; exactly one pair admitted; other watchlists, same handle in another tenant, shared-grant sibling, unapproved alternate viewer and direct viewer all have zero provider calls. Make the pinned viewer fail and prove no substitution or scheduled Apify request.
- [ ] Add service attach/SQL negatives and actual-route tests for owner entry/force/status, cron/service/admin all/enqueue-daily, invalid/malformed settings, SQL refusal mapping and lost authority. Show owner approval does not enable competitors; viewer approval does not enable owner insights.
- [ ] Restrict candidates through a job-scoped SQL decision, without token reads before scope is established. Keep provider provenance, weekly retry, shared usage throttles, nullable metrics, <=30 media and v1/v2 result semantics. Guard each provider retry/cursor request; preserve captured generation at write.
- [ ] Run V1 competitor plus existing owner suites affected by common SQL, V2 SQL (including M1 coverage), V3 typecheck. Inspect all failure logs and actual production request call sites. Do not patch Task 8 report/UI or interactive brand-scrape.

**Acceptance:** RC-01/02/04/05/07/08/13–16. **Depends on:** Task 2 accepted owner-flow proof, matching parent §14 sequencing. **Exit:** local one-competitor exclusion proof; no live collection.

### 4. Add durable daily dispatch and bounded resumption — R2

**Create:** R2; `supabase/tests/instagram_collection_daily_dispatch.sql`; `supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql`; `supabase/functions/instagram-insights-sync/{dailyEnqueue,dailyEnqueueStore}.ts` and adjacent tests; `supabase/functions/instagram-insights-sync/dailyEnqueueHandler.test.ts`.

**Modify:** `src/integrations/supabase/types.ts`; `scripts/db-harness.sh`; `supabase/tests/README.md`; `supabase/functions/instagram-insights-sync/{index,handler,worker}.ts` and relevant tests; `supabase/functions/competitor-snapshot-sync/{index,handler,store,syncWorker,types,receipts}.ts` and `{handler,route,store,syncWorker}.test.ts`.

**Contract:** spec §4. Owner exact `action:"enqueue-daily"`; competitor distinct `mode:"enqueue-daily",dispatch:"durable"` branch. Both use `enqueue_instagram_collection_daily_page(p_target_kind,p_start)`, table `instagram_collection_enqueue_sweeps`, DB-selected Kuwait day and atomic anti-join continuation. Preserve accepted legacy competitor cursor branch; no cron depends on its HTTP response cursor.

- [ ] Assign R2's version per spec §5 on current `main`, filling R2's version in the canonical manifest (the release-gates spec §5 ordered-migrations table, the only manifest the checker reads) in the same PR as the migration, or the gate fails it as `manifest_rewritten` (unused, newer than every migration and the baseline marker, after the previous series member); renumber before merging if main gains a newer migration; squash-merge, then record the merge snapshot (first parent of the squash commit, its newest migration version and baseline marker); the Task 11 evidence JSON copies it.
- [ ] Tests first: HTTP 401/403/405, privileged auth, forged identity/unknown keys/date/owner/force/cursor/limit, body boundaries, disabled before schema, no-work/repeat 200, partial 202, exact counters, the daily-page receipt union including `invalid_target_kind` with no sweep row and no refusal audit row, timeout/malformed/lost reply indeterminate and zero provider calls from dispatch.
- [ ] SQL tests seed >25 owners, >50 and >1,000 competitors; page through actual production adapters. Verify every eligible target eventually gets one current-day job, duplicates keep generation, master/policy exclusion wins at insert, weekly retry not bypassed, bounded scans and truthful pending/completed/expired states.
- [ ] Prove transaction atomicity with concurrent start/resume and failure before/after commit, lost HTTP response, current-day replay/reopen, midnight rollover, newly eligible target and no-progress errors. Capture two independent session waits; fixture setup alone is not proof. Completed sweeps cannot falsely certify excluded or later-added targets as collected.
- [ ] Implement at most one 25/50-target enqueue page per dispatch/resume. Wire resume before drain inside the same <=40s deadline with dependency/write/audit reserves; skip/defer if budget insufficient. Do not start a sweep from a bare drain or perform recursive HTTP. Existing claim caps remain 25/50.
- [ ] Add adapters and receipt validation with real production callers. Keep owner-specific orchestration in its feature folder and competitor orchestration in its own; SQL is the shared contract, not cross-feature TypeScript imports. Preserve report/intake successful DTOs.
- [ ] Run V1/V2/V3; prove >1,000-target completion spans multiple bounded invocations and failure remains observable. Register both new suites/race fixture without excluding old tests.

**Acceptance:** RC-01–04, RC-08–11, RC-13/14/16. **Depends on:** Tasks 1–3. **Exit:** both exact cron dispatch contracts exist and have durable continuation consumers.

### 5. Install four inactive authenticated schedules — C1

**Create:** C1; `supabase/tests/instagram_collection_cron.sql`.

**Modify:** `scripts/db-harness.sh`; `supabase/tests/README.md`.

- [ ] Assign C1's version per spec §5 on current `main`, filling C1's version in the canonical manifest (the release-gates spec §5 ordered-migrations table, the only manifest the checker reads) in the same PR as the migration, or the gate fails it as `manifest_rewritten` (unused, newer than every migration and the baseline marker, after the previous series member); renumber before merging if main gains a newer migration; squash-merge, then record the merge snapshot (first parent of the squash commit, its newest migration version and baseline marker); the Task 11 evidence JSON copies it.
- [ ] Tests first: apply definition twice in disposable DB; exactly four named inactive jobs, exact bodies/UTC expressions/URLs, no duplicates, no edits to unrelated schedules, no policy/global-mode activation. Repeat after synthetic activation and prove reapplication intentionally pauses these jobs.
- [ ] Negative tests for missing pg_cron, pg_net and `public.get_cron_secret()` must fail installation atomically with no partially installed schedules. Separate controlled database fixtures may be needed; do not drop shared harness dependencies or weaken the production precondition to get green.
- [ ] Use the existing inactive-install/runtime-lookup examples from spec §1, with explicit failure instead of silent skip. Lookup the secret only in stored command execution. Inspect stored command text for literal credentials. Use disposable replacement secret/helper/HTTP capture to verify rotation without network or outputting secret values.
- [ ] Install 00:30/01:00 UTC daily jobs and proposed two-minute drains, inactive, with <=60s HTTP timeout. Match registered route bodies including competitor `dispatch:"durable"`. No fifth continuation job or retention edit.
- [ ] Run V2; inspect real cron catalog and verify whole baseline-plus-delta order. C1 does not prove production cron is installed, nor that either handler has been deployed.

**Acceptance:** RC-12/16, parent S6. **Depends on:** Task 4, reviewed R1/R2 and actual routes. **Exit:** local idempotent inactive-install proof only.

### 6. Assemble exclusion, rollback and Task 11 handoff evidence

**Create:** `supabase/functions/instagram-insights-sync/rolloutIntegration.test.ts`; `supabase/functions/competitor-snapshot-sync/rolloutIntegration.test.ts`; `docs/runbooks/instagram-collection-rollout.md` (future implementation deliverable).

**Modify:** `.github/workflows/ci.yml` for additive required Deno and SQL test inventories; these rollout spec/plan files for actual validation results; Task 11 spec §5/§6 D1 and §8 Q2 for accepted prerequisite status and the manifest's Inventory state column only; the Order, Exact migration and Superseded by entry fields were already filled by the member PRs and stay unchanged. Do not rewrite the historical Task 11 evidence baseline.

- [ ] Tests first: actual registered handler → production store → disposable SQL → fake provider transport → persisted snapshot/status. Strict synthetic fixtures include owner A, same-owner B, shared-grant sibling C, foreign owner D, allowed competitor/viewer and excluded same/foreign watchlists. Assert exact zero calls for every excluded identity in each activation stage.
- [ ] Test rollback during an actual lease/permit, write refusal after exclusion, quiescence, safe scoped resume, report/history preservation and no credential-mode change. Repeat with a missing policy, failed read and audit failure; ordinary errors cannot become empty success. Include a copied-source guard disconnection negative control that fails behaviorally, without changing committed source.
- [ ] Run final V1–V4 on one immutable candidate. Preserve existing OAuth/refresh/publishing, quota/retention, report and durable-job tests; classify environmental failures and pre-existing diagnostics honestly. No `--no-check`, removed assertions, hidden skips or zero-test passes for new suites.
- [ ] Run production/test/document guards where applicable, record unavailable tooling and an explicit manual-equivalent review, inspect active callers/dependency direction, types and SQL ACLs. After implementation code changes run graph update; this documentation authoring does not modify the graph.
- [ ] Write the runbook with R1/R2/C1, exact runtime import closure/hashes, SQL before runtime order, every off-state check, command/body/cadence catalog, bounded continuation/expiry evidence, zero-call matrix, audit policy and rollback-compatible last-good runtime. Link [deploy-edge-function.md](../runbooks/deploy-edge-function.md) for paths/SHA256/boot; do not duplicate secrets or host procedure.
- [ ] Hand RC-01–17 evidence to Task 11 G-O/G-C/G-S/G-X; retain G-L and every B–E approval as pending. Parent metric/retry discrepancies and Task 8 report/retention dependencies are separate blockers. A passing controls test does not make a whole product journey or live Meta support accepted.

**Acceptance:** all RC IDs, especially RC-03/04/07/13–16. **Depends on:** Tasks 1–5. **Exit:** STOP at reviewable local implementation handoff. No production activity follows automatically.

## Validation commands

These are future implementation gates, **not product tests executed by this document author**. Run from the assigned implementation worktree with a clean synthetic environment; do not source repository `.env*` or read production credentials. Freeze resolved test paths, runtime versions, candidate SHA, commands, exits and artifacts. New tests named above must exist before these commands count as valid inventory.

### V1 — Deno checks, boundary and registered-route tests

Use Bash/Git Bash/WSL for expansion, not literal PowerShell globs. Tests inject provider transport and synthetic env values; environment permission is not authorization to read real secrets.

```bash
deno check --node-modules-dir=none supabase/functions/instagram-insights-sync/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-snapshot-sync/*.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/instagram-insights-sync/{handler,store,worker,workerStore,graphProvider,directGraphProvider,workerTermination,rollout,dailyEnqueue,dailyEnqueueStore}.test.ts \
  supabase/functions/competitor-snapshot-sync/{handler,store,syncWorker,sqlContract,graphProvider,apifyProvider,rollout}.test.ts
deno test --node-modules-dir=none --allow-read --allow-write --allow-env --allow-run \
  supabase/functions/instagram-insights-sync/{handlers,drainHandler,dailyEnqueueHandler}.test.ts \
  supabase/functions/competitor-snapshot-sync/route.test.ts
```

Run the existing protected-cutover/OAuth/refresh and report/credential suites using their full maintained CI inventory; do not extend old compatibility exemptions to new tests. Integration suites from Task 6 should launch/use the dedicated local SQL transport through scoped `--allow-run=docker` (or a documented local fixture adapter), fake Meta HTTP, and no public egress. Record the exact final command and fixture port allowlist if local PostgREST is used; missing runtime is a blocked integration gate. Suggested SQL-only adapter invocation after those suites implement that seam:

```bash
deno test --node-modules-dir=none --allow-read --allow-env --allow-run=docker \
  supabase/functions/instagram-insights-sync/rolloutIntegration.test.ts \
  supabase/functions/competitor-snapshot-sync/rolloutIntegration.test.ts
```

### V2 — disposable baseline-plus-delta SQL and races

Follow [supabase/tests/README.md](../../supabase/tests/README.md) and the complete [harness](../../scripts/db-harness.sh), preserving all registered main/isolated suites. Restore the committed baseline then newer migrations; never replay all historical migrations from scratch. Example Bash commands, intentionally synthetic password, network disabled and no host port:

```bash
docker run -d --name postora-rollout-controls-sql --network none \
  -e POSTGRES_PASSWORD=postgres -v "$PWD:/repo:ro" \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=instagram_rollout_harness \
  -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault
docker inspect --format '{{.State.Health.Status}}' postora-rollout-controls-sql
# Proceed only when healthy; keep readiness checks bounded.
docker exec -e HARNESS_DB_NAME=instagram_rollout_harness postora-rollout-controls-sql \
  bash -c "cd /repo && bash scripts/db-harness.sh 'postgres://supabase_admin:postgres@localhost:5432/postgres'"
docker exec -i postora-rollout-controls-sql psql -U supabase_admin \
  -d instagram_rollout_harness -v ON_ERROR_STOP=1 -v disposable=1 \
  -f /repo/supabase/tests/instagram_collection_rollout_race_fixture.sql
docker exec -i postora-rollout-controls-sql psql -U supabase_admin \
  -d instagram_rollout_harness -v ON_ERROR_STOP=1 -v disposable=1 \
  -f /repo/supabase/tests/instagram_collection_daily_dispatch_race_fixture.sql
```

The final two commands set up fixtures, not concurrency proof. Their new headers must contain exact Session A/B transactions, wait observations, assertions and cleanup; execute in two independent `docker exec -it ... psql` sessions. Run applicable existing durable-job/credential/refresh race fixtures as well. Keep both outcomes and rollback cases. Cron tests must run against installed pg_cron catalog using synthetic interception without network dispatch; no live `get_cron_secret()` call. Remove only the verified dedicated task container after evidence collection.

### V3 — frontend types and repository regression

```powershell
npm run typecheck
npm test
npm run build
npm run lint
git diff --check
```

The maintained database types change even though this feature has no UI. Compare them with the exercised catalog rather than hand-waving successful frontend typecheck as SQL proof. Report complete exits and pre-existing failures. Use the repository's accepted immutable no-regression policy if needed, without moving baselines, new suppressions or false global-clean claims. Preserve existing relevant publishing/report tests even though those production files do not change.

### V4 — reachability, scope and future graph update

```powershell
graphify update .
git diff --stat
git diff --check
```

Only run graph update after future **code** changes, not this three-document delivery. Verify non-test actual calls from both registered indexes to dispatch/continuation and provider guards, not identifier/type-import matches. A helper with tests and no runtime consumer fails RC-16.

## Production handoff — listed, not authorized

Task 11 [B–E](../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step) owns per-action approval references, exact target IDs, timestamps, operator and evidence. Later actions are: approved preflight/ledger → apply missing reviewed R1/R2/C1 with all four jobs inactive → deploy full reviewed import closure and verify SHA256/boot/off state → independent OAuth pilot/reconnect/regression gates → D1 prerequisite acceptance → D2 exactly one owner → D3 exactly one competitor/viewer → E1 specified wider populations → E2 exact schedules/capacity → observation and release acceptance. Each step stops for its own approval. Retention remains separately approved under Task 8/E3.

No global protected-mode flip is part of those collection steps. `all` is an explicit grant including future eligible targets, not a synonym for “all accounts have ready credentials”. Measure exclusions. Before a direct pilot, retain the direct lifecycle/token-visibility evidence requirement in spec §3. Rollback disables scheduling/admission, settles in-flight work and keeps schema/history/credentials with a rollout-aware runtime. Link existing deploy instructions rather than copying server commands here.

## Open questions and defaults

Use the single register in [spec §8](../specs/2026-10-30-instagram-collection-rollout-controls.md#8-open-questions-for-waleed): exact first account/login type, competitor/viewer pair, wider/future-target population, cadence/72-hour observation, and bounded in-flight rollback expectation. Recommended defaults do not authorize a production configuration change. Parent metric support/retry discrepancies stay with Task 6 and Task 11; no silent acceptance amendment is introduced.

## Authoring validation and stop boundary

For this document-only delivery, verify the parent §4 quotation verbatim, all RC IDs and task references, local links, baseline citations, migration ordering/reservations and Create/Modify consistency. Manually review fail-closed behavior, tenant scope, global-legacy credential selection, pending continuations, audit rollback and approval boundaries. Run `git diff --check`, stage only the three requested paths, then `git diff --cached --check`. Product/Deno/SQL/typecheck suites above are not needed to validate Markdown and must not be reported as executed.

Authoring checks completed: parent quotation matches verbatim; RC-01–RC-17 each appear exactly once in the acceptance register (rechecked after RC-17, the policy-write CAS, recovery and audit gate, was added); six numbered tasks map the contract; local links and heading anchors resolve; R1/R2 timestamps have no baseline filename/document reservation collision and C1 matches the existing reservation (historical: that check was against a stale baseline; the versions are now unassigned, see the reservation table). Working-tree `git diff --check` passed. The changed-file inventory is four documents: this rollout spec and plan, and the Task 11 release-gates spec and plan. The release-gates edits (spec §5 manifest, §6 D1, §8 Q2 and the migration-gate rules; plan Tasks 1 and 6) were added during this PR's review and are authorized by it. Manual review also identified the existing SQL suites needing explicit synthetic policy setup; those fixture-only changes are listed in Task 1 rather than weakening the future full-harness gate.

Tooling disclosure: mem0 recall/save tools and the brainstorming skill were unavailable after bounded discovery. Requirements/design alternatives were reviewed directly; no named-skill pass or memory save is claimed. The graphify CLI was unavailable; read-only graph adjacency inspection supplied navigation, then actual source supplied evidence. Production/test guards have no changed production/test files to process; documentation review is manual. No graph update, production access, secret read, code edit, deployment or live provider verification occurred.

Commit only:

- `docs/specs/2026-10-30-instagram-collection-rollout-controls.md`
- `docs/plans/2026-10-30-instagram-collection-rollout-controls.md`
- `docs/specs/2026-10-30-instagram-release-gates.md`

Use `git commit -- <files>` with message `docs: specify Instagram collection rollout controls` and trailer `Co-Authored-By: Codex <noreply@openai.com>`. Report commit, contract, six tasks, R1/R2/C1, validation and open defaults. Then **STOP**. No push, PR, further implementation, production access or activation is authorized by this authoring request.
