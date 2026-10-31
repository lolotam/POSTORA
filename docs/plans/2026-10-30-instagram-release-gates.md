# Task 11: Instagram release gates and journeys implementation plan

Date: 2026-10-30. Status: documentation only; numbered work below requires a future implementation assignment. Production steps are listed for handoff and are **not authorized by this plan**.

**Goal:** produce reproducible acceptance evidence and an explicit release decision for the approved Instagram scope.

**Architecture:** real frontend→authenticated API→database paths with synthetic provider transport; separate local fixture presentation checks from assembled backend proof and separately approved live verification. Task 11 adds verification and documentation, not missing Task 2/8/9/10 features.

**Stack:** existing Playwright, Vitest/Node, Deno and disposable Supabase/Postgres harness. No new production service, migration, secret or provider access is required for Task 11 verification authoring.

**Spec:** [Instagram release gates](../specs/2026-10-30-instagram-release-gates.md). [Parent](2026-10-26-instagram-insights-and-competitor-tracking.md) owns scope, approved decisions, dependency order and milestone gates. [Task 8](2026-10-30-competitor-ui-and-retention.md) owns competitor implementation and M1–M4. [Source spec](../specs/2026-10-26-instagram-insights-and-competitor-tracking.md) owns original acceptance IDs. The spec's references and amendments take precedence over stale historical progress claims; do not duplicate them here.

**Authoring baseline:** `E:\Dev\Worktrees\postora_new\task11-docs`, `docs/task11-release-gates`, HEAD `693fb84fa334ad62614f59f2d02c84673063a625`. Inspected local `origin/main`: `aa8d21f0`. No remote fetch or deployment inspection. See spec §1 for the exact branch/main distinction and verified gaps.

Read [ARCHITECTURE.md](../../ARCHITECTURE.md) in full, especially §0, §1, §3–4, §12–17, §23–28, §31–39 and §45–46; [CLAUDE.md](../../CLAUDE.md), [AGENTS.md](../../AGENTS.md), [PROJECT_AGENT.md](../../PROJECT_AGENT.md) and any directory instructions before implementation. Consult the earlier [intake](2026-10-28-instagram-owner-intake.md), [Page reconciliation](2026-10-28-meta-page-token-reconciliation.md) and [worker](2026-10-29-instagram-owner-collection-worker.md) plans for test-contract lineage, not current deployment status.

Execute **one numbered task at a time**, freeze its evidence and review before starting the next. Do not dispatch all tasks in parallel or change another task's product files to turn a blocked test green. No delegation/model choice is authorized by this document.

## Global constraints — parent §4, quoted verbatim

1. Read `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` (§3–4, §12–17, §23–28, §31–39), `PROJECT_AGENT.md`, this plan and the source spec before changing code. Follow directory-scoped instructions.
2. Implement only the numbered task(s) assigned. Do not commit, push, merge, deploy, run production SQL, modify secrets or touch the standalone n8n node repository. The orchestrator reviews and commits scoped files.

> These constraints bind a **delegated implementer**. The orchestrating session still follows the full CLAUDE.md Task Execution Workflow (mem0 recall and save, brainstorming, guard pass, scoped local commit); nothing in this plan replaces or waives it.
3. Preserve unrelated user work and existing API behavior. No broad refactors, platform-version migration, scraping index, Facebook insights, hashtag search, Ad Library, or optional work without explicit approval.
4. Derive caller identity from verified auth. Service-role reads and writes must structurally enforce resource ownership, including denormalized user IDs and post/account links. RLS alone does not protect service-role work.
5. Null means unavailable, never zero. Failed reads/writes are failures, never empty data or successful syncs. Validate untrusted inputs/responses, sanitize client errors, redact logs, and log every refusal/early exit.
6. No token-prefix heuristics, raw tokens in frontend/contracts/logs, browser-readable new credentials, or provider URLs containing credentials in logs. Provider calls use explicit timeout, bounded retries and trusted-host cursor construction.
7. Scheduled and on-demand work uses atomic durable claims, expiring leases, checkpoints, idempotent upserts and bounded wall-clock/request budgets. No unbounded waitUntil jobs or browser-owned scheduling.
8. Keep UI → application ports/domain; infrastructure implements ports; only feature composition roots wire infrastructure. React Query hooks belong to UI, not framework-independent application modules. New modules must have real production callers.
9. Rehearse additive migrations and tenant-negative tests before release. Apply and verify prerequisites before deploying dependent functions/frontend. Enable new schedules only after functions boot and readiness is verified.

