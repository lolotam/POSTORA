# Meta analytics completion — implementation plan

**Spec:** [`docs/specs/2026-11-01-meta-analytics-completion-design.md`](../specs/2026-11-01-meta-analytics-completion-design.md). Section references (§) point there.
**Required reading for every task and every delegation brief:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §§4, 10–17, 22–24, 27–28, 31–34 and 36–39 (dependencies, adapters, authentication, contracts, storage, scheduling, testing and compatibility), the spec, and for Batch A [`docs/specs/2026-10-30-instagram-release-gates.md`](../specs/2026-10-30-instagram-release-gates.md).

Three batches, in order. A batch starts only when the previous batch's exit criteria are met, except where a task is marked *parallel*. Independent corrections to existing read paths may proceed while Instagram's pilot observation is pending; this does not waive capability evidence, migration ordering or platform activation prerequisites.

## Conventions for every task

- Feature branch from `origin/main` created with `--no-track`; scoped commits (`git commit -- <files>`).
- Tests first where behaviour changes; `clean-code-guard` on production code, `test-guard` on tests, `docs-guard` on docs.
- Gates: relevant `deno test` suites, Node/Vitest suites, SQL tests for migrations, `npm run typecheck`, `npm run build`, `node scripts/ci/lint-i18n-regression.mjs`.
- Edge deploys only via `docs/runbooks/deploy-edge-function.md`. Never `npx supabase functions deploy`.
- No change to collection switches, allow-lists, cron activation, credentials or applied migration bytes unless the task says so **and** the owner approves at that moment (spec §12).
- New user-facing strings in both Arabic and English.

---

## Batch A — Instagram defects, correct totals, pilot

