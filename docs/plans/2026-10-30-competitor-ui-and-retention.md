# Task 8: competitor UI and retention implementation plan

Date: 2026-10-30. Status: documentation only; proposed implementation sequence, not an execution/release authorization.

**Goal:** Deliver truthful, owner-isolated Instagram competitor tracking UI and bounded cleanup of inactive history after 90 days.

**Architecture:** Feature-owned frontend with injected application ports and UI-owned React Query hooks. A new authenticated database-only competitor report boundary computes analytics on the server; existing owner management RPCs and competitor sync endpoint retain their contracts. Separate SQL-bounded retention with an inactive cron schedule.

**Stack:** React 18, TypeScript, TanStack Query, existing shadcn/Radix primitives, i18next, Deno, self-hosted Supabase/Postgres.

**Spec:** [Competitor UI and retention](../specs/2026-10-30-competitor-ui-and-retention.md). Parent: [Instagram insights and competitor tracking](2026-10-26-instagram-insights-and-competitor-tracking.md), especially Task 8/11 and binding §10. Source acceptance IDs: [original spec §8–9](../specs/2026-10-26-instagram-insights-and-competitor-tracking.md).

**Baseline:** fetched `origin/main`, `191152935ecf8cc160721e2cdf9fcdc28a602d5f`; worktree `E:\Dev\Worktrees\postora_new\competitor-ui`, branch `feat/competitor-ui`. Existing-code citations refer to that commit; future file names are explicitly proposed. Reconfirm baseline and local instructions before implementation. Read all of `ARCHITECTURE.md` and `CLAUDE.md`, plus `AGENTS.md`/`PROJECT_AGENT.md`, before changing code. Relevant architecture sections: §3–4, §8–17, §22–29, §31–39, §45–46.

For future agentic workers, execute one numbered task at a time with its tests and review. This document does not select a delegate model, start a subagent or authorize implementation. The current user authorized only these two documents and their local scoped commit, overriding the historical delegate no-commit restriction for this documentation delivery. No push, PR, merge, deployment, production access or secret reads are authorized in this task.

## Global constraints — parent §4, quoted verbatim

1. Read `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` (§3–4, §12–17, §23–28, §31–39), `PROJECT_AGENT.md`, this plan and the source spec before changing code. Follow directory-scoped instructions.
2. Implement only the numbered task(s) assigned. Do not commit, push, merge, deploy, run production SQL, modify secrets or touch the standalone n8n node repository. The orchestrator reviews and commits scoped files.
3. Preserve unrelated user work and existing API behavior. No broad refactors, platform-version migration, scraping index, Facebook insights, hashtag search, Ad Library, or optional work without explicit approval.
4. Derive caller identity from verified auth. Service-role reads and writes must structurally enforce resource ownership, including denormalized user IDs and post/account links. RLS alone does not protect service-role work.
5. Null means unavailable, never zero. Failed reads/writes are failures, never empty data or successful syncs. Validate untrusted inputs/responses, sanitize client errors, redact logs, and log every refusal/early exit.
6. No token-prefix heuristics, raw tokens in frontend/contracts/logs, browser-readable new credentials, or provider URLs containing credentials in logs. Provider calls use explicit timeout, bounded retries and trusted-host cursor construction.
7. Scheduled and on-demand work uses atomic durable claims, expiring leases, checkpoints, idempotent upserts and bounded wall-clock/request budgets. No unbounded waitUntil jobs or browser-owned scheduling.
8. Keep UI → application ports/domain; infrastructure implements ports; only feature composition roots wire infrastructure. React Query hooks belong to UI, not framework-independent application modules. New modules must have real production callers.
9. Rehearse additive migrations and tenant-negative tests before release. Apply and verify prerequisites before deploying dependent functions/frontend. Enable new schedules only after functions boot and readiness is verified.

## Evidence, dependencies and scope limits

The spec §1/4 contains the full verified contract inventory. In particular:

