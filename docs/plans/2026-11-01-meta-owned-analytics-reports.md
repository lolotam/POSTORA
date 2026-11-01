# Persisted owned analytics report implementation plan

**Goal:** expose truthful saved analytics through the canonical contract and remove torn Instagram legacy reads before C5 adoption.

**Architecture:** `meta-owned-analytics-report` owns the persisted read use case, decoder, assembly and history cursor; existing live endpoints keep compatibility. Extend platform-owned stable SQL readers with health from the same snapshot. Reuse canonical analytics modules. Execute inline under the already authorized completion task; this plan does not request delegation.

**Tech stack:** PostgreSQL stable security-definer RPCs, Deno/TypeScript, existing Supabase client/auth/logging, Web Crypto HMAC, canonical browser/Edge contract.

**Required reading:** `ARCHITECTURE.md` ??12?17, 23?28, 31?37, 40, 45?46; the [C4 report contract](../specs/2026-11-01-meta-owned-analytics-reports.md); C2 `read_*_analytics_history`; C3 collection continuation; the existing report/proxy/gateway consumers.

## 1. Saved Facebook/Threads reports and history continuation

Files: add `supabase/functions/meta-owned-analytics-report/{index,handler,store,assemble,cursor}.ts` and behavioral tests; add `supabase/migrations/20261101150000_meta_owned_analytics_reports.sql` and `supabase/tests/meta_owned_analytics_reports.sql`; extend database types and CI/harness registration.

- [ ] Start a real SQL test from the labelled disposable harness. Request the exact owner/account through authenticated and service roles; require the missing new report RPC to fail before implementation. Never run fixture writes in production.
- [ ] Add a single-statement owner-scoped read that combines the existing native history reader with safe connection health, preserving the existing structural caller rules and revision/retention failures. No access/refresh token or private credential object enters the report frame.
- [ ] Add a strict decoder for raw daily/post/profile/provenance rows. Missing/error envelopes refuse; they never become empty arrays or zero values.
- [ ] Sign history keysets with Web Crypto HMAC. The validated payload binds platform, owner, account, period, revision and original SQL publication timestamp/post ID. Tests include sub-millisecond ties, changed revision and crossing midnight with the frozen period.
- [ ] Assemble via `analyticsDefinitions`, `summarizeDailyMetricValues`, `metricDelta`, `analyticsSyncState` and `parseAnalyticsReport`. Preserve per-cell causes, partial-day coverage and exact last-bucket semantics. Never sum unique counts or invent prior lifetime observations.
- [ ] Wire the real POST route with existing authentication, restricted CORS, bounded dependencies and one sanitized terminal audit. Prove that read-only reports make zero provider requests and no collection writes.

The new HTTP request is concrete:

```json
{"platform":"facebook","accountId":"<uuid>","periodDays":7,"analyticsContractVersion":1,"cursor":null}
```

## 2. Coherent legacy Instagram and explicit negotiation

Files: extend the same report migration with the bounded owner snapshot; modify `instagram-insights-report/{reportStore,readHistory,handler,index}.ts`, `src/features/instagram-insights/infrastructure/supabaseInstagramInsightsGateway.ts`, its tests and actual composition fixtures.

- [ ] Add a stable owner snapshot of legacy media/daily/profile/collection state with an explicit complete-read bound and no credential columns. Require actual count/ownership/concurrent-writer tests. Preserve default legacy DTO assembly.
- [ ] Replace production multi-statement history traversal with that snapshot and its real SDK adapter. Preserve regression scenarios when adapting obsolete REST fixtures; do not delete incident tests.
- [ ] Add explicit version selection to the real handler/gateway. Unsupported versions refuse. Unknown Instagram calendar/capability evidence refuses truthfully after scope validation; no credential repair or target substitution follows implicitly.
- [ ] Wire verified Instagram per-metric capture/read provenance only when the source contract and evidence actually support it. Missing binding/calendar evidence remains an acceptance blocker, not a synthesized successful report.

## 3. Proxy, integrated proof and C3 continuation

Files: `supabase/functions/n8n-api/serviceProxy.ts` and its compatibility tests; registered real-SQL report/collector integration and C3 termination tests; CI and `docs/journeys/`.

- [ ] Route explicit unified requests for the three platforms to persisted reports, preserving default legacy requests and acting-user propagation. Check each actual upstream request shape and unsupported-version response.
- [ ] Complete true-zero and mixed unavailable worker ? SQL ? report ? proxy journeys with distinct omission, permission, credential, provider and window failures. Cover same-day supersession, partial inventory and retention/revision invalidation.
- [ ] Complete C3 action-specific deadline/unknown-outcome tests using actual handler boundaries, including ignored aborts and shared budgets. Keep unexecuted proof items unchecked.
- [ ] Apply source/test/docs guards; run the fresh SQL harness, affected races, Deno checks/tests, browser parity, frontend typecheck/build and immutable lint/i18n comparison against exact stack base/head. Commit scoped files and update the graph.
- [ ] Push a stacked C4 draft against C3 and link its full URL immediately. Continue C5 UI; do not merge/apply/deploy this stack before the owner's requested concrete package review.

Use the existing disposable container/database identity and cron-off checks from the [C3 plan](2026-11-01-meta-owned-analytics-workers.md#local-evidence-commands). Local Deno availability is 2.9.6; hosted CI remains pinned to 2.9.8. A missing runtime or external import is an unavailable proof, never a pass.
