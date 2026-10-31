# Meta analytics completion — implementation plan

**Spec:** [`docs/specs/2026-11-01-meta-analytics-completion-design.md`](../specs/2026-11-01-meta-analytics-completion-design.md). Section references (§) point there.
**Required reading for every task and every delegation brief:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (layering, Edge Function shape, security rules), the spec, and for Batch A [`docs/specs/2026-10-30-instagram-release-gates.md`](../specs/2026-10-30-instagram-release-gates.md).

Three batches, in order. A batch starts only when the previous batch's exit criteria are met, except where a task is marked *parallel*.

## Conventions for every task

- Feature branch from `origin/main` created with `--no-track`; scoped commits (`git commit -- <files>`).
- Tests first where behaviour changes; `clean-code-guard` on production code, `test-guard` on tests, `docs-guard` on docs.
- Gates: relevant `deno test` suites, Node/Vitest suites, SQL tests for migrations, `npx tsc --noEmit`, `npm run build`, `node scripts/ci/lint-i18n-regression.mjs`.
- Edge deploys only via `docs/runbooks/deploy-edge-function.md`. Never `npx supabase functions deploy`.
- No change to collection switches, allow-lists, cron activation, credentials or applied migration bytes unless the task says so **and** the owner approves at that moment (spec §12).
- New user-facing strings in both Arabic and English.

---

## Batch A — Instagram defects, correct totals, pilot