- Existing owner add/update/quota RPCs are at `supabase/migrations/20261026130000_instagram_insight_tracking_schema.sql:986/:1336/:1517`. Preserve existing defaults, overrides, `effective_user_quotas` return type, grants and quota locking. Do not create another entitlement arbiter.
- `instagram-insights-report/handler.ts:151` accepts owner account IDs. It cannot currently return competitor data. New `competitor-tracking-report` plus a narrowly authenticated SQL reader are justified additions, not an invented existing boundary.
- `competitor-snapshot-sync/syncWorker.ts:688` drops `capture.truncated`; `graphProvider.ts:840` computes it. New coverage persistence is a required backend prerequisite for accurate weekly-rate acceptance. It belongs to the Task 7/8 contract seam and must receive an explicit implementation assignment; no provider rewrite is bundled into UI work.
- Interactive `brand-scrape/index.ts:716` does not expose source; `useBrandScrape.ts:6/:110` loses it through query/history. Parent **Task 2 provenance remains a release dependency** for U4/J2/J3. This plan supplies truthful unknown-state UI and pass-through after that contract lands; it does not claim Task 2 is merged or undertake its OAuth/discovery repair.
- Live composition is `src/pages/analytics/InstagramAnalytics.tsx:29/:184`; `AnimatedRoutes.tsx:255` redirects the old route. Both legacy-page composition and the reachable screen must be accounted for.
- Use `InstagramPerformanceScreen` gateway injection and workspace pattern, but do not copy application-folder React hooks or generic raw-message handling. `ARCHITECTURE.md` and parent §4.8 take precedence over those local patterns.
- English strings are call-site defaults; Arabic bundle only (`src/i18n/index.ts:7`). No parallel `en/analytics.json` is needed.
- Named mem0 tools are absent in this authoring session. Graph CLI is absent; a read-only graph edge lookup identified ProfileCard's cross-platform consumers, then direct source supplied newer contracts. No memory recall/save or graph CLI success is claimed. No code change means no AST graph update is needed for this document commit.

Do **not** change owner report DTO/proxy/MCP scopes, OAuth/refresh credentials, graph API version, collection budgets or schedules, paid fallback policy, Stories scope, quota numbers/precedence, public n8n behavior, media-retention, shared theme, unrelated Brand Intelligence filters/search algorithms, or applied migrations. Do not silently repair unrelated existing page Supabase calls; all **new competitor work** must use the feature adapter. Do not change the default Performance route into a redirect to competitors. Do not infer live permissions or deployment readiness from checked-in code.

## Migration inventory and sequencing

All four names below are **new/proposed**. Check for timestamp collisions immediately before implementation; if renamed, update the spec/handoff manifest together. Do not edit the 20261026/29 prerequisite migrations.

| ID | Exact proposed migration | Purpose and compatibility |
|---|---|---|
| M1 | `supabase/migrations/20261030100000_competitor_capture_coverage.sql` | Add owner-scoped `competitor_capture_coverage`, bounded indexes and `persist_competitor_collection_result_v2(uuid,uuid,bigint,jsonb)`. Preserve v1 writer signature/behavior. No fabricated legacy coverage. |
| M2 | `supabase/migrations/20261030110000_competitor_tracking_report.sql` | Add `read_own_competitor_tracking_report(jsonb)`, authenticated-only, auth.uid-bound bounded raw projection with explicit grants/revokes and supporting query indexes. No alteration of owner report or quota return types. |
| M3 | `supabase/migrations/20261030120000_competitor_retention.sql` | Add inactive-row eligibility index, service-only `run_competitor_retention_batch(integer,integer,boolean)` and default-off `competitor_retention_enabled` setting. Preserves existing removal/reactivation RPCs and active history. |
| M4 | `supabase/migrations/20261030130000_competitor_retention_cron.sql` | Idempotent one-job hourly schedule at minute 20 UTC, installed inactive with runtime cron-secret lookup. Does not activate itself or modify other schedules. |

**Production migrations are applied manually before merge.** Required future order: rehearse M1→M2→M3→M4 against disposable baseline-plus-delta DB; owner applies and verifies objects/ACLs/indexes manually; deploy immutable reviewed functions and confirm boot; then merge dependent frontend only under the future task's authorization. Retention switch/schedule remain off until separate readiness/activation approval. This authoring task performs none of those steps.

New tables/columns/RPCs require maintained database type alignment in `src/integrations/supabase/types.ts`; compare the rehearsed catalog, not only a TypeScript compiler pass. New schedules must not invoke functions before they exist. Rollback disables retention/schedule and new UI entry point first, retaining additive schema/history and v1 compatibility; it never drops history or resets the server checkout.

## Numbered implementation tasks

Each task follows RED → minimal implementation → focused GREEN → diff/guard review. Run `clean-code-guard` for changed production code and `test-guard` for changed tests; unavailable mandatory guard tooling must be disclosed and resolved under the future implementation authorization, not called a pass. The orchestrator owns scoped local commits. The validation labels V1–V6 below are fully specified commands, not optional checks.

### 1. Persist competitor capture coverage without changing provider budgets — M1

