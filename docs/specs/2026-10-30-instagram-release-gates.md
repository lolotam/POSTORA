# Task 11 spec: Instagram release gates and journeys

Date: 2026-10-30. Status: documentation only; implementation and production approval pending.

**Outcome:** an evidence-backed release handoff covering every approved acceptance ID, deterministic local journeys, and separately approved production activation. A passing component test, merged file, or HTTP 200 is not a completed journey or live Meta acceptance.

**Evidence baseline:** worktree `E:\Dev\Worktrees\postora_new\task11-docs`, branch `docs/task11-release-gates`, starting HEAD `693fb84fa334ad62614f59f2d02c84673063a625`. The inspected local `origin/main` is `aa8d21f0`; no fetch or production inspection was performed. All existing-code citations below were inspected at the starting HEAD. **Proposed** means absent there, including work reportedly in progress elsewhere.

Read with the [implementation plan](../plans/2026-10-30-instagram-release-gates.md), [parent plan](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md) §4, Tasks 8–11, §7–9, §12–14 and progress record, [source acceptance contract](2026-10-26-instagram-insights-and-competitor-tracking.md) §8–9, and [Task 8 spec](2026-10-30-competitor-ui-and-retention.md) / [plan](../plans/2026-10-30-competitor-ui-and-retention.md). Document ownership is defined by [ARCHITECTURE.md §0](../../ARCHITECTURE.md); architecture and lifecycle rules remain there and in [CLAUDE.md](../../CLAUDE.md), not redefined here. Parent §4 is quoted verbatim in this task's plan as requested.

## 1. Scope, evidence and dependencies

Task 11 owns assembled verification and the release evidence record. It does not implement the missing Task 2/8/9/10 product behavior, change approved limits, or authorize production operations. The Arabic journey document is a **future implementation deliverable**, not part of this two-file authoring task. Stories, optional competitor MCP tools and scheduled Apify remain deferred under parent §13; no skipped test may silently reintroduce or erase that decision.