## Dependencies and file ownership

All **Create** paths below are proposed and absent at the authoring baseline. Recheck before writing: Task 8 may have delivered equivalent fixture/runbook files in the meantime. Reuse their accepted public contracts and serialize edits to `e2e/analytics.spec.ts` and CI. An existing path listed under **Modify** is not permission to rewrite its unrelated behavior. Task 8's M1–M4 migrations, report and retention functions, competitor feature, fixture and runbook are on main since #306 (`1e1fbed3`); that is source presence only, not deployment or activation. Source provenance, Task 9 and Task 10 integration, Task 6 metric/retry reconciliation, missing collection scheduling and single-account eligibility remain explicit dependency gates.

Task 11 never owns the proposed collection cron migration or new eligibility implementation. Their owners must supply reviewed artifacts, exact names and tests; the spec §5 manifest is updated before release. No wildcard or “later migration” placeholder can pass final G-X. The parent §14 owner→competitor→readiness sequencing remains mandatory for acceptance even though some code is already merged.

## Numbered implementation tasks

### 1. Freeze the acceptance inventory and build a fail-closed evidence checker

**Create (proposed):** `scripts/check-instagram-release-gates.mjs`; `scripts/check-instagram-release-gates.test.mjs`.

**Modify:** these Task 11 spec/plan files only for verified status/evidence updates. Do not edit historical acceptance records to imply new approval.