**Create:** M1; `supabase/tests/competitor_capture_coverage.sql`.

**Modify:** `supabase/functions/competitor-snapshot-sync/{types,graphProvider,apifyProvider,syncWorker,store,receipts}.ts`; adjacent `{graphProvider,apifyProvider,syncWorker,store,sqlContract}.test.ts`; `src/integrations/supabase/types.ts`; `scripts/db-harness.sh` and `supabase/tests/README.md` (register the new suite).

**Interface:** v2 writer retains existing four input arguments, adds required coverage to successful v2 payloads and returns a separately versioned receipt accepted by the new store. Existing v1 callers continue unchanged. New coverage fields are exactly spec §6; frontend never consumes this worker payload. Failure paths preserve old snapshot data.

- [ ] Write SQL tests first: valid same-owner capture writes profile/media/coverage atomically; forged owner/generation/claim fails; malformed dates/coverage reject with no partial write; same-day replay is idempotent; a forced newer generation supersedes coverage; stale worker cannot overwrite; legacy v1 capture has unknown coverage; complete/partial freshness distinct.
- [ ] Write provider/worker/store regressions: 30 lifetime with three recent; 30 recent plus more cursor; duplicate IDs; cursor loop/invalid cursor; budget stop; unknown ordering; source switch; empty feed; no extra calls. Assert the production worker actually passes coverage to v2 and the store validates its receipt rather than mocking the entire path away.
- [ ] Implement the additive table and v2 fenced transaction. Validate parent→job lock order before reading prior freshness. Preserve maximum 30 media and existing request/time limits. Do not assert chronological coverage merely because the array was sorted. Default unverified ordering to false.
- [ ] Separate bounded-capture completion from full-inventory freshness: a capped successful capture may finish its bounded job, but must carry partial evidence, advance `last_partial_at`, and preserve prior full-success time. Do not immediately requeue the same impossible-to-expand capped window forever; existing future collection cadence remains authoritative. Budget-interrupted work still follows durable retry semantics. Pin these distinctions in SQL/worker tests.
- [ ] Run V2 for competitor collection and V3. Review actual caller path `index → worker → store → v2 SQL`; no dead module or invented legacy backfill.

**Acceptance:** T8-05 and the data prerequisite of T8-03; parent Task 8 partial state and §10 clarification 9. **Gate:** provider-ordering compatibility can remain unverified only with explicit unknown UI; no claim of complete coverage until its evidence exists.

### 2. Add bounded owner-only report projection — M2

**Create:** M2; `supabase/tests/competitor_tracking_report.sql`.

**Modify:** `src/integrations/supabase/types.ts`; `scripts/db-harness.sh`; `supabase/tests/README.md`.

**Interface:** `read_own_competitor_tracking_report(p_request jsonb) returns jsonb`, consumed only by the new Edge report store with the verified user's bearer. Strict list/detail input shape is spec §5. SQL returns the current transaction's quota, parent projection, profile candidates, coverage, current job status and bounded media/baseline candidates; Edge returns the public DTO.

- [ ] Write SQL tests first for anonymous/service denial, admin-own-only, two owners tracking the same handle, unknown/cross-owner identical not-found behavior, owner-consistent joins, no lease/context/raw error exposure, active/removed lists and quota consistency.
- [ ] Add boundary tests for 20 default/50 max, >50 entries for unlimited admin, limit+1 cursors, exact sub-millisecond ties and identity, invalid/cross-filter cursor, concurrent insertion, latest-per-media selection before pagination, baseline independent of 7/30-day filter. Ensure error is not accepted as an empty payload.
- [ ] Implement `auth.uid()` structural scoping for every join, fixed search_path, explicit revoke from PUBLIC/anon/service_role and grant to authenticated. No caller-selected owner. Use indexed keyset reads and per-displayed-item bounded candidate selection; no unbounded JSON aggregation.
- [ ] Include at most 32 daily profile observations per selected entry plus the approved older-baseline candidate if S requires it; select that candidate directly by indexed cutoff rather than widening a whole-history scan. Up to 12 eligible preceding media per displayed item/cohort; share deduplicated candidates where possible. If a necessary scan is capped without proving eligibility, return incompleteness and no affected score.
- [ ] Run V3; inspect `EXPLAIN (ANALYZE, BUFFERS)` on disposable large synthetic history for list/detail/baseline reads. Pin maximum returned items rather than inventing a universal runtime benchmark.

**Acceptance:** T8-03, data inputs for T8-04/05/06. **Depends on:** M1. Growth staleness policy S must be recorded before freezing the baseline-selection query; no permissive default.

