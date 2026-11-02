# PR #346: bounded unavailable provider admission

This repairs CodeRabbit discussion `4441478729` on `permissionProvider.ts`, reviewed against published worker head `c912bac47d19d29c06652c709d81222e66fa6feb`. It does not close the other outstanding review findings or accept the analytics release.

## Proven cause and repair

Daily dispatch initially commits `enqueue`, receives `needs_admission`, then verifies the actual provider grant. Unknown provider or malformed permission replies stopped the invocation without advancing its durable ticket. Repeating that failure selected the same account indefinitely, preventing later accounts from being considered. Nontransient Meta permission codes `10` and `200` also lacked a definitive classification.

The provider adapter now distinguishes unavailable provider evidence from unknown store contracts. It reuses the shared permanent-auth classifier and classifies known permission failures without fabricating an observation. Dispatch persists unavailable provider attempts through the existing private sweep, with the behavior defined in the [C3 admission contract](../specs/2026-11-01-meta-owned-analytics-workers.md#admission-and-permission-renewal).

`record_meta_analytics_admission_failure(jsonb,text,uuid)` reuses the existing commit path for canonical ticket validation, parent-account-first locking, current policy/due-date/round checks and fresh-grant preference. Two distinct failures leave the target pending; a third advances with a visible failed enumeration outcome. Duplicate attempt UUIDs do not increase the bound. The caller reports partial progress, never successful collection for the failed account. Later rounds retry admission. Rate limits, caller aborts, exhausted budgets and unknown store outcomes never consume the provider failure bound.

No new table, column, provider grant, token repair, provider retry loop or schedule is introduced. The new RPC is included in the existing, unapplied worker-progress migration and represented in the maintained database types. This is a prerequisite schema/runtime pair: production catalog/ACL verification must precede runtime adoption after separate deployment approval.

## Executed proof

| Boundary | Result |
|---|---|
| Negative control | The published dispatcher, exercised through temporary original handler/dispatch modules, failed the new third-attempt progression expectation: HTTP 503 instead of the acknowledged HTTP 200 partial receipt. Temporary modules were removed. |
| Actual handler with synthetic provider/RPC boundaries | Dispatch and composition suites passed 19 tests /74 steps. Includes permanent permission/auth refusals at debugger and identity stages, transient permission/auth codes, three distinct failures, a subsequent healthy account, unknown credential contracts, unknown/malformed failure-counter receipts and caller abort without a failure write. |
| Fresh disposable PostgreSQL | Baseline +149 migrations, 66 baseline suites and one isolated suite passed. The expanded worker-progress suite proves service-only ACLs, refusal-bound enforcement, duplicate-attempt replay, third-failure advancement, no job or fake observation, next-account enqueue, next-round reset, stale-round rejection and a fresh verified grant taking precedence. |
| Actual catalog | `public.record_meta_analytics_admission_failure(jsonb,text,uuid)` takes `p_ticket jsonb, p_reason text, p_attempt_id uuid`, returns `jsonb`, is `SECURITY DEFINER`, and grants EXECUTE to the owner roles and `service_role` only. The maintained TypeScript signature uses `Json`, `string`, `string` and returns `Json`. |
| Static checks | Focused ESLint and frontend `npm run typecheck` passed. Deno test execution includes typechecking the affected handler/dispatch/store/provider composition. |

The inspected disposable target is `postora-meta-history-pg-20261101`, label `postora.task=meta-analytics-history-c2`, database `meta_analytics_history_harness`, with `cron.launch_active_jobs=off`. No production connection or provider credentials were used. Logs are local `.tmp/pr346-admission-bound-*` artifacts and are excluded from commits. The unchanged rendering/build path was already proved on the published candidate; this repair adds no frontend behavior.

Source/test/docs guard review traced the production dispatcher call into the RPC, unknown-write termination, restricted ACLs, existing parent-first locks, bounded private bookkeeping, no fabricated grants and no collection-success claim. The new tests mock only external database/provider boundaries; the SQL assertions run against real PostgreSQL. The immutable lint/i18n comparison runs on the committed candidate against `c912bac47d19d29c06652c709d81222e66fa6feb`; its final result belongs in the PR reply so this document does not claim an unexecuted gate.

## Follow-up: concurrent verified-grant receipt

CodeRabbit discussion `4442155181` found an HTTP bookkeeping defect on `e7ec09eba5fea6e1265c5bb451ba2ef1ab43b732`. The failure-accounting RPC already preferred a concurrent verified grant and could return `advanced` / `queued`, but the dispatcher treated every advanced receipt as unavailable admission and returned early. SQL had correctly queued the account; the caller mislabeled that acknowledgement and missed completion/continuation bookkeeping.

The dispatcher now stops with `admission_unavailable` only for an acknowledged refused outcome. A queued receipt increments the queue count, retains previously recorded refusal evidence, counts a completed platform round or visits its remaining targets, and never repeats the enqueue commit. The provider-failure bound and unknown-store-outcome behavior are unchanged.

The new handler regression failed in all four variants on the published source: final/non-final target, with/without earlier refused targets. After repair, dispatch/composition passed **20 tests /78 steps**, including the existing deadline, abort, rate-limit and unknown-write cases. Focused ESLint and the source/test/docs guard pass succeeded. Tests inject only external provider/RPC boundaries; no SQL, schema, frontend or production state changed, so the previous catalog/SQL/build evidence retains its original execution attribution. Local negative/positive controls are `.tmp/pr346-queued-grant-before.log` and `.tmp/pr346-queued-grant-after.log`. Graph maintenance and the committed-head immutable lint/i18n comparison are run before publication; the final review reply records their result.

## Remaining release work

Other current #346 review findings remain open for separate verification; initial review closures do not cover them. C3 termination and mixed-unavailable acceptance, C4/C5 acceptance, full Instagram G-X, approved production schema/runtime application, named-account reconciliation and seven successful scheduled due dates remain required. No production deployment, collection activation, retention deletion or cron activation was performed for this repair. Memory tools were unavailable; this checked-in journey preserves the root cause and proof for the next session.
