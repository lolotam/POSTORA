# Owned Meta analytics history: C2 schema candidate

Status: schema implementation and isolated proofs prepared for review. C2 acceptance remains open: inactive collection/retention cron definitions await C3's reviewed worker/HTTP contract. This record does not approve migration merge/application, production credentials, collection, retention, schedules or pilots. Full Instagram G-X remains required.

## Delivered behavior

`20261101130000_meta_owned_analytics_history.sql` adds 26 platform-owned history, job, operation, checkpoint, capture, permission and report-state tables, plus their constrained service RPCs and private helpers. Composite ownership/platform keys prevent cross-account attachments even under the service role. Raw tables are unavailable to browsers; direct service mutations are revoked in favor of fenced writers. New collection and retention switches remain false and account allow-lists empty.

Facebook reuses existing connection authority and Page credentials. Threads gains a monotonic credential epoch. Latest reservations supersede older pending responses, matching replays are idempotent, and stale claims/authority cannot publish. Reports use one revision-bound database read; a changing revision invalidates continuation. Daily windows, capture dates and exact 7/30-day totals remain distinct. Missing metrics retain their reason instead of becoming zero.

The additive Instagram compatibility path preserves provider windows/provenance and invalidates sidecar captures when a later legacy write changes the source. A database-authored private digest prevents a pending compatibility response from overwriting a newer accepted legacy result. Default legacy callers are preserved.

Retention uses independent scope, parent-first fences and live-lease exclusion. Dry runs do not delete or advance revisions. Child-first partial batches retain immediate FK validity, provider-window overlaps and deterministic valid follower anchors. Every physical child deletion consumes the shared caller-supplied remaining-row budget.

## Executed proof, 2026-11-01

| Boundary | Result |
|---|---|
| Fresh disposable PostgreSQL | Repository baseline + 141 migrations + 58 baseline suites + 1 isolated suite passed. Includes the C2 primary SQL suite. |
| Real concurrent SQL sessions | 18 cases passed across Facebook/Threads, with 14 actual PostgreSQL Lock waits observed. Covers switch/scope changes in both orders, credentials, collection/retention exclusion and report revision invalidation. |
| Type catalog | C2 table/FK/function blocks refreshed from that applied disposable catalog; frontend typecheck passed. No production catalog or credentials used. |
| Production build | Passed; existing bundle-size warnings remain. |
| Independent reviews | Separate source review of migration/SQL suite and tooling review found no blocking findings. Reviewers did not rerun database suites. Source/test guards applied. |

The primary suite includes failed-before-fix regressions for Facebook's literal Page/post separator and Instagram pending-response/legacy overwrite. It also verifies same-day supersession, exact totals, zero/missing values, follower 24-hour boundaries and deterministic ties, cross-owner/platform FKs, retention cutoff edges, more than 500 historical children, safe partial stops and no-op revisions.

Local logs and JSON reports stay under `.tmp/` and are excluded from commits. The race runner validates the disposable container label, pins its inspected ID, requires a `_harness` database and restores its synthetic settings/owner in cleanup. CI runs the SQL harness first, installs Python inside the disposable Alpine image, then executes the same race runner.

## Remaining dependency and release order

The [history/job ADR](../specs/2026-11-01-meta-analytics-history-job-model.md) owns the model. Its five-second per-RPC and forty-second invocation deadlines, plus the shared 50-target/500-child budget across platforms, require C3 orchestration. Function-level `statement_timeout` was experimentally insufficient to enforce that caller deadline; this migration makes no such claim. SQL supplies its per-target remaining-row ceiling and three-second lock timeout.

The five Instagram HTTP fence wrappers in PR #332 precede this migration. The current fresh harness used main plus this C2 candidate; #332 is not yet merged, so the complete ordered lineage must be rerun after that schema layer lands. Merge/application of schema requires separate approval and actual deployed catalog/ACL verification before dependent runtime adoption. C3 workers and inactive cron definitions, C4 persisted endpoints/version negotiation, C5 unified UI and live pilot reconciliation/stability are not delivered by this schema candidate.