### 3. Build authenticated report endpoint and canonical analytics — no additional migration

**Create:** `supabase/functions/competitor-tracking-report/{index,handler,contracts,reportStore,assemble,growth,weeklyInventory}.ts`; adjacent `{handler,reportStore,assemble,growth,weeklyInventory,route}.test.ts`.

**Modify:** `supabase/config.toml` only to register new handler auth consistent with its internal verification; `.github/workflows/ci.yml` to add required typechecked Deno tests and actual-route test, with missing-file checks.

**Interface:** `createCompetitorTrackingReportHandler(deps)`; `readReportInput(request, verifiedBearer)` in store; `assembleCompetitorReport(input, now, baselinePolicy)` produces the spec §5 version-1 DTO. `baselinePolicy.maxStalenessSeconds` must come from the resolved business decision, never the client. Import existing `computeOutlierScores`; do not copy its algorithm or change owner report types.

- [ ] Write RED fixtures: missing/zero/null/stale baseline, negative growth, actual interval, source change, no configured policy; distinct weekly IDs/complete vs partial/unknown; latest media/source cohort, six/twelve baseline boundaries, 48h maturity, zero median, threshold equality, display-period invariance.
- [ ] Write endpoint/store tests: real registered handler, auth failure, unsupported method/body size/unknown fields, 15s total budget/5s dependencies, bearer forwarding, service impersonation denial, non-enumerable 404, fail-closed malformed RPC payload and read errors, sanitized logs/errors, no provider fetch or enqueue. Read still succeeds from stored data when collection is off.
- [ ] Implement pure growth/coverage assembly and canonical outlier calls; preserve nulls/unsafe-number rejection. Never read browser metadata as source/permission evidence. Cursor preserves database precision; safe URL/caption projection only.
- [ ] Test endpoint → real SQL fixture in the disposable database, not only fabricated adapter arrays. Compare returned quota and entry identity to actual stored rows. Do not expose every underlying job field.
- [ ] Run V2 for new report + canonical outlier + existing owner report regression, and V3. Review CI registration and auth configuration. No deployment now.

**Acceptance:** T8-03, T8-04, T8-05, T8-06; prerequisite for frontend implementation. **Depends on:** Task 2 and Waleed's S decision for completed growth acceptance.

### 4. Implement feature contracts, adapter and lifecycle application — no migration

**Create under `src/features/competitor-tracking/`:**

- `domain/{contracts,errors,formatters,handle}.ts`;
- `application/{ports,trackCompetitor,removeCompetitor,reactivateCompetitor}.ts`;
- `infrastructure/supabaseCompetitorTrackingGateway.ts`;
- `tests/{contracts,formatters,handle,lifecycle,gateway,architecture}.test.ts`.

**Port contract:** `CompetitorTrackingGateway` exposes `list(request)`, `detail(request)`, `quota()`, `add({username,label?})`, `setActive({watchlistId,isActive})`, `enqueue({watchlistId,force})`, `status({watchlistId})`, with typed DTO/results and abortable reads. Application lifecycle result distinguishes `saved_and_queued`, `saved_enqueue_unconfirmed`, `already_tracked`, and typed mutation failure/indeterminate. Existing wire names are mapped once in infrastructure.

- [ ] Test fixtures first against actual existing RPC and sync envelope shapes from spec §4. Already-tracked reply legitimately lacks quota; no-job status differs from DB error; sync errors are strings while new report errors are objects. Unknown versions, missing fields and unsafe numbers fail.
- [ ] Test lifecycle sequencing: add succeeds then enqueue once; duplicate active add does not force; remove never hard-deletes; reactivate same ID then entry enqueue; quota rejection makes no enqueue; enqueue failure preserves saved row; lost write never automatic replay; label null preserves existing label.
- [ ] Implement bounded function/RPC calls only in adapter, normalize stable errors and Retry-After, runtime validate data. UI never parses provider/SQL messages. Application modules contain no React, SDK or browser APIs.
- [ ] Add import-boundary tests enforcing UI/application/domain direction, public-index cross-feature access, Supabase only in infrastructure, and designated composition roots only. Verify no client-side growth/outlier implementation was introduced.
- [ ] Run V1 focused on this feature, V4 typecheck/lint. This dependency slice is not release-complete until Task 5 gives every module a real production caller.

**Acceptance:** T8-02, T8-03, T8-07; no stale entitlement assumptions or new raw page queries. **Depends on:** frozen Task 3 DTO.

### 5. Build tracked list, detail and lifecycle controls — no migration