### A1. Merge #326
Review [PR #326](https://github.com/lolotam/POSTORA/pull/326), resolve valid findings, update from `main` only if needed, rerun its tests/gates on the final head, merge, and verify the deployed frontend. Does not enable collection.
**Done:** merged; deployed frontend shows the translated `collection_disabled` reason.

### A2. Service-role 401 in `instagram-insights-report`
- Files: `supabase/functions/instagram-insights-report/index.ts`; reuse `supabase/functions/_shared/auth-helper.ts` (`authenticateCaller(req, bodyUserId)`), the same pattern as the helper's own body-parsing wrapper at `auth-helper.ts:96-97`.
- Read the body once; pass a UUID-validated `user_id`; keep the handler's structural ownership lookup.
- Tests (through the real composition root, not an injected auth stub): service-role + owned account → 200; service-role + foreign `social_account_id` → non-enumerating 404; user JWT with a different body `user_id` → JWT identity wins; missing body `user_id` with service role → 401.
- Local implementation and tests only. Its immutable candidate is deployed during A7/B2, after B1 evidence and B2's separate approval; A2 authorizes no early runtime change.
**Done locally:** real-composition regression tests pass. **Live acceptance, deferred to A7/B2:** the approved read-only service-role probe returns 200 for the owned account after deployment.

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
- Unique `reach` requires an exact provider period total or is `unavailable`; daily reach is never summed, and no daily-sum reach metric is added. Summable metrics use per-metric coverage; a present daily row with a missing metric still leaves that metric partial/unavailable.
- Tests: all metric values present; rows present but some metric values missing; missing days; no values; true zero versus unavailable; unique-reach summing rejected.

### A6. Release-gate artefacts (owner analytics only)
Create distinctly scoped artifacts: `scripts/check-instagram-owner-analytics-gates.mjs` with adjacent tests, `e2e/fixtures/instagramOwnerReleaseServer.ts`, `e2e/fixtures/instagramOwnerReleaseSeed.ts`, and `docs/runbooks/instagram-owner-analytics-release.md`. They cover owner readiness only and must identify themselves as such in their output.

They do **not** implement or pass the canonical `scripts/check-instagram-release-gates.mjs` G-X gate. Its full acceptance inventory, including unresolved competitor work, remains fail-closed and unchanged. A7 is blocked until the authoritative release prerequisites pass or Waleed explicitly approves a scope amendment in the owning release-gates specification. This plan does not grant that amendment or mark competitor acceptance passed.

The [recorded owner decision](../specs/2026-10-30-instagram-release-gates.md) retains the complete G-X gate before the owner pilot. No limited exception was approved; A7 remains blocked by the full gate.

### A7. Pilot — owner-approved operations
After the A6 prerequisite decision, gates by name from the release-gates spec §6: **B1** (manifest/preflight for the frozen A2–A5 candidate), **B2** (deploy that reviewed candidate — separate approval), **B3** (pilot user list), **C1–C2** (reconnect; session/refresh regression), **C3** (test post — separate approval), **D1** (RC-proven target admission), and **D2** (one named owner; zero provider calls for others).
Each step: approval → action → query evidence → record in the runbook.

**Proposed pilot-only schedule approval, separate from D2 and not a completion claim for canonical E2:** before A8's stability window, obtain approval for the exact `instagram-insights-enqueue-daily` and `instagram-insights-drain` cadences, candidate, one-account allow-list and window. Record the prerequisite scope amendment where required by the authoritative gates, prove other owners and all competitors remain excluded, then activate only those two jobs. Capture their active flags and seven expected collection due dates. D3 competitor collection, E1 cohort widening and E3 competitor retention remain out of scope; canonical E2 wider-cohort/scale acceptance remains pending. Rollback deactivates both jobs and disables pilot collection, with query evidence of zero further writes.

### A8. Reconciliation
Compare 7 closed days using the exact period/bucket semantics in spec §4.4 and tolerances in §9. Stability starts only after A7's separate schedule approval/activation; require seven distinct scheduled due-date receipts, not zero runs or seven retries of one run. Record expected/actual runs, outcomes, continuation/backoff, non-pilot exclusions and rollback evidence in `docs/journeys/`.

**Batch A exit:** A1–A8 done; pilot stable and reconciled; rollback verified once (switch off → zero new writes), then separately approved restoration of the same frozen candidate, switch/allow-list and exact enqueue/drain jobs. Verify active settings, one successful post-restoration scheduled receipt and zero non-pilot writes. A rehearsed rollback left disabled does not meet completion; widening remains unapproved.

---

## Batch B — Facebook/Threads verification and the metric contract

### B1. Contract package *(parallel with Batch A)*

**Current implementation candidate:** canonical calendar, contract, registry and serialized validator are runtime-neutral modules in `supabase/functions/_shared/`, consumed by the explicit Threads report and re-exported by the browser facade. Behavioral/parity coverage includes closed DST calendars, zero/unavailable/partial values, metric definitions, comparisons, observation times and persisted freshness. This supersedes the partial B1 foundation proposed in #331; reconcile that overlapping PR before merging it. The candidate remains local until its own review/checks/deployment are recorded.
- Files: `src/features/analytics-contract/domain/{types,registry,period,delta}.ts`, `supabase/functions/_shared/analyticsContract.ts`.
- Implements spec §4: metric statuses, explicit registry capability/evidence fields, `capability_unverified` versus `not_collected`, per-metric coverage, `not_summable`, exact calendar/bucket boundaries, deltas, sync status and distinct `analyticsContractVersion: 1`.
- Tests: unavailable never becomes `0`; rows present with missing metrics remain incomplete; true zeros; capability-state mapping; no unique-reach sums; timezone/boundary/DST cases; deltas; frontend/Deno parity of keys, statuses and version discriminator.
- Parity compares the complete serialized schema/registry and shared behavioral fixtures as required by spec §4; limited key/status equality cannot pass. Include the platform `staleAfterSeconds` scope, unit and boundary cases.

### B2. Capability probes

**Tooling slice:** the [read-only Facebook/Threads probe runbook](../runbooks/meta-owned-analytics-capability-probe.md) describes the bounded server-side CLI and its local safety tests. Candidate metrics remain unverified. Approved live account selection, actual provider observations, exact timezone/retention/window evidence and the Instagram credential-context probe remain pending; the tooling alone does not satisfy B2.
- A read-only probe per platform (script under `scripts/probes/` calling the Graph APIs with a stored token fetched server-side, or a service-role-only function action), producing a JSON + Markdown evidence record under `docs/journeys/` with the fields in spec §6. Tokens are never printed.
- Facebook: Page token, `/{page-id}/insights` and `/{post-id}/insights` at the pinned Graph version; record deprecated metrics and replacements from current Meta documentation; granted scopes via token debug.
- Threads: account and post insights, listing pagination, earliest available date per metric, maximum window.
- Instagram: account/media metrics, exact-period reach, daily boundaries, follower observations and pagination. Reuse A7/A8 evidence only for the individual cells whose full §6 fields it proves; probe the remainder. All three platforms need verified registry evidence before unified UI adoption.
- Run only against owner-approved accounts (spec §12).
- Negative expired/revoked-token and missing-permission cases use sanitized fixtures through the real adapter boundary. Existing live negative states may be observed; creating one requires the separately approved disposable-account/recovery procedure in spec §6 and is not part of the read-only probe.
**Done:** evidence committed; registry cells move from `unverified` to proven `available`/`not_offered`.

### B3. Threads live path correctness

**Account-selection slice implemented locally:** the [executed regression and behavior record](../journeys/2026-11-01-threads-account-selection.md) covers explicit-selector refusal, failed-read handling, input validation and JWT identity precedence. This is an independent correctness repair; B3 remains incomplete until the versioned metric semantics, time/call bounds and pagination below pass.

**Provider-bounds slice implemented locally:** the [provider correction record](../journeys/2026-11-01-threads-provider-bounds.md) covers the production-consumed bounded transport, response validation, token-identity refusal, throttle parking, bounded post concurrency and sanitized failures. Legacy response compatibility is retained; the unified metric semantics and continuation pagination below remain open. This does not establish a measured end-to-end proxy deadline or any live API capability.
- File: `supabase/functions/threads-insights/index.ts` (split into handler + provider adapter per `ARCHITECTURE.md` if the file shape requires it).
- Account selection: requested `accountId` missing/inactive/foreign → rejected, DB error → 5xx, no fallback, provider not called.
- Decoding: missing metric, failed previous period, one failed post → `unavailable` in the new versioned response; multi-day series preserved.
- Bounds: page, call and time budget under 45 s; per-call timeout; parallelism cap; throttling → `retryAt`; opaque continuation cursor.
- **Compatibility:** the current response stays the default; the unified shape is selected only by `analyticsContractVersion: 1` (spec §4.6), which is distinct from Instagram's legacy `schemaVersion: 1`. `ThreadsInsightsPanel` and `serviceProxy.ts` keep their old requests until migrated. Tests cover legacy/default, explicit unified and unsupported-version requests for both paths.
- Tests at the endpoint: foreign/inactive/failed-read account, missing metric, failed comparison, single post failure, budget exceeded, repeated cursor.

### B4. Facebook owned-Page insights read adapter
- New function (for example `facebook-page-insights`) using the stored Page token, mapping proven metrics to the contract; `brand-scrape` unchanged.
- Ownership checked structurally; service-role identity handled as in A2.
- Tests: owned/foreign/inactive Page, missing permission → `permission_missing`, outside retention, provider error.

### B5. Registry update
Fill the spec §4.3 mapping table and the registry from B2 evidence; update the spec in the same PR.

**Batch B exit:** contract merged with parity tests; capability evidence for all three platforms; Threads and Facebook live paths return the versioned contract without breaking current consumers. Instagram endpoint adoption is explicitly implemented in C4 before C5.

---

## Batch C — history and unified UI

### C1. Job-model decision record
The ADR also defines spec §8.2's exact-period business key, concrete storage/indexes and same-day capture fencing before migrations; overlapping 7/30-day totals must never collide.

Before any migration, a short ADR in `docs/specs/` chooses spec §8.2 option (a) or (b), based on the actual Instagram durable-job migration and `instagram-insights-sync/workerStore.ts`. It lists platform-neutral modules, business keys/indexes and capture-ID ownership from §8.1, retention cutoff and anchor preservation, exact lock/fence/deletion order and batch limits, plus platform-isolation, fencing, reconnect, retry-idempotency and retention/report race tests. C2 is blocked until this ADR is reviewed; omitted cleanup details are not left to migration-time guesses.

### C2. Migrations (owner approval to merge and to apply)
Implement C1's concrete per-metric state/reason/source/window representation from spec §8.1 for all measurement kinds, including the additive Instagram extension required for C4. Worker → database → report tests preserve omitted, permission, credential and provider-failure causes independently within otherwise successful rows; true zero stays available. Row status plus nullable metric columns alone cannot satisfy this requirement.

Additive migrations for spec §8.1 tables and reviewed C1 model: enforce the declared daily/post/capture uniqueness keys, owner-first indexes, composite ownership/platform foreign keys, current-claim/generation write fences, and the 365-day retention cutoff with its profile anchor. Switches default off, allow-lists are empty, and collection/retention cron entries are created inactive. SQL tests cover RLS/grants, cross-owner and platform isolation, duplicate response writes, same-day recapture, stale retries, deterministic follower-boundary selection, retention edges/anchors and races against active collection/reporting. Retention activation needs a reviewed dry run and a separate later approval.

### C3. Sync workers
Per-platform provider adapters and workers reusing the platform-neutral modules from C1; budgets, throttles, receipts and retries as in Instagram. Tests mirror `instagram-insights-sync/*.test.ts` coverage (worker, store, rollout, termination).

### C4. Report functions
Per-platform report endpoints returning the contract (§8.3), ownership per request, service-role identity as in A2, cursor codec as in A3. Proxy (`serviceProxy.ts` `get_post_analytics`) gains a Facebook branch behind the versioned contract.

Instagram's `instagram-insights-report`, gateway and proxy explicitly gain `analyticsContractVersion: 1` negotiation before C5. Preserve the default legacy DTO; reject unsupported versions. Map verified capabilities and C2's per-metric provenance, and leave missing exact-period totals unavailable. Tests cover real endpoint/proxy legacy, unified and unsupported-version paths; UI adoption cannot precede this task.

### C5. Unified UI
Shared components under `src/features/analytics-contract/ui/` (account/period picker, summary cards, trends, top posts, sync-status banner, metric definition tooltip). Instagram, Facebook and Threads screens migrate to them; the Threads panel moves to the versioned response, after which the legacy shape can be retired in a separate change. Component tests for every `MetricValue` status and sync status.

### C6. Pilot per platform (owner-approved operations)
Before activating schedules, separately approve and execute the exact platform-switch change and the addition of the one named target to its empty allow-list. Read back both settings and prove non-pilot targets remain excluded. Target selection alone does not enable collection.

For Facebook, then Threads: approve and deploy the reviewed candidate; separately approve one named pilot target; separately approve and activate the exact per-platform daily-enqueue/drain jobs before starting the stability window. Each schedule manifest records real cron names/cadences, candidate and account scope, timezone, the seven expected due dates, run/receipt evidence and provider budgets; blank manifests block activation. Require seven distinct scheduled due-date successes (not zero runs or duplicate retries), reconciliation under spec §9, and zero non-pilot writes. Retention remains off unless separately approved after its dry run. Rehearsed rollback disables the platform switch/eligibility and deactivates its enqueue/drain jobs, then proves inactivity/no further writes. Widening remains a separate approval.

### C7. Acceptance journeys and handover
Before C7, separately approve and execute restoration after the C6 rollback rehearsal: same reviewed candidate, named target, platform switch, allow-list and exact enqueue/drain schedules. Verify active flags, one successful post-restoration scheduled receipt and zero non-pilot writes. Disabled collection after rehearsal cannot satisfy Batch C exit; widening is still a separate approval.

Run the approved production pilot journeys in spec §10 plus isolated fixture journeys for missing/expired/revoked permission states. Do not alter pilot credentials to manufacture failures. Any optional live destructive negative case requires the dedicated disposable-account approval and recovery procedure. Record fixture versus live evidence separately, write the user-facing journey in `docs/journeys/`, and update the status review.

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

## PR #328 review corrections

The Codex record above describes its original draft review. Subsequent GitHub findings were verified against this plan, its spec, the existing owner DTO and the authoritative release gates; the following corrections supersede the original draft's wording without claiming a fresh independent approval.

| Verified finding group | Correction |
|---|---|
| A2 deployment preceded B1/B2 | A2 is local-only; live deployment/probe acceptance moves to A7/B2 after B1 and separate approval. |
| Owner-only artifacts reused canonical G-X names | Distinct owner-only checker/fixtures/runbook; canonical G-X retains its full fail-closed inventory. A7 requires satisfied authoritative prerequisites or an explicit approved scope amendment. |
| Stability could pass with no schedules | Separate pilot-only schedule approval/activation in A7 and C6, exact manifests, seven distinct due-date receipts, missed-day refusal and verified deactivation rollback. No implicit E2 completion or cohort widening. |
| Unified version collided with legacy owner DTO | `analyticsContractVersion: 1` negotiation; legacy `schemaVersion: 1` remains unchanged. |
| Coverage counted rows, period edges were ambiguous, reach could be summed | Per-metric finite-value coverage, explicit closed-day `[since, until)` calendar/timezone contract, no prorating provider buckets, and unique reach from an exact provider total only. |
| Storage keys, follower selection and retention were unspecified | Business uniqueness/indexes, capture-response idempotency, current-claim fences, deterministic boundary samples, 365-day cutoff/anchor policy and a required C1 locking/deletion ADR before migrations. |
| Capability verification was conflated with collection state | Explicit registry capability/evidence fields and `capability_unverified` reason. |
| Read-only probes/journeys forced live grant changes | Fixture negative tests by default; pre-existing live negatives may be observed, while any deliberate live mutation needs a separately approved disposable account and recovery procedure. |
| Rollback ended with collection disabled; Facebook/Threads targets never enabled | C6 explicitly changes the approved switch/allow-list before schedules. Batch A/C completion additionally requires separately approved restoration, active-setting evidence and a successful post-restoration scheduled receipt. |
| Instagram had no capability evidence or unified endpoint task | B2/B5 cover all three platforms; C4 implements Instagram endpoint/gateway/proxy version negotiation before C5 migration. |
| Nullable measurements lost individual failure causes and credential errors | Spec §4 adds `reauth_required`; §8.1 and C1/C2 require durable per-metric provenance, including additive Instagram support and worker/database/report round-trip tests. |
| Contract parity, freshness, exact-period keys and reconciliation still had gaps | Full schema/registry parity plus shared behavior fixtures; explicit stale-age scope and threshold; exact-period identity in C1; deterministic count/percentage/observation comparisons; retries must finish before the next due date. Retention activation remains a separate decision. |
| Successful jobs were conflated with available metric values | Spec §10 permits verified unsupported/outside-retention cells without fabricating values, blocks expected uncollected/unverified or permission/credential failures, bounds provider-error recovery, and requires reconciled supported account/post measurements. |