### A1. Merge #326
Review [PR #326](https://github.com/lolotam/POSTORA/pull/326), rebase on `main`, rerun its tests and gates, merge, let the frontend deploy. Does not enable collection.
**Done:** merged; deployed frontend shows the translated `collection_disabled` reason.

### A2. Service-role 401 in `instagram-insights-report`
- Files: `supabase/functions/instagram-insights-report/index.ts`; reuse `supabase/functions/_shared/auth-helper.ts` (`authenticateCaller(req, bodyUserId)`), the same pattern as the helper's own body-parsing wrapper at `auth-helper.ts:96-97`.
- Read the body once; pass a UUID-validated `user_id`; keep the handler's structural ownership lookup.
- Tests (through the real composition root, not an injected auth stub): service-role + owned account → 200; service-role + foreign `social_account_id` → non-enumerating 404; user JWT with a different body `user_id` → JWT identity wins; missing body `user_id` with service role → 401.
- Deploy the function per runbook.
**Done:** the read-only service-role probe from the status review returns 200 for the owned account.

### A3. Cursor contract
- Files: `supabase/functions/instagram-insights-report/contracts.ts` (owns the codec), `handler.ts` (`parseCursor`), `src/features/instagram-insights/infrastructure/supabaseInstagramInsightsGateway.ts`.
- One field naming (`publishedAt`/`mediaId`), one encode/decode; the gateway stops hand-building `published_at`/`media_id`.
- Boundary test: gateway-encoded cursor parsed by the handler; malformed cursor → 400.

### A4. Pagination
- Files: `src/features/instagram-insights/ui/InstagramPerformanceScreen.tsx`, `MediaPerformanceTable.tsx`, the report query hook.
- Infinite query keyed by account + period; `onLoadMore` passed only when a next cursor exists.
- Tests: two pages accumulate in order, no duplicate media ids, button hidden at end, period change resets pages.

### A5. Correct totals
- File: `src/features/instagram-insights/ui/MetricsOverviewCards.tsx` (+ domain helper).
- Stop labelling summed daily reach as unique accounts; period reach comes from a provider period total or is shown as daily-sum with its own label; totals with missing days show coverage (`partial`).
- Tests: all days present; some days missing; no days; zero values vs missing values.

### A6. Release-gate artefacts (owner analytics only)
Create the artefacts the status review lists as missing: `scripts/check-instagram-release-gates.mjs`, `e2e/fixtures/instagramReleaseServer.ts`, `e2e/fixtures/instagramReleaseSeed.ts`, `docs/runbooks/instagram-insights-release.md`. Scope them to owner analytics; competitor checks are excluded (spec §5.6).

### A7. Pilot — owner-approved operations
Gates by name from the release-gates spec §6: **B1** (manifest and preflight), **B2** (deployment — separate approval), **B3** (pilot user list), **C1–C2** (reconnect; session/refresh regression), **C3** (harmless test post — separate approval), **D1** (one-account eligibility from the rollout-controls work, with its RC evidence), **D2** (collect for one named owner account; prove zero provider calls for every other target). D3 (competitor) and E are out of scope.
Each step: approval → action → query evidence → record in the runbook.

### A8. Reconciliation
Compare 7 closed days for the pilot against Meta using spec §9 tolerances; then run the 7-day stability gate (§9). Record results in `docs/journeys/`.

**Batch A exit:** A1–A8 done; pilot stable and reconciled; rollback verified once (switch off → zero new writes).

---

## Batch B — Facebook/Threads verification and the metric contract

### B1. Contract package *(parallel with Batch A)*
- Files: `src/features/analytics-contract/domain/{types,registry,period,delta}.ts`, `supabase/functions/_shared/analyticsContract.ts`.
- Implements spec §4: `MetricValue` with `available | partial | unavailable(reason)`, registry entry fields, `not_summable` rule, period/previous period, delta rules (including previous `0`), sync status, `schemaVersion`.
- Tests: unavailable never aggregates to `0`; partial coverage; `not_summable` refuses summing; delta cases; parity test comparing frontend and Deno exports (keys, statuses, version).

### B2. Capability probes
- A read-only probe per platform (script under `scripts/probes/` calling the Graph APIs with a stored token fetched server-side, or a service-role-only function action), producing a JSON + Markdown evidence record under `docs/journeys/` with the fields in spec §6. Tokens are never printed.
- Facebook: Page token, `/{page-id}/insights` and `/{post-id}/insights` at the pinned Graph version; record deprecated metrics and replacements from current Meta documentation; granted scopes via token debug.
- Threads: account and post insights, listing pagination, earliest available date per metric, maximum window.
- Run only against owner-approved accounts (spec §12).
**Done:** evidence committed; registry cells move from `unverified` to proven `available`/`not_offered`.

### B3. Threads live path correctness
- File: `supabase/functions/threads-insights/index.ts` (split into handler + provider adapter per `ARCHITECTURE.md` if the file shape requires it).
- Account selection: requested `accountId` missing/inactive/foreign → rejected, DB error → 5xx, no fallback, provider not called.
- Decoding: missing metric, failed previous period, one failed post → `unavailable` in the new versioned response; multi-day series preserved.
- Bounds: page, call and time budget under 45 s; per-call timeout; parallelism cap; throttling → `retryAt`; opaque continuation cursor.
- **Compatibility:** the current response stays the default; the contract shape is returned only when the request asks for `schemaVersion: 1` (spec §4.6). `ThreadsInsightsPanel` and `serviceProxy.ts` keep working unchanged; compatibility tests for both shapes.
- Tests at the endpoint: foreign/inactive/failed-read account, missing metric, failed comparison, single post failure, budget exceeded, repeated cursor.

### B4. Facebook owned-Page insights read adapter
- New function (for example `facebook-page-insights`) using the stored Page token, mapping proven metrics to the contract; `brand-scrape` unchanged.
- Ownership checked structurally; service-role identity handled as in A2.
- Tests: owned/foreign/inactive Page, missing permission → `permission_missing`, outside retention, provider error.

### B5. Registry update
Fill the spec §4.3 mapping table and the registry from B2 evidence; update the spec in the same PR.

**Batch B exit:** contract merged with parity tests; evidence records for both platforms; Threads and Facebook live paths return the versioned contract without breaking current consumers.

---

## Batch C — history and unified UI

### C1. Job-model decision record
Before any migration, a short ADR in `docs/specs/` choosing spec §8.2 option (a) or (b), based on `instagram_durable_collection_jobs.sql` and `instagram-insights-sync/workerStore.ts`. It lists which TypeScript modules are platform-neutral and reused, and the platform-isolation, fencing and reconnect tests required.

### C2. Migrations (owner approval to merge and to apply)
Additive migrations for spec §8.1 tables (daily, post snapshots, profile observations) for Facebook and Threads, plus the job model chosen in C1, switches defaulting to `off`, empty allow-lists, cron entries created inactive, retention policy. SQL tests: RLS deny-by-default, owner-only reads, grants, whitelist refusal, concurrency/fencing, platform isolation.

### C3. Sync workers
Per-platform provider adapters and workers reusing the platform-neutral modules from C1; budgets, throttles, receipts and retries as in Instagram. Tests mirror `instagram-insights-sync/*.test.ts` coverage (worker, store, rollout, termination).

### C4. Report functions
Per-platform report endpoints returning the contract (§8.3), ownership per request, service-role identity as in A2, cursor codec as in A3. Proxy (`serviceProxy.ts` `get_post_analytics`) gains a Facebook branch behind the versioned contract.

### C5. Unified UI
Shared components under `src/features/analytics-contract/ui/` (account/period picker, summary cards, trends, top posts, sync-status banner, metric definition tooltip). Instagram, Facebook and Threads screens migrate to them; the Threads panel moves to the versioned response, after which the legacy shape can be retired in a separate change. Component tests for every `MetricValue` status and sync status.

### C6. Pilot per platform (owner-approved operations)
For Facebook, then Threads: deploy (approved) → enable one named pilot target → stability gate and reconciliation (spec §9) → widen only with a separate approval. Rollback rehearsed once per platform.

### C7. Acceptance journeys and handover
Run spec §10 journeys per platform on production; write the user-facing journey in `docs/journeys/`; update the status review.

**Batch C exit = spec §1 completion criterion.**

---

## Codex review (round 1)

Reviewer: Codex CLI 0.166.0, model `gpt-6.1-sol`, reasoning `high`, read-only sandbox, one round, on the first draft of this plan. Verdict: **approve-with-changes**. Every objection was checked against the cited source before acceptance; Codex could not reach Meta documentation (HTTP 429), so Meta-side claims are delegated to the B2 probe instead of being asserted here.

| # | Severity | Objection | Decision | Change made |
|---|---|---|---|---|
| 1 | major | Facebook metric validity (deprecations, replacements) unproven; requested scopes ≠ granted. | Accepted | B2 records per-version metric validity and granted scopes; registry cells start `unverified` (spec §4.3, §6). |
| 2 | major | Threads `7/14/30/90` options are not retention evidence; previous period can fall outside retention. | Accepted | `outside_retention` reason; B2 records earliest date and max window; delta rule (spec §4.1, §4.4). |
| 3 | major | Threads live path turns missing metrics and failures into `0` (`threads-insights/index.ts:196`, `:220`, `:252`). | Accepted | B3 fixes decoding first, with tests per failure case. |
| 4 | major | IG overview sums daily reach as "unique accounts" and shows totals from partial days (`MetricsOverviewCards.tsx:33`, `:65`). | Accepted | New task A5, precondition of the pilot. |
| 5 | major | Binary available/unavailable loses partial/truncated/retry semantics; missing unit, level, window, aggregation; views vs impressions. | Accepted | `partial` status, registry fields, `not_summable`, separate `views`/`impressions` (spec §4.1–4.2). |
| 6 | major | Proposed FB/Threads schema lacks point-in-time follower observations. | Accepted | Profile observation tables; growth from two observations (spec §8.1). |
| 7 | major | IG job SQL and worker store are Instagram-only (`20261026150000_…sql:432`, `workerStore.ts:854`); "don't edit applied bytes" is not the reuse criterion. | Accepted | C1 decision record before migrations; options (a)/(b) in spec §8.2. |
| 8 | major | `threads-insights` falls back to another account when the requested one is missing or the read fails (`index.ts:101-114`). | Accepted | B3 account-selection rules and endpoint tests. |
| 9 | major | Adding paging to the sequential, timeout-less live path risks unbounded work vs the 45 s proxy timeout. | Accepted | B3 budgets, timeouts, parallelism cap, opaque continuation (spec §7). |
| 10 | major | Changing the Threads response in B before the UI migrates in C breaks `ThreadsInsightsPanel` and the proxy. | Accepted | Versioned response, legacy default, compatibility tests (spec §4.6, B3, C5). |
| 11 | major | "N days" gates are undecidable; no budget, stop conditions or rollback. | Accepted | Numeric tolerances, 7-day stability gate, stop conditions, rehearsed rollback (spec §9). |
| 12 | minor | Calling gates B–D wholesale pulls in competitor step D3 and hides separately approved steps. | Accepted, corrected | A7 names B1–B3, C1–C3, D1–D2 only. Codex placed the deploy approval in C3; the gate text puts deployment in B2 and a test post in C3, so both are listed as separate approvals. |