**Create under `src/features/competitor-tracking/`:**

- `ui/{CompetitorTrackingScreen,CompetitorTrackingWorkspace,CompetitorList,CompetitorDetailSheet,CompetitorMediaTable,CompetitorStatus,CompetitorSourceBadge,CompetitorOutlierLabel,RemoveCompetitorDialog,TrackCompetitorControl}.tsx`;
- `ui/{useCompetitorTracking,useCompetitorMutations,useCompetitorSyncStatus}.ts`;
- `tests/{CompetitorTrackingScreen,TrackCompetitorControl,CompetitorDetailSheet,RemoveCompetitorDialog}.test.tsx`;
- `index.ts` exporting public screen/control/badge and needed public types only.

**Modify:** `src/i18n/locales/ar/analytics.json` with the spec §9 key inventory and matching call-site English defaults in the new UI files; `tests/architecture.test.ts` for the two named composition-root exceptions.

- [ ] Write Testing Library tests first for every state in spec §3: successful empty vs failure, unknown quota vs full quota, pending/no baseline, source badges, missing/zero growth, incomplete week, neutral outliers, unavailable/reconnect/throttle, disabled collection, stale retained data, remove/undo-by-reactivation and not found after cleanup.
- [ ] Write injected-gateway cache/polling tests: owner switch while requests resolve, no previous-owner flash, cursor reset, per-target pending guard, accepted 202 state, 12-poll maximum, stop on terminal/deferred/unmount/auth change, Retry-After observed, no auto-replay after indeterminate enqueue. These hooks live under UI.
- [ ] Implement the reference-locked solid-card toolbar/list/Sheet design from spec §3 using existing primitives, typed report outputs and plain text captions. No custom chart or analytics recomputation. New source badge supports official/apify/graph_own/unknown; report rows themselves only have official/apify/unknown.
- [ ] Add semantic tabs and active/removed views, confirmation dialogue with focus restoration, live status, translation keys, placeholders and link safety. Detail stays readable for removed entries; retry collection absent while inactive.
- [ ] Run V1, V4 and local V5 for the screen states in English/Arabic at specified viewport sizes. Capture focus/keyboard evidence and compare to the repository reference lock; screenshots alone do not prove semantics.

**Acceptance:** T8-02, T8-04, T8-05, T8-06, T8-07, T8-11; U5/U6 and state portions of U4. **Depends on:** Task 4. The open S policy is not replaced with frontend math.

### 6. Wire ProfileCard and reachable page composition — no migration

**Modify:** `src/components/brand-intelligence/ProfileCard.tsx`; `src/pages/analytics/InstagramAnalytics.tsx`; `src/pages/BrandIntelligence.tsx`; `src/hooks/useBrandScrape.ts`; `src/types/brand-intelligence.ts`; `src/components/brand-intelligence/ScrapeHistory.tsx` only for explicit provenance pass-through; `src/i18n/locales/ar/analytics.json`.

**Create:** `src/features/competitor-tracking/tests/ProfileCardIntegration.test.tsx`; `src/features/competitor-tracking/tests/Navigation.test.tsx`; `src/hooks/__tests__/useBrandScrapeProvenance.test.tsx`.

**Interfaces:** optional `ProfileCard.source` and `ProfileCard.actions` props; existing callers need no change. Pages supply `<TrackCompetitorControl username={...} />` only for Instagram. New tab value `competitors`; `analyze` and `performance` remain valid. History source must be explicit from the parent Task 2 accepted result contract, otherwise unknown.

- [ ] Write regression tests before edits: Instagram-only Track, shared card non-Instagram unchanged, source official/apify/own/unknown, no inference from username/platform/cache strategy, cache/history consistency, no new raw Supabase calls in pages/components, feature exports only.
- [ ] Add live `?tab=competitors` navigation and integration without moving unrelated page algorithms. Test browser back/forward/query change reconciliation, legacy redirect, default Performance and `/performance` route. Do not rewrite `AnimatedRoutes.tsx` unless a test proves a new route is actually necessary; this design needs only the existing path plus tab query.
- [ ] Wire source through hook/history only after parent Task 2 publishes the verified source/error/cache contract. With current baseline, unknown is truthful; **U4 end-to-end remains blocked**, not marked complete by passing a hand-written source prop. Task 2 owner supplies changes under `supabase/functions/brand-scrape/` and any cache/history security work; those are outside this task's production file scope.
- [ ] Run V1 for feature + hook tests; V4; V5 route/source/shared-card flows. Confirm actual route renders the new feature; a legacy-page-only diff fails acceptance.