| Observed evidence | Release consequence |
|---|---|
| `git log --oneline origin/main -40` includes `7f354eae` (#294) and `b89fd08d` (#298). `git log --oneline -15` includes those plus Task 8 documentation, M1 `9d04f976`, and S decision `693fb84f`. | Old parent/subplan statements that #294 is still draft or owner code does not exist are historical. Merge evidence does not prove deployment, activation, or full acceptance. |
| `git log origin/main..HEAD` has `ba540574`, `9d04f976`, `693fb84f`; `git log HEAD..origin/main` has `aa8d21f0`. | Task 8 M1 is committed on this branch, not on the inspected main. Do not import unrelated main changes or another worktree's M2/M3 work into this task. |
| `supabase/functions/instagram-insights-sync/`, `instagram-insights-report/`, `competitor-snapshot-sync/`, and `src/features/instagram-insights/` exist. | Tasks 6/7 and portions of 9/10 have code. Their existence does not close the remaining integration requirements. |
| `supabase/functions/brand-scrape/index.ts:545`, `:687`, `:696`, `:716`; `_shared/instagramDiscoveryViewer.ts:53`. | Interactive selection still reads metadata scopes; strategy is stored in sessions without an end-to-end response/cache provenance contract. Task 2 is an explicit blocker. |
| `supabase/functions/n8n-api/serviceProxy.ts:251`; `serviceProxy.test.ts` test “instagram analytics reads the account's report”. | Instagram proxy dispatch exists. The mocked invoke assertion is not UI/API/MCP parity, pagination, real SQL, or no-provider proof: Task 10 remains a dependency. |
| `src/features/instagram-insights/ui/__tests__/InstagramPerformanceScreen.test.tsx:189`, `:203`, `:241`. | Basic owner rendering and Sync now tests exist; complete type-filter, auth-switch, failure/polling/navigation and translated state coverage is still required from Task 9. |
| `e2e/analytics.spec.ts`; `e2e/fixtures/auth.ts`. | Current generic analytics tests include boolean-type/count>=0 assertions and login failure continuation. They cannot satisfy E1/E2 or J1–J10. Use a dedicated fail-closed local fixture. |
| `supabase/migrations/20261030100000_competitor_capture_coverage.sql`; `supabase/tests/competitor_capture_coverage.sql`; `competitor-snapshot-sync/syncWorker.test.ts:813`. | M1 stores versioned coverage and has production-path coverage assertions. It does not provide M2 reports, M3 retention, M4 cron, or evidence of verified provider ordering. |
| `_shared/protectedAccountCutover.ts:39`, `:149`; `instagram-insights-sync/handler.ts:232`, `:720`; `competitor-snapshot-sync/handler.ts:691`. | The pilot list starts protected OAuth; existing protected accounts remain protected independently. Both collection endpoints still require global protected mode; owner drain has no target argument. Single-account production collection is blocked pending an explicitly reviewed prerequisite. |
| No Instagram/competitor collection `cron.schedule` definition exists in the inspected migration inventory. | Daily enqueue/drain schedules are proposed, not installed or verified inactive in production. Owner daily enqueue dispatch also needs a reviewed implementation contract. |

S = three days is already resolved by [Task 8 spec §11](2026-10-30-competitor-ui-and-retention.md#11-open-questions-for-waleed); stale wording in the sibling plan's final questions does not reopen it. Earlier [owner intake](../plans/2026-10-28-instagram-owner-intake.md), [Page reconciliation](../plans/2026-10-28-meta-page-token-reconciliation.md), and [owner worker](../plans/2026-10-29-instagram-owner-collection-worker.md) records provide historical evidence, not current deployment claims.

## 2. Evidence vocabulary and gate register

Each matrix row has exactly one inventory status:

- **existing:** an inspected maintained test exercises the stated approved behavior. It has **not been rerun by this document task**; final-revision execution is required.
- **to-be-written:** the required Task 11 assertion/bridge is absent or incomplete. Existing nearby tests are supporting evidence only.
- **blocked-on-dependency:** full proof depends on unfinished product work or live evidence. Name that dependency; do not pass it with a mocked success or `test.skip`.

Statuses are coverage inventory, not test outcomes. Keep separate fields in the future evidence ledger for candidate SHA/tree, test title, command/version, exit, artifact, environment, reviewer, blocker and approval. A blocked journey can have useful component tests without being counted twice.

| Gate | Proof and inspected anchors |
|---|---|
| G-D discovery | Task 2 producer→cache/history→hook→card, verified scope provenance, bounded cursor and nullable mapping. Existing `_shared/instagramDiscoveryViewer.test.ts` covers legacy selection only; proposed `supabase/functions/brand-scrape/releaseContract.test.ts` must prove the repaired real handler. |
| G-O owner collection | Existing `instagram-insights-sync/{worker,workerStore,graphProvider,directGraphProvider,workerTermination}.test.ts`; add missing cases in those suites. Real production adapter→SQL and registered route→worker→SQL bridges are proposed in `e2e/fixtures/instagramReleaseServer.ts`. |
| G-C competitor collection | Existing `competitor-snapshot-sync/{syncWorker,graphProvider,apifyProvider,store,sqlContract,handler,route}.test.ts` and `supabase/tests/{competitor_collection_results,competitor_capture_coverage}.sql`. Task 8 report/retention proofs follow its own plan. |
| G-R report and API | Existing `instagram-insights-report/{assemble,reportStore,handler,handlers}.test.ts`, `n8n-api/serviceProxy.test.ts`, `mcp/toolScopes.test.ts`, `mcp/connectionMode.test.ts`. Proposed `supabase/functions/n8n-api/instagramReleaseContract.test.ts` exercises the shared report through actual proxy/MCP composition and local SQL. |
| G-S SQL/security | Existing `supabase/tests/{instagram_capabilities,instagram_tracking_schema,instagram_durable_collection_jobs,facebook_user_credential_bindings,meta_oauth_attempt_lifecycle,meta_account_refresh_lifecycle,meta_oauth_identity_alias,meta_page_token_reconciliation,instagram_direct_collection_credential}.sql`; `supabase/tests/{competitor_tracking_report,competitor_retention,competitor_retention_cron}.sql` (Task 8, on main since #306 (`1e1fbed3`); they must be run, and their execution, deployment and activation remain unverified); manual race fixtures listed in `supabase/tests/README.md`, including Task 8's `competitor_retention_race_fixture.sql`. Run the entire harness, not just this subset. |
| G-U UI | Existing owner `ui/__tests__/InstagramPerformanceScreen.test.tsx`, `domain/formatters.test.ts`, `tests/architecture.test.ts` under `src/features/instagram-insights/`. Task 8's competitor suites (`src/features/competitor-tracking/`, on main since #306) and Task 9 expanded owner suites own their UI behavior. |
| G-E journeys | Proposed strict `e2e/analytics.spec.ts` Instagram cases and `e2e/fixtures/instagramRelease.ts`, `instagramReleaseSeed.ts`, `instagramReleaseServer.ts`; use §4. Task 8's `e2e/fixtures/competitorTracking.ts` (on main since #306) is reused, not independently duplicated. |
| G-X assembled release | Proposed `scripts/check-instagram-release-gates.mjs` and adjacent `.test.mjs`: traceability, exact manifest, required artifacts, no unresolved skips, actual runtime caller evidence and fail-closed missing prerequisites. Manual architecture/guard review remains required. |
| G-L live | Separately authorized B–E checklists (§6), configured-version Meta compatibility, real account observations and deployed hashes. No local fixture can satisfy G-L. |

## 3. Acceptance traceability matrix

These are references to source requirements, not replacement definitions. Parent binding amendments govern D3 (trusted permission provenance), D9 (normal vs forced generation), D10 (protected capability/credential transport, no metadata fallback), S4 (RPC-controlled soft removal), H1 (accepted enqueue/status/drain shapes), and A12 (isolated adapter capability; scheduled paid path stays disabled). J1's “tonight” and J5's immediate growth wording must follow truthful queue/coverage behavior in Task 8 and the parent plan. Do not convert discrepancies into unapproved acceptance changes.

### Domain

| ID | Status | Proving test/gate and remaining obligation |
|---|---|---|
| D1 | blocked-on-dependency | G-D; Task 2: page-linked business candidate from trusted capability, not metadata-only legacy test. |
| D2 | blocked-on-dependency | G-D; Task 2: direct login excluded by trusted kind; existing legacy selector test is partial proof. |
| D3 | blocked-on-dependency | G-D; Task 2: successful empty permissions denied; failed/legacy scopes unknown, never trusted. |
| D4 | blocked-on-dependency | G-D; Task 2: inactive/reauth exclusion and deterministic newest/ID tie after capability repair. |
| D5 | blocked-on-dependency | G-D; Task 2: real interactive mapping REELS/view_count, through cache and history. |
| D6 | blocked-on-dependency | G-D; Task 2: hidden likes remain null in all numeric consumers/exports. |
| D7 | blocked-on-dependency | G-D; Task 2: FEED VIDEO remains VIDEO through interactive path. |
| D8 | blocked-on-dependency | G-O + G-L; Task 6/provider contract: exact approved product lists and unknown/AD behavior need reconciliation. Current graph tests intentionally use a universal unknown-product set; direct classification is not a proved Reel/Feed surface. |
| D9 | to-be-written | G-O + G-S: pin 7/8/30/31/90/91-day cadence, ordinary continuation skip and accepted force recollection with stale-worker refusal. |
| D10 | existing | G-O `worker.test.ts` page/direct transport cases; `workerStore.test.ts` trusted capability and protected credential tests; `directGraphProvider.test.ts` host tests. Approved protected replacement of metadata fallback only. G-L still required. |
| D11 | existing | G-R `_shared/outlierScore.test.ts` self exclusion; report assembler canonical-caller test. |
| D12 | existing | G-R `_shared/outlierScore.test.ts` format separation; assembler source/metric cohort tests. |
| D13 | existing | G-R `_shared/outlierScore.test.ts` 48-hour equality, null precedence, fewer-than-six and zero median. |
| D14 | existing | G-R `_shared/outlierScore.test.ts` inclusive 3/1.5/0.5 boundary test. |
| D15 | existing | G-R `assemble.test.ts` zero reach, missing numerator, unavailable media and percent-basis assertions. |

### Application

| ID | Status | Proving test/gate and remaining obligation |
|---|---|---|
| A1 | to-be-written | G-O/G-S: bridge two media plus daily metrics through real worker writes to report; assert completion only after durable writes. |
| A2 | existing | G-O `graphProvider.test.ts` empty account day and missing media value tests; unavailable remains null. |
| A3 | to-be-written | G-O/G-S/J9: actual 190→fenced account health transition plus another account advancing; classifier-only evidence is insufficient. |
| A4 | to-be-written | G-O/G-S/J9: permission refusal→scope_missing without needs_reauth; distinguish code 10 insufficient-viewer data. |
| A5 | existing | G-O `worker.test.ts` nearly-spent budget and durable shared throttle tests; `graphProvider.test.ts` both usage headers. |
| A6 | blocked-on-dependency | G-O; Task 6/provider contract: current test explicitly says media insight calls are never retried automatically. Need approved targeted unsupported-metric behavior and positive test, or explicit amendment; do not mark the opposite test green for A6. |
| A7 | to-be-written | G-O: existing 25-claim and five-media-per-visit tests support tighter slices; aggregate invocation proof must enforce <=60 media/account with >60 due and fair continuation. |
| A8 | to-be-written | G-S/G-O: real platform-post linkage for same owner/account/media; foreign and unpublished media remain unlinked/rejected. |
| A9 | to-be-written | G-S/G-O: repeat a real worker day, compare row identities/counts and values; force supersession and durable completion, not only fake upsert calls. |
| A10 | existing | G-C `syncWorker.test.ts` named A10 official capture test. |
| A11 | existing | G-C `syncWorker.test.ts` named A11 no viewer/paid-off test, no provider call. |
| A12 | existing | G-C `syncWorker.test.ts` named A12 injected paid-on case. Approved scope: adapter-only evidence; `index.ts` injects disabled paid policy. G-X must assert scheduled fallback remains unreachable. |
| A13 | existing | G-C `syncWorker.test.ts` named A13 and `supabase/tests/competitor_collection_results.sql` weekly retry rules; viewer/network failures are not target-unavailable. |
| A14 | blocked-on-dependency | G-R; Task 10: existing dispatch/assembler tests do not prove real database-only API/MCP report parity, outliers and pagination. |
| A15 | blocked-on-dependency | G-R; Task 10: assembled API/MCP cross-owner and nonexistent target return indistinguishable 404, with no provider calls. |
| A16 | to-be-written | G-R: extend existing Facebook unsupported proxy test to assert exact supported-platform list; retain Threads/TikTok responses. |

### Infrastructure, handlers and database

| ID | Status | Proving test/gate and remaining obligation |
|---|---|---|
| I1 | blocked-on-dependency | G-D; Task 2: inspect actual interactive request fields, not the competitor worker alone. |
| I2 | blocked-on-dependency | G-D; Task 2: interactive cursor, cap, repeated cursor and trusted-host tests. |
| I3 | blocked-on-dependency | G-O/G-L; Task 6 metric/classification reconciliation and live configured-version verification; host unit tests already exist. |
| I4 | existing | G-O `graphProvider.test.ts` timeout/abort and at-most-two server retries; no claim every request retries. |
| I5 | existing | G-O `worker.test.ts` “no token reaches a log line, a summary or an error”; provider failure text tests. G-X extends redaction checks to all release artifacts. |
| I6 | blocked-on-dependency | G-D; Task 2 repaired actual brand-scrape handler with only facebook_business account; G-L later confirms usable live grant. |
| I7 | blocked-on-dependency | G-D; Task 2 typed IG_INSIGHTS_SCOPE_MISSING and allowed interactive fallback warning/source. |
| H1 | to-be-written | G-O/G-X: existing intake/actual-route/drain tests cover current auth; daily enqueue contract is missing. Test cron, admin, service and JWT against final supported actions, rejecting spoofed owner/target. |
| H2 | existing | G-S `instagram_durable_collection_jobs.sql` shared accepted-request throttle and G-O handler/store throttle projection tests. Rerun two-session fixture separately. |
| H3 | existing | G-C `handler.test.ts` and `route.test.ts` owner entry/force/status vs privileged enqueue-daily/all auth matrix. |
| H4 | existing | G-R `mcp/toolScopes.test.ts` every registered tool has/checks scope; unknown-tool fail closed. No optional competitor registrations. |
| S1 | existing | G-S `instagram_tracking_schema.sql` owner SELECT on actual five-table schema; M1 coverage test extends new table. |
| S2 | existing | G-S same suite cross-user SELECT denial plus composite ownership; report bridges must retain isolation. |
| S3 | existing | G-S same suite browser snapshot-write denial and service ownership constraints. |
| S4 | existing | G-S same suite quota and approved RPC soft-remove/reactivate behavior; real concurrent quota fixture required. Hard delete is not approved. Retention races tracked separately below. |
| S5 | existing | G-S same suite snapshot natural-key uniqueness; G-O repeat-worker evidence remains A9. |
| S6 | blocked-on-dependency | G-S/G-X: C1's four inactive collection schedules (collection rollout controls plan Task 5, RC-12), with Task 4's daily dispatch as their prerequisite, and Task 8 M4. Run definitions twice; one job per name, active=false, no secret literals or unrelated job changes. |

### UI and assembled journeys

| ID | Status | Proving test/gate and remaining obligation |
|---|---|---|
| U1 | blocked-on-dependency | G-U/G-E; Task 9: existing table render test needs real type-filter behavior and exact fixture values. |
| U2 | blocked-on-dependency | G-U/G-E; Task 9: connected account with no snapshots, actionable Sync now; never promise a disabled nightly schedule. |
| U3 | blocked-on-dependency | G-U/G-E; Task 9: scope_missing vs reauth banners and preserved history. |
| U4 | blocked-on-dependency | G-D/G-U; Task 2 provenance + Task 8 card wiring. A hand-supplied source prop cannot close this. |
| U5 | blocked-on-dependency | G-U/G-E; Task 8 management and quotas, backed by real local RPCs. |
| U6 | blocked-on-dependency | G-U/G-E; Task 8 + Task 9: neutral labels in both actual screens, not only formatter functions. |
| E1 | blocked-on-dependency | G-E §4 E1; Task 9 complete route/UI and Task 10 accepted read contract. |
| E2 | blocked-on-dependency | G-E §4 E2; Task 8 M2/report/UI, growth and route delivery. |
| J1 | blocked-on-dependency | G-E §4 J1; Task 9 + collection contract reconciliation; G-L direct-login acceptance remains separate. |
| J2 | blocked-on-dependency | G-E §4 J2; Task 2 provenance/reconnect and Task 8 badge; live Meta Gate C separately. |
| J3 | blocked-on-dependency | G-E §4 J3; Task 2 interactive official lookup and Task 8 source integration; live Meta separately. |
| J4 | blocked-on-dependency | G-E §4 J4; Task 2 target-vs-viewer classification and interactive admin fallback policy. |
| J5 | blocked-on-dependency | G-E §4 J5; Task 8 saved→queued→collected and honest baseline states. |
| J6 | blocked-on-dependency | G-E §4 J6; Task 8 management UX backed by existing quota arbiter. |
| J7 | blocked-on-dependency | G-E §4 J7; Task 8 + Task 9 real screens; canonical outlier unit evidence already exists. |
| J8 | blocked-on-dependency | G-R/G-E §4 J8; Task 10 actual MCP composition/read parity; do not invoke a live AI client/provider. |
| J9 | blocked-on-dependency | G-O/G-E §4 J9; Task 9 reconnect UX plus full health/write bridge; live revocation testing needs separate consent. |
| J10 | blocked-on-dependency | G-O/G-E §4 J10; Task 9 reason display and Task 6/live Meta evidence distinguishing threshold from generic unavailable. |

### Task 8 integration IDs

| ID | Status | Proving test/gate and remaining obligation |
|---|---|---|
| T8-01 | blocked-on-dependency | G-D/G-U; Task 2 source contract + Task 8 producer/hook/card/history proof. |
| T8-02 | blocked-on-dependency | G-S/G-U/G-E J5/J6; Task 8 management/lost-response/quotas/downgrade suite. |
| T8-03 | blocked-on-dependency | G-R/G-S; Task 8 M2/report: real auth-scoped list/detail, cursor precision, malformed/error refusal, no provider. |
| T8-04 | blocked-on-dependency | G-R/G-E E2; Task 8 growth with approved S=3 days, missing/zero/source-change/negative and actual interval. |
| T8-05 | blocked-on-dependency | G-C/G-R; M1 tests exist, but Task 8 report-level complete/partial/unknown semantics and provider ordering proof remain. Live ordering absence must retain unknown. |
| T8-06 | blocked-on-dependency | G-R/G-U J7; Task 8 competitor assembler actually calls canonical outlier with correct cohorts and period-independent history. |
| T8-07 | blocked-on-dependency | G-U/G-E; Task 8 queued≠collected, Retry-After, lost enqueue, bounded polling, terminal/auth-change stop and retained history. |
| T8-08 | blocked-on-dependency | G-S; Task 8 M3: 89d/90d−1µs/90d, all children/jobs, repeated removal and reactivation semantics. |
| T8-09 | blocked-on-dependency | G-S; Task 8 M3 real three-session (two racers plus an observer) cleanup/reactivation/collection races, >500-child backlog, rollback and restart. |
| T8-10 | blocked-on-dependency | G-S/G-X; Task 8 M4 inactive idempotent schedule, dry-run/no-work/refusal logging and switch-off behavior. |
| T8-11 | blocked-on-dependency | G-U/G-E; Task 8 English/Arabic/RTL/keyboard/mobile/zoom, identity isolation and non-Instagram card regressions. |
| T8-12 | blocked-on-dependency | G-E/G-X; Task 8 assembled route + Task 11 lifecycle, future Arabic journey and release evidence. |

Counted once per row: **78 IDs total** (66 source + 12 Task 8). Counts are recorded and mechanically checked in the implementation plan's authoring validation record. No ID is excluded because an old source table has a checkmark. Existing coverage still requires current execution; all release rows additionally require G-X and applicable G-L approval.

## 4. Seeded E2E design and journey assertions

Use two clearly labeled local lanes. **Presentation lane:** intercept local service responses for exhaustive UI states; it proves rendering only. **Assembled lane:** disposable local Auth/PostgREST/Postgres, real frontend adapters and registered handlers, real queue/result/report SQL, provider HTTP replaced at the transport boundary. Never intercept report responses and call that an assembled test. Mock only outbound Meta/Apify responses, not internal ownership, quota, worker, report or mutation rules. Exercise the actual MCP registration with a local client in J8.

The proposed fixtures must create synthetic owner A, owner B and admin sessions; distinct direct/page-linked accounts plus a healthy sibling; two owners sharing a competitor handle; missing/denied/granted capabilities; quotas at/below/above entitlement and explicit overrides. Generate synthetic credentials solely for local Auth/provider seams. Never read `.env*`, real account credentials, production storage state or `TEST_USER_*` defaults. Local endpoint allowlisting must reject public/production URLs at startup, abort every unexpected external request in browser **and server**, disable cron in the disposable stack, and fail if seeding/login/backend boot fails. Mocked images are local assets. No network fallback and no silent catch/skip.

Use a per-run namespace and isolated database/session state; serialise destructive/race cases. A shared reference instant drives browser and injected worker/provider clocks; SQL fixtures derive dates from the captured database instant without replacing SQL's clock authority. Include Kuwait midnight, leap/month boundaries, microsecond cursor ties, 48-hour maturity, cadence boundaries, and 89/90-day retention offsets. Cleanup must verify only the run's synthetic rows/resources. Never delete by an unscoped production-like owner/handle filter.

Fixture truth: latest followers 120, valid 7-day baseline 100 and 30-day baseline 80 give +20/+20% and +40/+50%, with exact observed intervals and S window. Additional entries cover zero/null/stale/source-switch/negative baselines. Seed distinct media, repeated daily captures, six/twelve mature predecessors, null/zero metrics, exact outlier thresholds, partial inventory and historical v1 captures without coverage. Coverage marked verified in a synthetic fixture proves downstream logic only; it is not live provider-ordering evidence. To exercise collection, enqueue normally and invoke the actual worker with fake transport; do not seed a completed status as proof of worker success.

| Case | Local steps and required finish assertions |
|---|---|
| E1 | Sign in as A; open `/analytics/instagram/performance`; assert seeded account, exact metrics/null dashes, freshness and lag note. Type/period changes alter exact expected rows; B's IDs/values never appear. Repeat Arabic/RTL and signed-out redirect. |
| E2 | Open `/analytics/instagram?tab=competitors`; assert 120, +20/+20%, +40/+50%, actual intervals; zero/missing/stale/source-changed cases show reasons, no invented rate. Distinguish observed weekly count from complete posts/week. |
| J1 | Connected direct account starts with no snapshots; Sync now returns 202 and a queued state. Fake provider→real worker→SQL→report→UI produces expected values; completion/freshness only after writes. Second request inside throttle gets 429; failed collection retains old history. No “tonight” promise with inactive schedules. |
| J2 | Old/denied page-linked fixture searches and sees reconnect. Local OAuth provider simulation performs protected reconnect through actual application path, invalidates prior capability/cache generation, then the same search returns official with nonzero seeded reel views. Also retain Apify/own/unknown historical source and failed permission-read cases. Live consent is Gate C only. |
| J3 | Search synthetic `@release_competitor`; actual repaired discovery with fake Meta expansion/cursors yields exact profile/posts, REEL vs FEED VIDEO and hidden likes null. Official source survives cache hit and saved-history reload. Repeating as B cannot reuse A's capability-scoped result. |
| J4 | Provider fixture gives confirmed ineligible target: eligibility copy, persisted weekly retry only where appropriate. Separate viewer permission/190/network fixtures must not label target private. Interactive fallback off makes zero Apify calls; admin-enabled interactive fallback is labeled Third-party. Scheduled fallback remains off. |
| J5 | Track once; assert one normalized row, pending before capture, then collection/report fixture. First observation has no growth; load later seeded historical observations for the E2 comparison, without fabricating elapsed days. Remove retains ID/history and frees slot; reactivate reuses ID, clears marker and enqueues. Lost mutation response reconciles without automatic replay. |
| J6 | Fill synthetic resolved quota; N+1 add/reactivation fails with exact limit and pricing path, no row/enqueue. Concurrent requests yield only allowed activations. Override/admin unlimited and downgraded existing rows behave per parent §12; no admin upgrade prompt. |
| J7 | Both screens show exact outlier/above/normal/below and neutral too_early/small_baseline/no_data. Changing display period/page cannot change the same media's score. Owner organic and competitor public metric bases remain visibly distinct. |
| J8 | Local MCP client calls registered `get_post_analytics` with posts:read. Compare report fields/nulls/outliers/freshness to UI's backend report for the same fixture and period; assert zero provider calls. Reject absent scope, cross-owner and malformed cursor; retain Threads/TikTok and Facebook unsupported behavior. |
| J9 | Fake 190 after enqueue reaches real fenced health transition and reconnect banner; another account still advances. Permission-only failure stays scope_missing without needs_reauth. Stale response after reconnect cannot overwrite new authority or clear health state. Retain last good report. |
| J10 | Synthetic <100-follower account with explicit threshold-unavailable reason shows localized “needs 100+ followers” and null, alongside valid zero measurements. A generic empty provider metric remains generic unavailable; follower count alone cannot invent a provider reason. |

Also assert `/brand-intelligence` compatibility, default Performance and `?tab=analyze`, browser back/forward, no redirect loops, current analytics feature/auth flags, owner-switch cache cancellation, bounded polling, stale read vs empty, safe captions/URLs/thumbnails, dialog focus return, keyboard tab order, reduced motion, and no page overflow at 320/375/768/1280px and 200% zoom. Screenshots supplement exact DOM/data assertions. Failure injection must show that a disconnected report route or discarded source makes the relevant journey fail.

## 5. Deployment manifest and rollback contract

This is a **release manifest template with exact inspected/proposed paths**, not an assertion that production has them. Implementation freezes final commit, per-file SHA256, migration catalog/ACL evidence and deployment receipts in the proposed `docs/runbooks/instagram-insights-release.md`, referencing the operational procedure in [deploy-edge-function.md](../runbooks/deploy-edge-function.md). Do not copy that runbook's host paths or secret handling here. Reconcile the full applied migration ledger and existing baseline first; never replay already applied migrations or edit their bytes.

### Ordered feature migrations

Paths below are relative to `supabase/migrations/`. Apply only missing, reviewed migrations in ascending order after disposable baseline-plus-delta rehearsal. Other intervening application migrations still follow the full repository ledger; this feature list is not permission to omit them.

| Order | Exact migration | Inventory state |
|---|---|---|
| 1 | `20261026120000_instagram_capability_prerequisites.sql` | existing; in inspected main |
| 2 | `20261026130000_instagram_insight_tracking_schema.sql` | existing; in inspected main |
| 3 | `20261026140000_facebook_user_credential_bindings.sql` | existing; in inspected main |
| 4 | `20261026150000_instagram_durable_collection_jobs.sql` | existing; in inspected main |
| 5 | `20261027100000_meta_pending_selection_secret_boundary.sql` | existing; in inspected main |
| 6 | `20261027110000_meta_oauth_attempt_lifecycle.sql` | existing; in inspected main |
| 7 | `20261027120000_meta_account_refresh_lifecycle.sql` | existing; in inspected main |
| 8 | `20261028100000_meta_oauth_identity_alias.sql` | existing; in inspected main |
| 9 | `20261028110000_meta_page_token_reconciliation.sql` | existing; in inspected main |
| 10 | `20261029150000_competitor_collection_results.sql` | existing; in inspected main |
| 11 | `20261029160000_instagram_direct_collection_credential.sql` | existing; in inspected main |
| 12 / M1 | `20261030100000_competitor_capture_coverage.sql` | existing; on main since #306 (`1e1fbed3`) |
| 13 / M2 | `20261030110000_competitor_tracking_report.sql` | existing; on main since #306 (`1e1fbed3`) |
| 14 / M3 | `20261030120000_competitor_retention.sql` | existing; on main since #306 (`1e1fbed3`) |
| 15 / M4 | `20261030130000_competitor_retention_cron.sql` | existing; on main since #306 (`1e1fbed3`) |
| 16 / R1 | *unassigned* `_instagram_collection_rollout_controls.sql` | proposed, [collection rollout controls](2026-10-30-instagram-collection-rollout-controls.md) |
| 17 / R2 | *unassigned* `_instagram_collection_daily_dispatch.sql` | proposed, collection rollout controls |
| 18 / C1 | *unassigned* `_instagram_collection_cron.sql` | proposed, collection rollout controls |

R1/R2/C1 contracts and implementation ownership are in the [collection rollout spec](2026-10-30-instagram-collection-rollout-controls.md) and [plan](../plans/2026-10-30-instagram-collection-rollout-controls.md). No version is reserved for them: `20261030140000` and `20261030150000` are already taken on main (`20261030140000_sweep_ai_image_staging_cron.sql`; `20261030150000_record_published_story.sql`, added by #313 `499a3183`). C1 depends on tested eligibility and daily dispatch. Versions are assigned as a series, R1 < R2 < C1; each member's file suffix is fixed by the rollout spec (`_instagram_collection_rollout_controls.sql`, `_instagram_collection_daily_dispatch.sql`, `_instagram_collection_cron.sql`). **Each** member's owning task picks a version that no file in `supabase/migrations/` uses and that is newer than every migration on main, the harness baseline marker and the previous member at the time it is assigned, so manifest order and the hand-applied ascending order stay the same; if main gains a newer migration before the member merges, the member is renumbered before merging. The rule is therefore checked at merge, from history, not from per-run evidence. The Task 1 checker reads `supabase/migrations/` and the repository's git history and checks what it can recompute at any time: every version prefix is unique; the series is ascending and sorts after M4; the frozen manifest versions are strictly ascending. Each member's PR is **squash-merged**, so exactly one commit on the first-parent line of the main ref adds its file, and that commit's first parent is the main tip it landed on. The checker takes the main ref as a required parameter (`--main-ref`, no default; the Task 6 CI job passes `origin/main`, the remote-tracking ref, after a `fetch-depth: 0` checkout on both `pull_request_target` and `push` events, because a pull-request checkout is detached and has no local `main`; no merge queue is used for this gate; an unresolvable ref fails as `main_ref_unresolved`, separately from history errors). For each member it first reads `git log --first-parent --name-status -M -l0 <main-ref>` with **no pathspec** (git applies a pathspec before rename detection, so any pathspec, even the migrations directory, would print a rename from outside it as a plain `A`; `-l0` lifts `diff.renameLimit`, and any git warning that rename detection was skipped fails closed as `member_assignment_ambiguous`) and filters the entries itself, classifying only paths under `supabase/migrations/` that carry a series suffix. It fails with `member_assignment_ambiguous` on any `R` entry with such a path at either end, and on any addition of a path with that member's suffix that is neither the member nor in its declared supersession chain below; only then does it count the adding commits, and requires: exactly one adding commit (none → `member_not_on_main`; more than one → `member_assignment_ambiguous`), with exactly one parent (a merge commit means the squash rule was broken and side-branch history is hidden, so it fails as `member_assignment_ambiguous`); that commit's first parent is the member's merge snapshot; the newest migration version and the baseline marker recomputed from that snapshot's tree are both older than the member (otherwise `member_snapshot_stale`). The evidence JSON records each merge snapshot (commit, newest version, marker), captured when that member merges, and the checker rejects any recorded value that differs from the derivation (`member_snapshot_mismatch`). Before a member is on the main ref, the checker compares it with the **current tip** of the main ref, not the merge-base: if that tip already holds a migration or baseline marker that is not older than the member, it fails with `member_stale_version`; otherwise it reports the gate as blocked with `member_not_on_main`. That check blocks a stale merge only if it runs against the tip the member actually lands on and its result is enforced, so G-X has a stated precondition: main's branch protection requires branches to be up to date before merging **and** lists the migration gate's own status check directly as required (not through an aggregate in another workflow), and the repository allows only squash merges into main (linear history alone does not qualify: a rebase merge can land several commits, one adding and a later one editing the file), because the single-parent rule below is otherwise detectable only after the merge. A merge queue is not an alternative: a batched group can hold a newer migration that is not yet on `origin/main`. Task 6 records all three settings as evidence; unless all three are configured, a pre-merge pass means only "not stale when CI last ran" and the post-merge snapshot check is the binding one. `--phase local` reports an unmerged member as blocked; `--phase release` requires every member on the main ref. The required CI status runs only the migration-assignment checks (`--gate migrations`), whose failing conclusions are `member_stale_version`, `member_snapshot_stale`, `member_snapshot_mismatch` (once evidence exists), `member_supersession_invalid`, `member_modified_after_merge`, `member_assignment_ambiguous`, uniqueness/ordering failures, `assignment_commit_unreachable` and `main_ref_unresolved`; `member_not_on_main` and unresolved evidence dependencies are reported but conclude neutral there, so absence and missing evidence alone never block a PR, while the listed migration failures do. Once a member, or any migration in its declared supersession chain, is on the main ref, its bytes at the ref under check must equal its bytes in its adding commit; a missing or different file fails as `member_modified_after_merge`, because an applied migration's bytes must not change. History is not forgotten and the gate fails closed: if first-parent history contains any post-add change to such a file (edit, deletion, rename, or a later re-add or rename-back), `member_modified_after_merge` keeps failing even after the bytes are restored. With squash-only merges, the required candidate check below and up-to-date branches, such a change can reach main only by bypassing branch protection, so it is treated as an incident: no automated recovery is specified here, and clearing it needs a separately reviewed, owner-approved recovery design (acknowledgement record, environment inventory and repair rehearsal), listed as open question 6 in §8. So that a candidate cannot weaken its own gate, the required migration check is a separate `pull_request_target` workflow in its own file, `.github/workflows/instagram-migration-gate.yml` (plus `push` on main), because a `pull_request` workflow is loaded from the candidate: it runs the checker and workflow code of the protected base commit with `permissions: contents: read` and no secrets, fetches the candidate merge ref only as git objects, never executes candidate files, and publishes its result as a commit status on the PR head SHA using only `statuses: write`, so branch protection sees it on the candidate. The checker and that workflow are CODEOWNERS-protected with required owner review, so weakening them takes an owner-approved PR even when split from a migration change, and a PR that changes either of them together with any series-suffixed migration fails as `gate_self_modification`, a failing conclusion of that gate; edits to the shared `ci.yml` do not count. This is an intended repository-wide merge freeze: while the episode is open, every PR's required check stays red, including unrelated PRs, and the approved recovery lands through an admin merge whose approval reference is recorded with the release evidence. So that file-level violations stop the PR that causes them instead of every later PR, a PR run also evaluates the candidate merge commit, passed to the checker explicitly as the fetched merge SHA (`CANDIDATE`, whose first parent is the base tip; under `pull_request_target` the workflow's own `HEAD` is the base, so `HEAD` is never used for this), and reports on the candidate tree instead of the base for file-level rules: every merged member or chain file must exist at `CANDIDATE` with exactly its adding-commit bytes (so an edit, deletion or rename fails on the PR that makes it), and `CANDIDATE^1..CANDIDATE` must not add a series-suffixed file that is neither that member nor a declared chain member. The full ledger run stays a separate, non-required report. If a stale member nevertheless reaches main, it is never renamed (that is ambiguous by rule). Its own snapshot check fails permanently, because its merge snapshot cannot change, so recovery uses an explicit superseded state: a new migration S, assigned under the same rules and still after the previous member, replaces its effect; the manifest keeps the stale member as historical inventory marked `superseded_by: <S version>`; and the checker reports it as `member_superseded` (historical, not a failure) and applies every snapshot, rename and evidence rule to the chain's terminal replacement instead. Files listed in that chain are exempt from the other-version addition rule; any unlisted file with that suffix still fails it. A `superseded_by` that names a missing file, a version not newer than the one it replaces, or a terminal replacement that fails those rules fails the gate as `member_supersession_invalid`. Because a replacement must be newer than everything on main, superseding a member also supersedes every later series member already on main, each replaced in order (R1's replacement, then R2's, then C1's), so the applied order stays R1 < R2 < C1. All replacements in such a cascade land in **one** squash-merged recovery PR, so the checker never sees a half-replaced series; their merge snapshot is that PR's first parent. Supersession cannot repair an exact version collision: a duplicate prefix stays a failed uniqueness check, so the gate stays failed until the owner approves a separately reviewed fix. A commit missing from history fails as `assignment_commit_unreachable`. The current-tip comparison applies only while a member is absent from the main ref; once it is merged, the checker validates only its merge snapshot and never compares it with the **current** baseline marker or requires it to stay globally newest, so a later unrelated migration or a regenerated baseline never fails a correct, already-applied series. Freeze delivered artifacts before release; proposed contracts and an unresolved dependency fail the manifest gate, never a wildcard deployment instruction. M1–M4 contracts remain owned by Task 8.

### Function and module set

All paths below are under `supabase/functions/`; braces enumerate exact filenames. Freeze **all runtime files and the recursive local import closure**, excluding tests/test helpers, at the release SHA. Never deploy just an entrypoint that imports absent siblings. A shared-module change requires reviewing and boot-checking every affected consumer, including consumers outside this feature.

| Runtime unit | Inspected files / proposed addition |
|---|---|
| Owner collection | `instagram-insights-sync/{index,handler,store,worker,workerStore,graphProvider,directGraphProvider,providerTransport,receipts}.ts` — existing |
| Owner report | `instagram-insights-report/{index,handler,contracts,reportStore,assemble}.ts` — existing |
| Competitor collection | `competitor-snapshot-sync/{index,handler,store,syncWorker,types,receipts,graphProvider,apifyProvider}.ts` — existing; include M1 v2 writer adoption |
| Protected OAuth | `facebook-oauth/{index,protectedPageConnect}.ts`, `instagram-business-oauth/index.ts`, `instagram-oauth/index.ts` — existing |
| Refresh | `refresh-tokens/{index,escalation,sweepBudget,metaRefreshProvider,metaRefreshStore,protectedMetaRefresh,metaPageReconciliationProvider,metaPageReconciliationStore,protectedPageReconciliation,youtubeProviderRefresh}.ts` — existing; preserve unrelated provider behavior |
| Existing consumers | `ad-analytics/index.ts`, `facebook-places-search/index.ts`, `threads-location-search/index.ts`, `check-connection-health/{index,youtubeProviderHealth}.ts`, `brand-scrape/index.ts` — existing; Task 2 changes remain pending |
| API | `n8n-api/{index,mediaRelay,optOutGate,platformPostDelete,postActions,postMediaDelete,rateLimitConfig,refusalLog,requestBody,requestGuards,serviceProxy,webhookFilters}.ts` — existing |
| MCP | `mcp/{index,confirmGate,connectionMode,keyOwner,stringList,toolScopes}.ts` — existing |
| Competitor report | `competitor-tracking-report/{index,handler,contracts,reportStore,assemble,growth,weeklyInventory}.ts` — existing; on main since #306, not deployed |
| Retention | `competitor-retention/{index,handler,run,deps}.ts` — existing; on main since #306, not deployed |

The inspected recursive local-import closure contains these **50 existing `_shared/` modules** (including dependencies of API/MCP compatibility consumers). This is a deployment inventory, not permission to edit them:

```text
auth-helper.ts
automationDispatchLog.ts
avatar-cache.ts
background.ts
base64Media.ts
commentActions.ts
composioClient.ts
composioConnections.ts
connectorRegistry.ts
connectorTelemetry.ts
cors.ts
cron-auth.ts
crypto.ts
errorSanitizer.ts
evolutionApi.ts
facebookCredentialMode.ts
facebookUserCredentialStore.ts
instagramDiscoveryViewer.ts
linkedinDestinations.ts
logging.ts
mcpEndpoints.ts
mcpScopes.ts
mediaQuotaError.ts
mediaTypes.ts
messageSend.ts
messengerCredentials.ts
metaErrors.ts
metaOAuthAttemptStore.ts
metaOAuthProtectedBoundary.ts
metaOAuthProtectedFlow.ts
n8nMessagingDispatch.ts
oauthState.ts
openinary.ts
optOutLookup.ts
outlierScore.ts
protectedAccountCutover.ts
protectedFacebookCredentials.ts
refreshEligibility.ts
request-timeout.ts
social-auth.ts
threads-debug.ts
tokenExpiryConstants.ts
validate.ts
webhookSecurity.ts
whatsappTransport.ts
youtubeApiErrors.ts
youtubeCommentCapability.ts
youtubeComments.ts
youtubeComposioOptions.ts
youtubeGrantedScopes.ts
```

The final immutable manifest must re-enumerate the closure after dependency tasks land and fail on unresolved paths or changed hashes. Include external Deno import versions/configuration and runtime import consumers not found by static traversal. Publishing regression uses the reviewed existing publishing runtime; add any changed publishing files/closure explicitly if an owning task changes them. `workerTestSupport.ts` is test-only and is not runtime evidence.

Frontend release includes existing owner routes/feature and Task 8's competitor feature/composition/translations (on main since #306), using the accepted Task 9 navigation contract. `supabase/config.toml` and `src/integrations/supabase/types.ts` must match accepted handlers/catalog. Schema/ACL verification precedes dependent functions and frontend merge because the automatic reconciler does not apply migrations; follow the linked deployment runbook and account for its schedule before any authorized manual deployment.

### Schedules and switches

| Proposed job name | UTC schedule | Dispatch contract | Required default |
|---|---|---|---|
| `instagram-insights-enqueue-daily` | `30 0 * * *` | Proposed `{action:"enqueue-daily"}` and durable continuation, [rollout spec §4](2026-10-30-instagram-collection-rollout-controls.md#4-owner-daily-enqueue-http-dispatcher-and-durable-continuation) | absent now; C1 must install inactive |
| `instagram-insights-drain` | `*/2 * * * *` recommended | Existing owner `{action:"drain"}` plus proposed SQL eligibility and pending-sweep resumption | absent now; C1 inactive |
| `competitor-snapshot-enqueue-daily` | `0 1 * * *` | Proposed `{mode:"enqueue-daily",dispatch:"durable"}`; existing cursor branch preserved by rollout contract | absent now; C1 inactive |
| `competitor-snapshot-drain` | `*/2 * * * *` recommended | Existing competitor `{mode:"all"}` | absent now; C1 inactive |
| `competitor-retention` | `20 * * * *` | Task 8 retention handler, runtime cron-secret lookup | M4 on main since #306; applied state unverified; created `active := false` |

The two-minute drain interval is a recommendation awaiting readiness/capacity evidence, not an approved existing schedule. Daily due-target enqueue must finish all bounded pages without starving later targets; cron idempotence is not drain completeness. No Stories or scheduled Apify jobs. Tests run each definition twice and assert exactly one inactive job, correct auth-secret lookup, failure when required cron infrastructure is absent, and no change to unrelated schedules.

Existing controls are `collection_instagram_insights_enabled` (absent/false means off), `credential_facebook_user_mode` (global mode), and `credential_facebook_user_protected_pilot_user_ids` (OAuth pilot user UUID list). Competitor collection currently shares the collection setting; do not invent an independent existing competitor switch. Task 8 proposes `competitor_retention_enabled=false`, checked in SQL as well as Edge. Missing/unreadable/malformed settings must follow the actual accepted fail-closed contract, with logs.

The [rollout spec §2–3](2026-10-30-instagram-collection-rollout-controls.md#2-server-owned-eligibility) proposes `collection_instagram_rollout_policy`: independent owner and competitor populations, pinned pilot viewer, SQL enqueue/claim/request/write checks and per-account credential selection under global legacy mode. Its [plan](../plans/2026-10-30-instagram-collection-rollout-controls.md) owns implementation; these controls remain proposed until tested and deployed.

Rollback stops new enqueue/drain/retention schedules and sets collection/retention off, hides the new UI entry points by the reviewed release mechanism, and retains additive schema/history. Pause rollout, preserve redacted evidence and inspect in-flight leases/fences before resuming. Removing a pilot UUID prevents future pilot authorization; **it does not downgrade already protected accounts**. Do not erase protected rows, restore browser-visible tokens, flip global credential mode as a collection rollback, reset the server checkout, drop history, or assume reverting to pre-cutover code is compatible. Pin a tested protected-compatible last-good runtime. The frontend hide mechanism must be explicit in the final runbook; no new feature flag is assumed to exist.

## 6. Activation gates B–E — approval required at every step

All boxes start unchecked. Planning, prior merges and prior general authorizations do not check them. Record Waleed's explicit approval reference, exact candidate/configuration, intended accounts, timestamp, operator and resulting redacted evidence **for each numbered action**, then stop before the next action. Local readiness (Gate A) requires complete local-phase G-X, accepted dependencies and final-revision local/hosted checks and reviews; this document does not obtain or authorize hosted work.

### B — release prerequisites and pilot eligibility

- [ ] B1: Waleed approves the concrete immutable release/schema manifest and production preflight; reconcile installed IDs, grants, drift and rollback compatibility. Apply only separately approved missing prerequisites with all new schedules inactive. Record exact catalog and hashes; no raw credentials.
- [ ] B2: After B1 evidence, Waleed approves deployment of the reviewed functions/shared closure and frontend under the existing runbook. Verify each function boots and expected authenticated off-state refusal; do not equate boot with schema readiness.
- [ ] B3: After B2 evidence, Waleed approves adding the chosen **user UUID(s)** to `credential_facebook_user_protected_pilot_user_ids`, keeping global mode legacy and collection off. Confirm non-pilot users' legacy paths still work and already protected accounts stay protected. Record membership without exposing credentials.

### C — reconnect and preserve ordinary behavior

- [ ] C1: Waleed approves one named pilot reconnect, first for the chosen login type; verify real consent, trusted granted scopes/identity, protected authority and generation, and no new browser-visible credential. Repeat the other login type only after a separate approval and report.
- [ ] C2: Waleed approves the login/session and refresh regression check for those accounts, including Page reconciliation without claiming User-grant renewal. Verify unaffected sibling and non-pilot behavior; failures stop the gate.
- [ ] C3: Waleed approves the exact harmless test post/account/content and its publishing check. Verify the real resulting status/ID and normal posting behavior; any deletion/cleanup of that post needs its own approval. Fixture posting proof is insufficient for C3.

### D — collect for one account, then one competitor

- [ ] D1: **Blocked pending implementation and evidence.** The [collection rollout spec](2026-10-30-instagram-collection-rollout-controls.md) and [plan](../plans/2026-10-30-instagram-collection-rollout-controls.md) own server-enforced one-account eligibility, per-account credential selection, durable daily dispatch and C1. Waleed approves this prerequisite only after RC-01–RC-17 evidence and deployment readiness. The OAuth user list is not collection admission; cron inactivity does not isolate pending jobs. Do not bypass this by setting global credential mode to protected. The same mechanism gates **competitor targets** (owner enqueue, privileged enqueue and drain claims), because competitor collection shares `collection_instagram_insights_enabled`: D2 cannot enable that setting without also opening competitor collection, so competitor collection stays behind its own server-side gate until D3.
- [ ] D2: With D1 deployed and other targets demonstrably excluded, Waleed approves collection for exactly one named owner account, all broad schedules still off. Verify configured Meta version/host, dates/units/product classification, nulls, lag repair, bounded continuation, persisted success/partial/error and report/UI parity. Record other-account zero-provider-call evidence. Repeat the other login type only under a new approval after the first succeeds.
- [ ] D3: Waleed approves one named competitor target/viewer after owner-flow evidence. Verify official provenance, nullable views, durable coverage, target-vs-viewer errors, no scheduled Apify and correct report/queue behavior. Unknown ordering remains unknown; do not manufacture complete-week evidence.

### E — wider rollout and retention

- [ ] E1: Waleed approves the named wider cohort or **all eligible accounts**, with an explicit list/count of exclusions needing reconnect; protected authority readiness must be measured, never assumed. Enable collection eligibility only for that approved set. The same approval names the wider **competitor-target** set (list or count) separately from the owner accounts; D3's single target stays the only eligible competitor until it does, and competitor eligibility is enabled only for that named set. Global protected cutover, if ever wanted, is a separate migration/cutover decision, not implicit in “all collection”.
- [ ] E2: Waleed approves the exact daily enqueue and drain schedules/cadences, which collect only the owner accounts and competitor targets E1 approved, after boot, capacity and off-state tests. Observe a full due-target drain with continuations and >25 owners/>50 competitors where available; synthetic scale tests complement low-volume live evidence. Record missed targets, backoff and last-success/partial truth.
- [ ] E3: Waleed approves retention **dry run** first; report eligible counts and bounded backlog without deleting. After reviewing that evidence, obtain a **separate approval** for `competitor_retention_enabled` and its cron. Verify eligible inactive-only deletion and absence of active/foreign history loss.
- [ ] E4: Waleed accepts the release report after the agreed observation window. Confirm exact deployed SHA/hashes, migration ledger, API/UI/MCP regression evidence, redacted logs and rollback readiness. Any missing live evidence leaves that gate pending, even when local suites pass.

## 7. Runtime reachability, guards and completion

For every new production module since the accepted release base, record a non-test entrypoint→import→**actual call** chain with file/line and immutable hash. Declarations, re-exports, comments, type-only imports and test callers do not qualify. Check the owner index→worker→store/provider, report handler→store→assembler→`computeOutlierScores`, competitor index→worker→v2 persistence, new report and retention roots, and frontend route→composition→application→adapter. Verify scheduled entrypoints against installed dispatcher bodies. For an intentionally disabled adapter such as scheduled Apify, record the deferred policy and do not count a fake-port test as a reachable shipped feature; resolve any dead-module violation before claiming completion.

G-X has two phases to avoid an approval cycle. The local phase requires executed local proofs and resolved product dependencies while retaining G-L evidence and approvals as explicitly pending. The release phase additionally requires applicable live evidence and approval receipts. It must fail for a missing/changed artifact, unresolved acceptance ID in that phase, newly skipped required test, unwired module, missing proposed file, unresolved import, mismatched migration/type catalog, or unapproved live action. One copied-fixture negative control should disconnect a real production call and make the intended test fail behaviorally; retain the original immutable source.

Run `clean-code-guard` on production changes, `test-guard` on tests and `docs-guard` on documentation when available, plus independent final review. Record scope, tool/skill version, result and findings. Unavailable named guards are not passes; before implementation completion supply them or retain an explicit applicable waiver/manual-equivalent approval. This authoring task changes no production code/tests: those two guards are not applicable, and manual documentation review is disclosed. Reuse the existing immutable lint/i18n comparison policy for baseline failures; do not label a failing full command green or add suppressions/skips.

## 8. Open questions for Waleed

These questions are recorded for later decisions, not requests to perform production actions now. Recommended defaults do not constitute approval.

1. **Pilot people/accounts and first login type?** Default: Waleed-designated synthetic-purpose account, one pilot user and one direct-login account first, then one Page-linked account under a separate C1/D2 approval; no UUID inferred from email or copied into public docs.
2. **Collection pilot prerequisite?** Default: implement the assigned [rollout controls spec](2026-10-30-instagram-collection-rollout-controls.md) and [plan](../plans/2026-10-30-instagram-collection-rollout-controls.md), resolving their recorded defaults; keep D blocked until real SQL/handler tests prove exclusion. Never use the OAuth allow-list or global protected toggle as a substitute.
3. **Drain cadence and observation window?** Default: propose two-minute bounded drains only after capacity evidence, and at least 72 hours containing three Kuwait daily cycles to observe lag reconciliation before all-account acceptance. Daily times and Task 8 retention cadence stay with their owning contracts.
4. **Metric/retry discrepancies (D8/A6/I3)?** Default: require a documented, evidence-backed Task 6 decision and red/green tests; retain unavailable/unknown honestly and keep affected release gates blocked rather than silently weakening the source contract. Live Meta probes require separate approval.
5. **Permission to publish the Gate C canary?** Default: no publication until Waleed approves exact account/content and any subsequent cleanup. Prepare the candidate post as a reviewable fixture first.
6. **Recovery from a post-merge edit to an applied migration?** Default: none automated; the migration gate stays failed and the owner approves a separately reviewed recovery (an acknowledgement record bound to the exact commits and blobs, a canonical environment inventory, and a repair migration rehearsed from both the original and the altered lineage) before anything clears it.

Resolved quotas, S=3 days, 90-day retention, deferred Stories, optional competitor tools and scheduled Apify are not open questions. Production access, deployment, activation and final acceptance always remain separate B–E approvals.
