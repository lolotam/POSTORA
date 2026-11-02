# PR #347: notified initial review round

## Scope and verified causes

This round addresses the 20 inline findings from MergePilot review `5729218727` plus Codex comment `4436463673`. The complete harvest had 183 open threads, so disposition of these 21 does not close the 162 later findings or establish overall release readiness.

Two defects were still present on source `7dc40a5e`: unauthenticated report requests could create one durable audit row per attempt, and the legacy Instagram snapshot could combine cutoff-filtered measurements with later collection status, timestamps or inventory coverage.

The shared `recordSystemAudit` writer now uses the existing `system_logs` primary key to coalesce only unverified requests into source/status/minute slots with atomic ignore-duplicate insertion. Verified user/service events remain individual, metadata stays redacted, and audit failure still returns 503. This is bounded refusal telemetry rather than a per-attempt counter. Both actual report entrypoints consume the writer. The C4 snapshot predicate now bounds the job's creation/update/attempt/success/partial evidence, checkpoint updates and aggregate timestamps by the same `p_as_of` as its measurements.

Changed production files: `_shared/systemLogAudit.ts`, `instagram-insights-report/index.ts`, `meta-owned-analytics-report/index.ts`, and the uninstalled `20261101150000_meta_owned_analytics_reports.sql`. Tests are `instagram-insights-report/auditComposition.test.ts`, the malformed-body regression in `handler.test.ts`, and `supabase/tests/instagram_report_snapshot.sql`. The [report contract](../specs/2026-11-01-meta-owned-analytics-reports.md) owns the resulting behavior.

## Other findings in this notification

- `system_logs` exists in the committed baseline and generated types; its `edge` category and normal levels match the entrypoint. No new audit table is required.
- The eight scanner alerts were checked at their individual original source lines. Seven concern synthetic test secrets; the remaining one is a hard-coded fixture claim UUID. No credential values are reproduced in this record or review replies.
- Inventory truncation was already made terminal after bounded captures. The worker does not indefinitely retry a completed truncated prefix.
- `OwnedAnalyticsScreen` already merges coverage after continuation, preserving genuine metric/inventory gaps. Partial post values retain their numeric rank and coverage label; daily trend cells intentionally exclude the partial aggregate type in both TypeScript and runtime validation.
- JSON null/scalars/arrays return 400 before account storage; the new table-driven regression pins this existing behavior.
- The inactive-account proxy exemption already applies only to Facebook/Threads. Instagram remains on its legacy active-account reader; its unified calendar adoption is explicitly unaccepted. This notification does not widen that contract or claim disconnected Instagram adoption.
- Profile anchors are selected by boundary time and metric key, not array position. SQL aggregate order cannot swap the assembler's current/previous anchors.
- The architecture links were already repaired. The four-agent-document anti-duplication rule is not a prohibition on dated candidate evidence. Frozen deployment manifests remain distinct from the working source, and the n8n audit directs all implementation to the standalone repository without authorizing deletion or recreation of a checkout.

## Executed proof and publication boundary

The new anonymous-audit regression fails against the original Instagram entrypoint, then passes with both current entrypoints. Forty concurrent unauthenticated requests share two source slots; verified invalid requests retain separate events, and a later minute gets another slot. The original snapshot function fails the new real-SQL assertion `future control state is not exposed`; the repaired function passes. These negative controls are retained in `.tmp/` and are not counted as passing suites.

The report directories passed 99 Deno tests /43 steps. Saved report UI and contract parity passed 22 tests. A fresh labelled disposable database passed the baseline plus 152 migrations, 70 baseline SQL suites and one isolated suite during the repair. The final cutoff predicate and expanded fixtures subsequently passed the focused real-SQL snapshot suite. Focused ESLint passed. Source/test/docs guard review traced actual consumers, immutable owner checks, redaction, audit failure handling, malformed bodies and timestamp boundaries.

The worker dependency must be integrated before final publication. Exact-head lint/i18n and final review results belong to the published candidate, not this pre-integration source. Existing graph/cache changes and unrelated untracked files are excluded from scoped commits.

No production SQL, Edge Function deployment, collection, deletion, schedule activation or social publication is authorized by this review. The modified C4 SQL bytes and new shared audit import must enter a newly frozen, separately approved deployment package. The old manifest and earlier canonical journeys do not validate these changed runtime bytes; wider review and release gates remain open.