**Acceptance:** T8-01, T8-02, T8-11, T8-12, U4/U5, J3/J5/J6. **Dependency:** Task 5 and parent Task 2 provenance for complete U4, not merely tests of the unknown fallback.

### 7. Add bounded inactive-history cleanup primitive — M3

**Create:** M3; `supabase/tests/competitor_retention.sql`; `supabase/tests/competitor_retention_race_fixture.sql`.

**Modify:** `src/integrations/supabase/types.ts`; `scripts/db-harness.sh` (register SQL suite and explicitly classify race fixture as manual); `supabase/tests/README.md` (exact two-session commands/interleavings/cleanup).

**Interface:** `run_competitor_retention_batch(p_parent_limit integer,p_child_limit integer,p_dry_run boolean) returns jsonb`; clamp/reject outside 1–50 parents and 1–500 children, no owner/cutoff argument. Return bounded counts for each child relation and parents, skipped-live-lease count, `has_more`, and switch state. Runtime server time is the only eligibility clock.

- [ ] Write SQL tests first: 89d, 90d−1µs, exact90d, future markers, active old rows, null-marker integrity constraint, repeated-remove marker preservation, deactivate/reactivate/deactivate clock, same handle owned by A/B, all child-table ownership FKs, anon/authenticated denial, server switch off/missing/malformed and dry-run no mutation.
- [ ] Seed >500 children and multiple competitors with jobs in every state. Assert one call cannot cascade-delete arbitrary backlog. Include completed jobs, operations/checkpoints, coverage, request throttles; preserve owner jobs, active competitors and shared buckets. Unexpired lease skips; expired generation has no write authority.
- [ ] Implement parent-lock/recheck and child-first bounded deletion exactly as spec §7. Parent→job lock order; composite owner joins everywhere; repeat marker/cutoff predicate before final parent delete; service-only fixed-search-path routine and explicit ACLs. Check for remaining children before any cascade-bearing delete.
- [ ] Add real two-session rehearsals: reactivation holds parent lock then cleanup; cleanup holds parent lock then reactivation; collector commit vs cleanup; two retention runs; expired worker after cleanup. Assert observed lock waits and resulting rows, not a sequential simulation. After90d cleanup-first may remove committed batches; reactivation stops subsequent deletion and does not restore them.
- [ ] Run V3 including every existing suite and the new manual races. Record counts, grant checks, lock ordering, rollback and restart behavior, and clean up synthetic data.

**Acceptance:** T8-08, T8-09. **Depends on:** M1 so coverage is included. No physical delete occurs in user remove/reactivate paths; active-history retention policy remains unchanged.

### 8. Add retention Edge orchestration and inactive cron — M4

**Create:** `supabase/functions/competitor-retention/{index,handler,run,deps}.ts`; adjacent `{handler,run,deps,route}.test.ts`; M4; `supabase/tests/competitor_retention_cron.sql`.

**Modify:** `supabase/config.toml` for the new function; `.github/workflows/ci.yml` for required Deno suites/actual-route checks; `scripts/db-harness.sh`; `supabase/tests/README.md`.

**Interface:** `runCompetitorRetention({dryRun,ports})` with repository batch/readiness/log ports and injected clock. One invocation <=40s, <=50 parents and <=500 child deletions overall, not per repeated slice. Entry delegates CORS/auth/schema/dependencies; no SQL or domain loop in index. No provider/storage SDK needed.

- [ ] Write fake-port tests first: no work, caps across multiple slices, low remaining budget starts no new SQL, abort/DB timeout, unknown response stops, disabled/unreadable switch fails closed, dry run never calls mutation, every exit audited, completed slices reported truthfully on later failure.
- [ ] Write handler/actual-route tests for OPTIONS, POST, invalid JSON/unknown fields/oversize body, anonymous and ordinary-user refusal, verified cron/service/admin authority, no client-controlled cutoff/owner, log redaction, bounded audit failure. Reuse shared auth policy, do not reproduce `media-retention`'s permissive body/method choices automatically.
- [ ] Implement SQL adapter with explicit <=5s dependency limits; account for server transaction rollback, never assume abort proves commit failure. Reinvocation is idempotent because SQL rechecks current eligibility; no unbounded immediate retry.
- [ ] Create inactive cron using runtime secret lookup, hourly minute20. SQL test applies schedule definition twice → exactly one inactive named job; no literal credentials and no alteration of existing media/collection jobs. Missing extension/helper must be reported as not installed, not a successful schedule.
- [ ] Run V2 for retention plus V3. Verify function registration and runbook manifest. **Do not activate cron or the deletion switch during implementation tests against production.**

