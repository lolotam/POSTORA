# Saved Meta analytics: implementation and executed evidence

Source candidate: `9143bb2b14f00e3652bc80b5c0d149cc46aa0a75`, stacked on the C3 worker candidate. This record covers local implementation and preparation, not approval to merge, apply SQL, deploy, repair credentials, collect data or activate schedules. The owner explicitly requested completing missing work before a concrete deployment decision.

## Behavior now implemented

- `meta-owned-analytics-report` reads saved Facebook/Threads measurements and current connection health from one owner-scoped stable SQL snapshot. It makes no provider calls. Missing/failed reads refuse; disconnected/expired accounts retain saved measurements and expose failed health. The exact canonical response is validated without an extra success-envelope property.
- History cursors sign platform, owner, account, frozen period, revision and the original SQL publication tuple. They retain microseconds and reject tampering, changed revision and cross-target/period use. A continuation can finish its original period across midnight.
- Daily coverage counts finite measured cells, preserves actual zero, and does not sum unique counts. Failed permission/credential/provider cells and omitted measurements remain distinct. The last daily bucket must actually exist. A current follower observation is not misrepresented as a historical period total.
- Instagram's legacy report now reads media, daily/profile history and collection state in one stable, structurally scoped SQL snapshot. The reader accepts at most 20,000 rows of each kind and refuses overflow rather than returning a prefix. Legacy DTO/cursor compatibility remains. Requests and I/O are bounded; the actual route records a terminal audit even for refusal.
- Explicit Instagram `analyticsContractVersion: 1` checks caller/account scope and returns `window_mismatch` while the canonical calendar is unverified. Unsupported versions refuse. The legacy DTO is never relabelled as canonical data. The production Instagram performance screen remains on the legacy gateway pending accepted capability evidence.
- Explicit canonical `get_post_analytics` calls for Facebook/Threads use the saved endpoint. Default legacy requests retain their existing paths. A disconnected account is readable through this explicit saved path without reopening legacy live-account fallback.
- Facebook's owned-performance tab and Threads' insights tab use shared account/period controls, metric cards, definition/source/observation details, comparisons, gapped trends and saved posts. Missing/partial/failed states remain visible. Ranking explicitly covers loaded posts and lifetime views only. Refresh reads saved data; it does not enqueue or enable collection.
- Collector partial visits persist a bounded retry time instead of immediately reclaiming the same job. Known target refusals do not consume other accounts' opportunities; unknown database outcomes stop the invocation. Aborted dispatch/drain/retention still attempt their independently bounded terminal audit.

## Proof actually executed

The [proof artifact](evidence/2026-11-01-meta-saved-analytics-proof.json) binds these local results to the source candidate and SHA256 hashes of their local logs. Raw logs stay under `.tmp/`. The fresh C4 rehearsal used the separately inspected `postora-meta-reports-pg-20261101` container, label `postora.task=meta-analytics-history-c2`, database `meta_analytics_reports_harness`, with `cron.launch_active_jobs=off` set before restoration. This separate disposable instance preserved the earlier C2/C3 harness.

| Proof | Result |
|---|---|
| Fresh labelled disposable PostgreSQL, cron launcher off | Baseline + 151 newer migrations; 68 SQL suites and one isolated suite passed. |
| Instagram snapshot bound | 20,000 profile observations readable; 20,001 refuses with `MAH05`; ownership/caller/grant/no-credential checks passed. |
| Real concurrent SQL sessions | 31 cases; 24 actual Lock waits. A separately observed `PgSleep` pause allowed a writer to commit between two reads inside one statement: both retained the original Instagram snapshot; the next statement saw the new media and follower values. |
| Registered worker → real SQL → report → actual proxy | One test / 20 steps passed. Includes zero values, lost-commit resume, independent permission/credential/omission causes, no provider calls during saved reads, foreign acting-owner refusal, expired health retaining history and the six exact inactive schedule bodies. |
| Report/worker/legacy/proxy suite | 151 tests / 82 nested steps passed. Includes ignored cancellation, terminal audits, malformed storage, signed cursor precision/binding and legacy compatibility. |
| Shared/provider regressions | 104 tests / 135 nested steps passed. Direct live endpoints retain their compatibility tests; canonical proxy tests now assert saved routing. A concurrency fixture waits for both network requests to start instead of assuming synchronous fetch invocation. |
| Browser contract/gateway/UI/Instagram route components | Five test files / 28 tests passed. Includes zero/unavailable/partial values, all six sync states, disconnected selection, failed account lookup, continuation conflict and period/account reset. |
| Deno checks, frontend typecheck, build | Passed. Local Deno 2.9.6; hosted CI remains pinned to 2.9.8. Existing build-size warnings remain. |
| Source/test/docs guards | Applied inline. Checked actual production consumers, dependency direction, scope/grants, zero/missing semantics, cancellation, fixture-only writes, compatibility and claims against executed logs. This is an author guard, not an independent review. |
| Immutable lint/i18n regression | No regressions on source `9143bb2b14f00e3652bc80b5c0d149cc46aa0a75` against C3 `067521c9e884f5f5f7d8a41a9c35751ba32cf4a2`, in ordinary, suppressed and inline-disabled lanes. Historical lint/i18n debt remains; this is not a claim that full lint is clean. An initial 40 orphan-translation regression was fixed with statically checked labels before this result. |

The independent database fixture suites were executed sequentially when sharing global test settings. An initial observer-fixture error handling an empty activity field was corrected before the successful 31-case concurrency run. No failed run is represented as a pass. The frontend boundary tests also caught the extra `ok` field in the new response before it was corrected and verified through canonical parsing of real SQL-backed replies.

## Current production readback and remaining work

A new **read-only** production transaction on 2026-11-01 found the C2 history reader, new saved-report reader and Instagram snapshot reader absent. The three requested collection-setting rows and the six new Facebook/Threads schedule names were absent; this is not evidence of an explicit false-valued setting. The collectors refuse missing configuration. The selected owned Facebook and Instagram rows were active but had no protected credential-binding row. Threads does not use that Facebook binding, so its missing row is not itself a Threads defect. No credential or provider token was retrieved or changed.

Still open: accepted Facebook/Instagram protected binding, Instagram capability/calendar evidence and per-metric capture adoption, complete canonical G-X, the remaining per-dependency C3 termination matrix, fully assembled browser journeys, hosted checks/independent review, approved production application/deployment, live reconciliation and seven distinct scheduled due-date successes. Local SQL/handler/component tests are not substituted for those live/browser acceptance records.

The [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) owns the proposed exact artifacts, order, verification and rollback. It is a reviewable **NO-GO** package until its prerequisites are met. No approval for incomplete user-visible delivery is requested by this record. `mem0` tools were unavailable; this durable record preserves the issue, cause, changes and proof for continuation.