- [ ] Tests first: a complete synthetic ledger passes; a missing/duplicate source ID, missing T8 ID, unknown status, unreviewed skip, stale SHA, absent proposed file, missing artifact or falsely marked live gate fails. The checker also reads `supabase/migrations/` and fails when two migration files share a version prefix, when the rollout-control series (R1, R2, C1) is not ascending or does not sort after M4, when frozen manifest versions are not strictly ascending, or when any member's merge snapshot (the first parent of the single squash commit on the first-parent line of `--main-ref`, `origin/main` in CI, that adds its file) is not older than that member in both newest migration version and baseline marker, or differs from the evidence JSON's recorded snapshot. Named outcomes, per member: `member_stale_version` (before merge, the current main-ref tip already holds a migration or marker not older than the member; binding only when main requires up-to-date branches and this checker's status, which Task 6 records; a merge queue does not qualify), `member_not_on_main` (blocked in `--phase local`; failed in `--phase release`), `member_assignment_ambiguous` (more than one adding commit; any `R` entry whose source or destination carries a series suffix, read with `--name-status -M` and no pathspec, then filtered; or a file with the member's suffix added that is neither the member nor in its declared supersession chain), `member_superseded` (historical; the member is marked `superseded_by` a replacement, and every rule applies to the chain's terminal replacement), `main_ref_unresolved` (the ref passed as `--main-ref` does not resolve) and `assignment_commit_unreachable` (history missing). `--main-ref` is required, with no default. It never requires a member to be globally newest, and never compares it with the current baseline marker, at check time. Explicitly distinguish `existing` inventory from executed PASS and live approval.
- [ ] Reconcile all 78 IDs against original and Task 8 acceptance tables. Freeze baseline/head/tree, exact required test titles and fixture schema; keep dependency failures visible. Record D8/A6/I3 contract discrepancies for owning-task decision without adopting current behavior by default.
- [ ] Implement a read-only checker consuming the Markdown tables, an external per-run evidence JSON and the repository's git history (for the migration assignment checks). Its CI job checks out full history (`actions/checkout` with `fetch-depth: 0`); Task 6 registers it that way, and records that main's branch protection requires up-to-date branches and lists this checker's status as required (the precondition for `member_stale_version` to block a merge; a merge queue does not qualify), and passes `--main-ref origin/main`. It must not update expectations, rewrite history, access production or infer approval from elapsed time. Unit-test its parser against real table syntax and changed source-ID inventories.
- [ ] Run V1; record resolved/blocked dependencies in the ledger. Do not mark a proposed schedule/fixture existing based on another branch's report.

**Acceptance:** all source IDs + T8-01–T8-12 traceability; G-X fail-closed bookkeeping. **Dependencies:** approved Task 11 spec; existing source/Task 8 contracts. **Exit:** inventory frozen; unresolved dependencies named, not waived.

### 2. Build strict synthetic fixture infrastructure

**Create (proposed):** `e2e/fixtures/instagramRelease.ts`, `e2e/fixtures/instagramReleaseSeed.ts`, `e2e/fixtures/instagramReleaseServer.ts`, `e2e/fixtures/instagramReleaseSafety.test.ts`; `playwright.instagram-release.config.ts`.

**Modify:** `e2e/analytics.spec.ts` to consume the dedicated fixture for Instagram cases while preserving unrelated analytics coverage. Adopt Task 8's `e2e/fixtures/competitorTracking.ts` (on main since #306) through a documented adapter; no duplicate competitor truth model. The existing `e2e/fixtures/auth.ts` is reference only, not a default credentials source.

- [ ] Tests first: refuse production/public backend URLs, inherited real credentials, unexpected browser/server network, missing local services, failed login, malformed fixture data and cleanup outside the run namespace. Verify no swallowed auth error can start a journey.
- [ ] Seed the two owners/admin, direct/page accounts, trusted capability states, quotas, snapshots/coverage and clock-relative boundaries specified in spec §4. Use actual schema/catalog names. Do not inherit the obsolete O2 subplan's table names without checking the current migration.
- [ ] Use real local Auth/PostgREST/SQL and registered handler composition. Inject fake provider HTTP at the transport boundary, with strict request matching and call counts; never patch production code to secretly use fixtures. If existing composition prevents this, request a separately scoped testability seam from its owner and retain the blocker.
- [ ] Keep browser presentation stubs explicitly labeled. Assembled cases do not stub mutation/report responses. A worker collection test begins with enqueue and finishes by reading persisted data, not by seeding success.
- [ ] Dedicated config sets a controlled local test environment, starts the test server/fixture lifecycle and supplies `globalSetup`/teardown or equivalent once-only ownership. Disable reuse of an arbitrary dev server; do not load repository `.env*`. Required browser exports are reviewed against synthetic values only. Deny nonlocal egress on the backend as well as in Playwright.
- [ ] Run V1 fixture safety and V5 setup/auth/cleanup smoke. Missing dependencies are an explicit failed/blocked run, never an automatic skip.

**Acceptance:** G-E foundations for E1/E2 and J1–J10; I5/S1–S3 isolation evidence. **Dependencies:** Task 1; disposable local runtime and accepted migrations. **Exit:** deterministic fixtures, isolation and cleanup independently reviewed.

### 3. Prove the complete owner journey and collection edge cases

**Create (proposed):** none beyond Task 2 fixtures.

**Modify:** `e2e/analytics.spec.ts`; `e2e/fixtures/instagramReleaseSeed.ts`, `instagramReleaseServer.ts` (created in Task 2); existing `supabase/functions/instagram-insights-sync/{worker,workerStore,graphProvider,directGraphProvider,handler,drainHandler}.test.ts`; `supabase/functions/instagram-insights-report/{assemble,reportStore,handler,handlers}.test.ts` only for missing approved boundary assertions. Product-code fixes stay with their owning tasks.

- [ ] Tests first: E1/J1/J9/J10 fixture expectations from spec §4; A1/A3/A4/A7–A9, D9 and H1 missing bridges. Add tests that initially fail at the actual missing behavior; report RED with owner/dependency, not an implementation-complete claim.
- [ ] Prove same-user historical data survives failed reads/sync while a failed first read is not an empty state. Assert 202→queue→worker→DB→report→UI, shared 15-minute throttle, actual 190 and permission health writes, unaffected sibling progress and stale-generation refusal.
- [ ] Pin exact cadence/force boundaries, max account/media operations across the full invocation, >60 due-media continuation, >200 inventory truncation, fresh-day repair fairness, day/observed-at distinction and nullable threshold reasons. Retain tighter runtime slice budgets if approved; do not change acceptance to “whatever the worker did”.
- [ ] Run existing pure/registered-route/real-SQL suites plus new bridges. Make an isolated copied-route disconnection fail the assembled assertion without modifying source or treating a compile error as behavioral proof.
- [ ] Gate completion on accepted Task 6 metric/retry/classification reconciliation and Task 9 UI behaviors. Preserve the real version-specific direct/Page difference; synthetic payloads cannot resolve live provider support.

**Acceptance:** D8–D15, A1–A9, I3–I5, H1–H2, S1–S5, U1–U3/U6, E1, J1/J7/J9/J10. **Dependencies:** Tasks 1–2; accepted owner contract and Task 9; live evidence remains G-L pending. **Exit:** locally assembled owner proof before competitor acceptance.

### 4. Prove discovery, competitor management and retention journeys

**Create (proposed):** `supabase/functions/brand-scrape/releaseContract.test.ts` after Task 2's repaired handler contract is available. Do not preselect its internal module names.

**Modify:** `e2e/analytics.spec.ts`; Task 2 fixture files; existing `supabase/functions/competitor-snapshot-sync/{syncWorker,graphProvider,store,handler,route}.test.ts` only for cross-task gaps. Consume Task 8's `supabase/tests/{competitor_tracking_report,competitor_retention,competitor_retention_race_fixture}.sql` and report/retention suites (on main since #306 (`1e1fbed3`); they must be run, and their execution, deployment and activation remain unverified); corrections to those files remain serialized with Task 8.

- [ ] Tests first: E2/J2–J7 and T8-12 exact fixtures, including official/Apify/own/unknown across network/cache/history; denied vs failed scope reads; same handle for two owners; nullable views/likes and FEED video.
- [ ] Prove Track saved vs queued vs collected, one-row duplicate handling, quota/override/unlimited/downgrade, lost-response reconciliation, 429 Retry-After and bounded auth-sensitive polling. Test remove→retained history→reactivate with real RPCs and no blind mutation replay.
- [ ] Assert S=3-day cutoff, actual 7/30-day intervals, source-switch refusal, zero/missing/stale baseline, repeated snapshot dedup and complete/partial/unknown weekly inventory. M1's unverified ordering must not be upgraded by the report fixture accidentally.
- [ ] Run Task 8's SQL 89d/90d−1µs/90d and cleanup/reactivate/writer races in three sessions (two racers plus a `pg_stat_activity` observer): races 2 and 3 must show an observed `wait_event_type = 'Lock'` wait, and races 1 and 4 a lock *skip* (no wait, the cleanup takes the next candidate), because the cleanup uses `FOR UPDATE SKIP LOCKED`. Also cover bounded child deletion and >500 backlog. Run `prepare=1`/`cleanup=1` around each race, give race 4 its setup (only 004 and 006 eligible) and hold its session A open until session B returns, run both lock orderings and rollback/restart. UI tests alone cannot satisfy T8-08/09.
- [ ] Verify English/Arabic/RTL, keyboard/focus return, screen sizes/zoom and non-Instagram ProfileCard regression. Do not mark U4/T8-01/J2/J3 green until Task 2 producer provenance is accepted.

**Acceptance:** D1–D7, A10–A13, I1–I2/I6–I7, H3, U4–U6, E2, J2–J7, T8-01–T8-12. **Dependencies:** Task 3 owner flow; Task 2 provenance; completed Task 8 M2/M3/M4/report/UI. **Exit:** full local competitor proof; provider-ordering compatibility remains expressly qualified.

### 5. Prove UI/API/MCP report parity and authorization

**Create (proposed):** `supabase/functions/n8n-api/instagramReleaseContract.test.ts`.

**Modify:** existing `supabase/functions/n8n-api/serviceProxy.test.ts`; `supabase/functions/mcp/{toolScopes,connectionMode}.test.ts`; `e2e/analytics.spec.ts`; Task 2 local server fixture for real MCP registration and report transport.

- [ ] Tests first: J8, A14–A16, H4 and report parity using the same persisted fixture. Assert exact Instagram fields, nulls, freshness/lag code, latest media and canonical outliers through authenticated report, API and registered MCP tool. No Meta or Apify transport call is permitted during reads.
- [ ] Test 7/14/30/90 periods, stable capped pagination/dedup, microsecond cursors, invalid/foreign cursors, cross-owner/nonexistent 404 equivalence, admin-own-only where required, failed DB reads as errors and serialization without tokens/nonfinite numbers.
- [ ] Extend Facebook unsupported assertion to the exact updated supported list; preserve Threads/TikTok envelopes and posts:read. Assert deferred competitor tools have no accidental registration or scope and retain existing connection-mode handling.
- [ ] Test logged-out/auth-switch cache isolation, feature flags, default Performance, `/performance`, `?tab=analyze`, `?tab=competitors` and `/brand-intelligence` redirect without loops. Use Task 8's current navigation decision instead of reinstating the earlier parent redirect sketch.
- [ ] Run V2/V5. A mocked `deps.invoke` result proves dispatch only; missing Task 10 composition/contract delivery is a blocker, not a reason to stub away this step.

**Acceptance:** A14–A16, H4, I5, U1–U6 integration, E1/E2, J8, T8-03/T8-11/T8-12. **Dependencies:** Tasks 3–4; accepted Tasks 9/10 contracts. **Exit:** local cross-consumer evidence with zero provider reads.

### 6. Assemble migration, scheduling, runtime-caller and rollback gates

**Create (proposed):** none beyond Task 1 checker; evidence artifacts are outside tracked source.

**Modify:** `scripts/check-instagram-release-gates.mjs` and `.test.mjs`; these Task 11 documents' status/manifest references; `.github/workflows/ci.yml` only for additive mandatory test/check registration without deleting old gates.

- [ ] Tests first: reject absent migration/handler/import, changed expected hash, schedule installed active, duplicate job after reapply, wrong dispatch body, literal credential, missing production caller and type-only/test-only usage. Reject a claimed one-account pilot backed only by the OAuth user list/global collection switch.
- [ ] Consume the complete ordered migration ledger and final Task 8 M1–M4 delivery. Request missing Task 4 C1/daily enqueue and collection eligibility artifacts from their owner; do not author migrations or rollout-control production code in Task 11. Resolve proposed filenames before asserting manifest completeness.
- [ ] Generate exact runtime files/import closure with commit and SHA256. Audit shared consumers and same-change non-test callers; record route/function/RPC call-site chains, not identifier matches. Explicitly resolve the disabled paid-adapter reachability exception instead of counting its tests as shipped functionality.
- [ ] Rehearse full baseline-plus-delta SQL, catalog/types/grants, schedule reapplication/default inactivity and negative tenant checks. Test protected-compatible rollback by disabling collection/retention while retaining schema/history/authority; never assert that removing a pilot downgrades accounts.
- [ ] Run final Node/Deno/SQL/browser gates on one immutable candidate and preserve failed attempts, baseline diagnostics, unreviewed skips and environment failures. Add CI required-file checks; no fake green job, no missing-suite globs, no new no-check exemption or assertion weakening.

**Acceptance:** S6, H1/H3, I5, T8-09/T8-10/T8-12, G-X for every ID; B–E remain pending. **Dependencies:** Tasks 1–5 and scheduling/eligibility prerequisites. **Exit:** reviewable local release bundle; hosted checks pending until separately authorized/run on the exact revision.

### 7. Write the Arabic journeys and release runbook from actual evidence

**Create (proposed):** `docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md`; `docs/runbooks/instagram-insights-release.md`.

**Modify:** this plan's future validation log and the spec matrix statuses only when evidence warrants. Link to Task 8's `docs/runbooks/competitor-tracking-retention.md` (on main since #306) and its journey doc; do not duplicate their retention contract.

- [ ] Validation first: require all E/J IDs, proof links/commands/SHAs, user-visible outcome, fixture-vs-live label and remaining limitations. Verify local links and flag unsupported claims such as “deployed”, “all permissions granted”, “tonight” or “complete history” without their gate evidence.
- [ ] Write the Arabic journey report for a nontechnical reader: how to reach each feature, expected success/empty/error/reconnect/limit states, what source/null/partial/freshness mean, removal/reactivation behavior, and what has actually been verified. No source code or secret details in the user steps. This is not produced during the current authoring task.
- [ ] Write the feature release runbook using spec §5/6 manifest and B–E approvals, linking the operational deployment procedure. Include exact applied-vs-pending migration evidence, hashes, cron states, rollback controls, single-account blocker disposition, observation checklist and next owner.
- [ ] Run docs guard or disclose the applicable approved manual equivalent. Evidence that exists only outside the repo must have a stable retained artifact reference and redacted summary; do not invent accessible CI links or copy sensitive logs.

**Acceptance:** E1/E2, J1–J10, T8-12 documentation; G-X decision log and B–E checklist. **Dependencies:** Tasks 1–6. **Exit:** documented local readiness with each live/hosted gap still pending.

### 8. Final review, scoped handoff and stop

**Create (proposed):** none.

**Modify:** this plan's evidence ledger and spec statuses only to incorporate final verified results/review findings; implementation corrections return to the numbered owning task.

- [ ] Validation first: rerun the checker against the final immutable candidate; prove that a missing required artifact or unapproved live checkbox prevents release-ready status.
- [ ] Run named production/test/docs guards on their actual changed scopes and obtain independent final review. Retain explicit waivers where permitted by current authorization; tool absence alone never passes a guard. Verify no open material ownership/credentials/integrity/correctness finding or unreviewed skip.
- [ ] Record local candidate SHA/tree and commands/results; compare hosted checks only if separately authorized and actually run on that same revision. A historical green run is not current evidence.
- [ ] Future authorized orchestrator commits only reviewed task files. Report complete/incomplete IDs, exact manifest, pending dependencies, live gates, approvals and operational follow-up. No push, PR, merge, deploy or production operation is authorized merely by completing this list.

**Acceptance:** all 78 trace rows accounted for; G-X complete or explicit blockers. **Dependencies:** Tasks 1–7. **Exit:** STOP at release handoff; production B–E actions require Waleed's individual approvals.

## Validation commands and evidence policy

These commands are **future implementation gates**, not commands run by the document author. Run from the assigned implementation worktree on an immutable candidate. No `.env*`/production credentials or production backend may be used. Deno import caching/package installation may require normal dependency downloads; the tests themselves must prohibit live provider calls.

### V1 — checker and fixture tests

```powershell
node --test scripts/check-instagram-release-gates.test.mjs
npm test -- e2e/fixtures/instagramReleaseSafety.test.ts
node scripts/check-instagram-release-gates.mjs --spec docs/specs/2026-10-30-instagram-release-gates.md --evidence <absolute-local-redacted-evidence.json> --phase local --main-ref origin/main
```

The checker CLI above is a **proposed interface** implemented in Task 1. `--phase local` still reports unresolved product dependencies; it does not satisfy `--phase release` (proposed), which additionally requires exact-revision hosted evidence and B–E approval records. Do not run the placeholder literally or create an empty evidence file to get green. New Vitest fixture tests must be in the verified discovery inventory; if the current config excludes `e2e/`, register them explicitly or relocate with an updated file list, never silently run zero tests.

### V2 — Deno and maintained compatibility suites

Use Bash (Git Bash/WSL/Linux) for glob/brace expansion. Freeze every matched test path in the evidence and CI required inventory. Do not use an unexpanded PowerShell glob or `--no-check` to bypass a failure. The report/retention directories are on main since #306 (`1e1fbed3`); they must be run, and their execution, deployment and activation remain unverified.

```bash
deno check --node-modules-dir=none supabase/functions/instagram-insights-sync/*.ts
deno check --node-modules-dir=none supabase/functions/instagram-insights-report/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-snapshot-sync/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-tracking-report/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-retention/*.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/instagram-insights-sync/{worker,workerStore,graphProvider,directGraphProvider,workerTermination,handler,store}.test.ts \
  supabase/functions/competitor-snapshot-sync/{syncWorker,graphProvider,apifyProvider,store,handler,sqlContract}.test.ts
deno test --node-modules-dir=none --allow-read --allow-write --allow-env --allow-run \
  supabase/functions/instagram-insights-sync/{handlers,drainHandler}.test.ts \
  supabase/functions/competitor-snapshot-sync/route.test.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/instagram-insights-report/*.test.ts \
  supabase/functions/_shared/outlierScore.test.ts \
  supabase/functions/mcp/{toolScopes,connectionMode}.test.ts
```

Run the existing required protected OAuth/refresh and historical proxy/MCP inventories exactly as registered in `.github/workflows/ci.yml`, plus Task 8 plan V2 report/retention commands (its suites are on main since #306) and the proposed discovery/parity suites. Preserve existing command-specific compatibility exemptions without extending them. New local SQL/HTTP integration commands may grant `--allow-net` only to explicitly enumerated disposable localhost endpoints; never blanket provider/network permission. Record runtime allowlists and fixture entrypoints with the final command. All environment permissions are in a clean synthetic environment. A permission/compile/environment failure is reported as such, not as a tested negative behavior.

### V3 — full disposable SQL and real races

Follow [supabase/tests/README.md](../../supabase/tests/README.md) and the complete `scripts/db-harness.sh` inventory. Example in Bash; the password below is intentionally synthetic and the container has no network or host port:

```bash
docker run -d --name postora-task11-sql --network none \
  -e POSTGRES_PASSWORD=postgres -v "$PWD:/repo:ro" \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=instagram_release_harness \
  -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault
# Wait for a healthy database (at most 120 s); stop on unhealthy or timeout.
for _ in $(seq 1 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' postora-task11-sql)
  [ "$status" = healthy ] && break
  [ "$status" = unhealthy ] && { docker logs postora-task11-sql; exit 1; }
  sleep 2
done
[ "$status" = healthy ] || { echo "postora-task11-sql not healthy after 120 s"; docker logs postora-task11-sql; exit 1; }
docker exec -e HARNESS_DB_NAME=instagram_release_harness postora-task11-sql \
  bash -c "cd /repo && bash scripts/db-harness.sh 'postgres://supabase_admin:postgres@localhost:5432/postgres'"
```

This SQL-only harness is separate from Task 2's loopback local Auth/PostgREST assembled stack. Restore the baseline plus newer migrations, not every historical migration from scratch. Run all accepted suites without exclusions. Verify catalog/type alignment and nonliteral cron-secret lookup. Reapply only the new schedule definitions in the disposable database for S6; do not replay the whole production migration ledger twice.

Manually rehearse the applicable existing credential/quota/job race fixtures and Task 8's retention race fixture in **independent psql sessions**: two for each credential/quota/job fixture, and **three** for the retention fixture (two racers plus the observer that reads `pg_stat_activity` while a racer is blocked, per `supabase/tests/README.md`), using each header's setup/interleavings/assertions/cleanup and `-v disposable=1`. Define and call the observer's `pg_temp.crt_probe()` inside the interactive observer session itself: a temporary function is session-local, so a separate `psql -c` cannot see it. For the retention fixture, run `prepare=1` before and `cleanup=1` after **each** numbered race, because race 1's batch of 10 would otherwise delete the rows later races need. Races 2 and 3 must show an observed `wait_event_type = 'Lock'` wait and races 1 and 4 a lock skip (`FOR UPDATE SKIP LOCKED`). Race 4 needs its own setup: after `prepare=1`, use the fixture's reactivation step on parents 001, 002, 003 and 005, so only 004 and 006 are eligible; the cleanup takes candidates in `(removed_at, id)` order, and without this it would take 001 and 002 and the fixture's race 4 assertions (004/006 deleted, a third call with `parents_deleted = 0`) would fail on correct behaviour. Race 4 must also be interleaved deterministically: session A runs its cleanup inside an open transaction and does **not** commit until session B's cleanup has returned, so B meets A's locked candidate; two quick sequential runs do not prove the skip; for the other fixtures, capture the lock waits their headers name. Record both outcomes and cleanup. A single-session fixture setup or green main harness is not race proof. Remove only the verified task-owned container after evidence collection.

### V4 — frontend and regression gates

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run check:i18n
npm test -- src/features/instagram-insights
npm test -- src/features/competitor-tracking
git diff --check
```

The competitor path is on main since #306 (`1e1fbed3`); it is not deployed or active until its own gates pass. Inspect test counts; no-tests-found is not success. Record full exit codes and known baseline failures. Where approved repository policy uses `scripts/lint-i18n-regression.mjs`, follow its current documented immutable-base/head/proposed-merge invocation and retain reports rather than inventing flags. No moving baseline, missing-suite omission, timeout relaxation or new suppression.

### V5 — strict seeded browser and assembled journeys

```powershell
npx playwright test e2e/analytics.spec.ts --config=playwright.instagram-release.config.ts --project=chromium
```

The config is **proposed** in Task 2. It must own local runtime startup/readiness, synthetic environment and fixture cleanup; this command cannot rely on existing `playwright.config.ts` starting an uncontrolled Vite server. Run E1/E2/J1–J10 against exact fixtures in both local evidence lanes; record which lane proves which assertion. Preserve traces/screenshots on failure, check redaction before retention, and capture required viewport/RTL/keyboard/zoom cases. No live Meta/Apify/AI calls, real user login or production state is needed.

### V6 — architecture, guards and final inventory

```powershell
graphify update .
git diff --stat
git diff --check
```

Graph update applies after implementation code changes, not this two-document task. Review graph artifacts separately. A graph edge is supporting evidence; spec §7 requires an actual runtime call chain. Run named guards and independent review, record tool absence/waivers truthfully, and execute V1 against the final candidate after any correction. Reuse passing immutable evidence only when relevant bytes/environment remain unchanged.

## Production handoff — listed, explicitly not authorized

The exact procedure/checklists are in [spec §5–6](../specs/2026-10-30-instagram-release-gates.md#5-deployment-manifest-and-rollback-contract) and the existing deployment runbook. Future actions proceed: approved manifest/schema preflight and manual missing migrations → immutable function/shared deployment and boot → pilot user list → approved reconnect → login/refresh/approved posting checks → reviewed single-account collection prerequisite and pilot → competitor pilot → approved all-eligible collection/schedules → retention dry run and separately approved deletion → observation/acceptance. **Waleed must approve each B–E action against its preceding evidence.** None is executed by authoring or implementing Task 11 tests/docs.

Do not treat main's existing merges, automatic frontend deploy or edge reconciler as migration/activation evidence. Do not push/merge dependent runtime before schema readiness. The proposed collection-cron migration (C1 in the spec's migration table, not the C1 reconnect gate) and the per-account eligibility dependency are not permission to change production or switch the global credential mode. Rollback preserves protected authority and retained history as specified; it never restores exposed tokens.

## Open questions for Waleed

Use the single question register in [spec §8](../specs/2026-10-30-instagram-release-gates.md#8-open-questions-for-waleed): pilot identity/order, one-account eligibility prerequisite, cadence/observation window, metric/retry reconciliation and approval of exact canary post. Each has a recommended default. No approval is inferred from this document, and already approved limits/S/deferred scope are not reopened.

## Authoring validation record and stop boundary

This delivery creates only the two requested Markdown documents. Coverage inventory: **78 unique IDs = 22 existing + 9 to-be-written + 47 blocked-on-dependency**. This is not a test-run count or an operational readiness percentage.

Required documentation checks: compare all source/T8 IDs to the matrix; verify status totals/uniqueness; compare the parent §4 quotation verbatim; validate local links, existing filenames/line citations and proposed labels; verify migration order and branch/main membership; review authorization boundaries and secrets; run `git diff --check`. No product tests, migrations or live probes are required or claimed for Markdown authoring.

Authoring results: all 78 expected IDs are present exactly once with the recorded counts; the parent quotation matches; local links and qualified file/line targets resolve; all 16 migration entries are ordered, with the first 11 verified in inspected main, M1 present on this branch and M2–M4/C1 absent/proposed. That record is historical: M1–M4 have since reached main with #306, and C1's reserved `20261030140000` turned out to be taken on main, so C1 is now unassigned (spec §5). Recursive local-import inspection found 50 shared modules and no unresolved local imports in the inspected runtime set. Manual source/authorization/proposed-path review completed. `git diff --check` and `git diff --cached --check` passed; staged scope is exactly the two requested documents. An initial validation script failed to match a Unicode heading through the shell encoding; the corrected UTF-8 run passed without changing the requirements. These are documentation checks, not application or live-provider test results.

This is an authoring record only. It instructs no reader to commit, push, merge, deploy or stop; those steps follow the repository workflow and Waleed's approvals.