**Acceptance:** T8-08, T8-09, T8-10. **Depends on:** Task 7; safe release requires manual M3/M4 before function exposure.

### 9. Assemble journeys and release handoff — no migration

**Modify:** `e2e/analytics.spec.ts`; `.github/workflows/ci.yml` only if local seeded browser coverage needs a required job; this plan's future validation appendix.

**Create:** `e2e/fixtures/competitorTracking.ts`; `docs/journeys/2026-10-30-competitor-ui-and-retention.md` (Arabic journey report after implementation); `docs/runbooks/competitor-tracking-retention.md`.

- [ ] Write deterministic E2E assertions first for E2/J5/J6/J7 and remove/reactivate: login as synthetic owner, tracked list contains exact seeded growth, add once, quota rejection does not add, forced retry shows queued then completed fixture, remove retains history, reactivate preserves ID and clears marker. Include Arabic RTL, keyboard dialog flow and all route compatibility paths.
- [ ] Use new disposable/local fixture; do not load repository production `.env` or require real user credentials. Split mocked browser state coverage from real local Auth/PostgREST/SQL integration. Local stubs alone do not satisfy the full assembled gate.
- [ ] Record source dependency from parent Task 2, S policy, persisted coverage/order evidence and Task 7↔8 contract adoption. Never label U4 or complete weekly inventory green when those prerequisites are missing.
- [ ] Run V1–V5 on final candidate; run named guards; verify every new module's actual production call site. After code changes run V6 graph update. Capture command exits/SHAs, unsatisfied gates and existing baseline failures without weakening assertions, suppressions or required inventories.
- [ ] Write runbook with exact M1–M4 names, catalog/ACL proof, function/shared-module manifest, 40s/50/500 caps, inactive hourly schedule and switch, dry-run/backlog/no-work expectations, race semantics, rollback retaining schema, and future `docs/runbooks/deploy-edge-function.md` SHA256/boot procedure. Production migrations remain a manual-before-merge action.
- [ ] Future orchestrator reviews and commits scoped implementation files under its own authorization. Finish with release readiness, not automatic release. Parent Task 11 still owns live Meta probes/final hosted CI and complete J1–J10 integration; no live evidence is manufactured here.

**Acceptance:** T8-12, E2, Task 11 traceability. No unreviewed skips, hidden prerequisite failures or “deployed” claim based solely on merged source.

## Validation commands

Run from the implementation worktree. The current document author has **not** run these product suites, because no production/test files were changed. These are implementation gates. Use an installed local toolchain; do not read production secrets to make a local command work.

### V1 — targeted Node/UI tests

```powershell
npm test -- src/features/competitor-tracking
npm test -- src/hooks/__tests__/useBrandScrapeProvenance.test.tsx
npm test -- src/features/instagram-insights
```

Use fixture-driven assertions against exact DTO values, visibility, accessible names, calls and state transitions. Do not inherit the weak “count >=0” checks in existing analytics E2E (`e2e/analytics.spec.ts`) as acceptance.

### V2 — Deno checks and tests

Existing CI permission patterns: `.github/workflows/ci.yml:370` (worker), `:384` (registered route), `:220` (owner report). New tests should mock dependencies and require no live network. Expand the following Bash globs from repo root in Git Bash/WSL/Linux; do not pass literal globs to Windows Deno. Keep permissions scoped further where tests allow.

```bash
deno check --node-modules-dir=none supabase/functions/competitor-tracking-report/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-retention/*.ts
deno check --node-modules-dir=none supabase/functions/competitor-snapshot-sync/*.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/competitor-tracking-report/{handler,reportStore,assemble,growth,weeklyInventory}.test.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/competitor-retention/{handler,run,deps}.test.ts
deno test --node-modules-dir=none --allow-read --allow-env \
  supabase/functions/competitor-snapshot-sync/{graphProvider,apifyProvider,syncWorker,store,handler,sqlContract}.test.ts
deno test --node-modules-dir=none --allow-read --allow-write --allow-env --allow-run \
  supabase/functions/competitor-snapshot-sync/route.test.ts \
  supabase/functions/competitor-tracking-report/route.test.ts \
  supabase/functions/competitor-retention/route.test.ts
deno test --node-modules-dir=none --allow-read=supabase/functions/_shared \
  supabase/functions/_shared/outlierScore.test.ts
deno check --node-modules-dir=none supabase/functions/instagram-insights-report/*.ts
deno test --node-modules-dir=none \
  --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY \
  supabase/functions/instagram-insights-report/*.test.ts
```

