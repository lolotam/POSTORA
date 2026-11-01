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
| Fresh disposable PostgreSQL | Updated main, including #332, plus C2: repository baseline + 142 migrations + 60 baseline suites + 1 isolated suite passed. Includes HTTP-fence, C2 primary and claim-fairness SQL suites, with the cron launcher disabled before restoration. |
| Real concurrent SQL sessions | 18 cases passed across Facebook/Threads, with 14 actual PostgreSQL Lock waits observed. Covers switch/scope changes in both orders, credentials, collection/retention exclusion and report revision invalidation. |
| Type catalog | C2 table/FK/function blocks refreshed from that applied disposable catalog; frontend typecheck passed. No production catalog or credentials used. |
| Production build | Passed; existing bundle-size warnings remain. |
| Independent reviews | Separate source review of migration/SQL suite and tooling review found no blocking findings. Reviewers did not rerun database suites. Source/test guards applied. |

The primary suite includes failed-before-fix regressions for Facebook's literal Page/post separator and Instagram pending-response/legacy overwrite. It also verifies same-day supersession, exact totals, zero/missing values, follower 24-hour boundaries and deterministic ties, cross-owner/platform FKs, retention cutoff edges, more than 500 historical children, safe partial stops and no-op revisions.

C3 source tracing exposed a claim fairness defect: ordering equal-due jobs only by ID let a partially completed target immediately reclaim ahead of an unvisited account. The new two-owner regression failed on the original Facebook claim, then passed for both platforms after ordering by `due_at, updated_at, id` and using `clock_timestamp()` for force/claim/completion timestamps. The same transaction exercises the complete real admission/permission/enqueue/claim/completion path and proves older due dates still take priority. The full fresh harness and all 18 races (14 observed Lock waits) passed again after that correction. Earlier independent reviews did not cover this later fairness fix; it received the source/test guard pass.

Local logs and JSON reports stay under `.tmp/` and are excluded from commits. The race runner validates the disposable container label, pins its inspected ID, requires a `_harness` database and restores its synthetic settings/owner in cleanup. CI runs the SQL harness first, installs Python inside the disposable Alpine image, then executes the same race runner.

The ordered-lineage rehearsal found the old disposable container's cron launcher enabled. CI now starts PostgreSQL with `cron.launch_active_jobs=off`; the race runner rejects an enabled launcher before mutation setup. The real negative control exited 1 with zero race cases and unchanged owner count/settings fingerprint. Only the validated disposable instance was reconfigured/reloaded before the successful fresh restore and 18-case repeat. No production setting or schedule changed.

Read-only deployment verification at 2026-11-01 10:26:49 UTC also confirmed #329's report `handler.ts`, `index.ts`, `readHistory.ts`, `reportStore.ts` and `contracts.ts` in the production functions volume match main `0183977fe5dca1686ea1604d79a6742e9817a91e` by SHA256. No paused/failed deploy marker was present. This is deployed-byte evidence only, not an owner collection or reconciliation receipt.

## Remaining dependency and release order

The [history/job ADR](../specs/2026-11-01-meta-analytics-history-job-model.md) owns the model. Its five-second per-RPC and forty-second invocation deadlines, plus the shared 50-target/500-child budget across platforms, require C3 orchestration. Function-level `statement_timeout` was experimentally insufficient to enforce that caller deadline; this migration makes no such claim. SQL supplies its per-target remaining-row ceiling and three-second lock timeout.

The five Instagram HTTP fence wrappers in PR #332 merged at `eb3c672693c0c536aac5f326885af64b9b162189` and precede this migration. The updated fresh rehearsal verifies that exact ordered lineage. On explicit owner approval, #332 was applied to production at 10:53:34 UTC: all five service-only INVOKER signatures and PostgREST cache entries were verified; native definitions and rollout/cron fingerprints were unchanged. #333 then merged and deployed at `cc2555b282c1581dde196fd386b3b6d55a0f64ca`, with HTTP 200 health, HTTP 204 sync boot and matching runtime SHA256 files. The [deployment receipt](evidence/2026-11-01-instagram-http-fence-deployment.json) contains the redacted application/cache/runtime evidence.

Merge/application of **C2** schema still requires separate approval and actual deployed catalog/ACL verification before dependent runtime adoption. Approval/application of #332 did not include C2 or activation. C3 workers and inactive cron definitions, C4 persisted endpoints/version negotiation, C5 unified UI and live pilot reconciliation/stability are not delivered by this schema candidate.