Environment permissions permit test-set synthetic values; they do not authorize reading real credentials. Run actual-route tests in a clean local test environment. Add required CI inventories rather than relying on wildcard discovery alone; no `--no-check` bypass for new suites.

### V3 — disposable PostgreSQL baseline plus delta

Use the repository harness (`supabase/tests/README.md:11`, `scripts/db-harness.sh:91`). The committed baseline and all newer migrations are required, not replay of all historic migrations. Register new main suites and explicitly classify the manual retention race fixture. Keep every existing suite.

Example Bash commands for a dedicated local Docker container with no published port/network. `postgres` here is an intentionally disposable fixture password, not a production credential. An immutable archive/copy of the candidate repo may be mounted to avoid running against a changing tree. No Contabo/production connection:

```bash
docker run -d --name postora-task8-sql --network none \
  -e POSTGRES_PASSWORD=postgres -v "$PWD:/repo:ro" \
  supabase/postgres:17.6.1.158 \
  -c cron.database_name=competitor_ui_harness \
  -c shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault
docker inspect --format '{{.State.Health.Status}}' postora-task8-sql
# Continue only after healthy; repeated checks are bounded.
docker exec -e HARNESS_DB_NAME=competitor_ui_harness postora-task8-sql \
  bash -c "cd /repo && bash scripts/db-harness.sh 'postgres://supabase_admin:postgres@localhost:5432/postgres'"
docker exec -i postora-task8-sql psql -U supabase_admin -d competitor_ui_harness \
  -v ON_ERROR_STOP=1 -v disposable=1 \
  -f /repo/supabase/tests/competitor_retention_race_fixture.sql
```

The last command creates synthetic race fixtures; it is **not** the concurrency proof. The new fixture header must provide separate Session A/Session B transactions, actual row-lock wait observation, assertions and cleanup for Task 7's five races. Execute them in two `docker exec -it … psql` sessions against this container, never production. Existing quota and durable-job race fixtures must also be rehearsed when M1/M3 touch their interactions. Record setup and cleanup, not just a final pass label. Remove only the verified dedicated test container when done.

### V4 — full frontend gates

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npm run check:i18n
git diff --check
```

Capture full exits and distinguish pre-existing lint/i18n failures from new diagnostics. If the project's existing immutable-base no-regression gate is needed, run it under its documented contract; never turn a failing full command into “passed” or weaken existing tests to meet this plan.

### V5 — browser and assembled validation

```powershell
npx playwright test e2e/analytics.spec.ts --project=chromium
```

Current config starts `npm run dev` at localhost:8080 (`playwright.config.ts:27`). The new local fixture must point only at synthetic/local endpoints and fail loudly if unavailable. Check 320/375/768/1280px, English/Arabic/RTL, keyboard, focus restoration and 200% zoom. Browser checks use the applicable repository/tool workflow; retain screenshots and assertions for the final implementation revision. Do not call a mocked flow live backend validation.

### V6 — graph and scope

```powershell
graphify update .
git diff --stat
git diff --check
```

Run graph update after implementation code changes even if graph files are already dirty. Review graph artifacts separately; they are not part of the current two-document commit. If CLI remains unavailable, report that limitation, do not claim an update ran.

## Open questions for Waleed

Only one unresolved business choice: maximum permitted staleness S for a follower baseline at/before the 7/30-day cutoff. See [spec §11](../specs/2026-10-30-competitor-ui-and-retention.md#11-open-questions-for-waleed). It gates final Task 2/3 growth acceptance; do not invent a tolerance. Provider provenance, inventory evidence and deployment state are engineering dependencies, not requests to reapprove resolved quotas or deferred scope.

## Documentation-delivery validation and stop boundary

For this authoring task: verify source citations against baseline, the §4 quotation byte-for-byte, cross-document task/acceptance mapping, relative links, migration names and scope; inspect both new files for placeholders/contradictions and run `git diff --check`. Production/test guards have no changed code/tests to process. Named docs-guard was not available; a manual documentation review must be reported as such. Do not run DB harness, provider calls or deployments merely to validate Markdown.

Commit only `docs/specs/2026-10-30-competitor-ui-and-retention.md` and this plan locally using `git commit -- <files>`, with the requested final trailer `Co-Authored-By: Codex <noreply@openai.com>`. Then STOP and report worktree, commit, spec/plan summary, nine tasks, four future migrations and the one business question. No push or PR.
