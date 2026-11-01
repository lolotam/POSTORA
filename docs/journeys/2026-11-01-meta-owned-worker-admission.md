# Owned Meta analytics: C3 admission slice

Status: historical proof for the first C3 admission slice. The later [daily dispatch record](2026-11-01-meta-owned-worker-dispatch.md) extends this implementation; neither record describes a completed collector. The [C3 contract](../specs/2026-11-01-meta-owned-analytics-workers.md) and [execution plan](../plans/2026-11-01-meta-owned-analytics-workers.md) own the remaining work. No C2/C3 production application, deployment, admission, credential repair, collection, retention or activation is authorized by this record.

## Problem and implementation

C2 requires a current trusted permission observation before enqueue/claim, while its worker credential reader requires a claimed job. The new admission seam closes that bootstrap cycle without manufacturing scopes or a credential generation. Two service-only RPCs derive the owner, use C2 preparation/locks and compare the complete captured authority. Facebook returns distinct operational Page and protected User credentials; Threads uses its actual C2 epoch. Expired protected User credentials refuse.

The registered `meta-owned-analytics-sync` route at this admission-only candidate accepted only the implemented `admit` action. It verifies cron/service authority, bounds and validates the body, checks app configuration before account secrets, uses restricted CORS, verifies the real grant debugger and operational account identity, and persists observed scopes through C2's post-response fence. Missing required permissions remain an explicit refusal after truthful observation. No permission or owner fields are accepted from the request.

The shared Meta transport now calls a real per-request permit outside its provider catch and recalculates time/call budgets afterwards. A stale or unknown store result therefore stops before the next provider request. Concurrent permits cannot exceed the physical call cap, and a rate limit observed while another permit waits prevents that pending HTTP request. The route has a 40-second overall bound, five-second dependencies and bounded final audit; unknown writes are never retried or reported as success.

## Executed evidence

| Proof | Result |
|---|---|
| Before implementation | Admission SQL suite failed because the required credential-reader RPC did not exist. |
| Fresh PostgreSQL | Repository baseline +143 migrations +61 baseline suites +1 isolated suite passed in the labelled disposable harness, cron launcher off. The expanded admission suite then passed again, including expired protected User token refusal. |
| Actual registered HTTP with synthetic driver/provider boundaries | 22 tests /95 steps passed across the new composition suite and existing Threads provider/Facebook composition suites. Includes scopes, user/app/Page identity, malformed responses, revoked/unknown permits, unknown writes, caller-field refusal, configuration/body limits, ignored abort, concurrent call ceilings and a throttle observed during a pending permit. |
| Actual registered HTTP with real SQL | Both platforms passed normal admission, exclusion before the second provider request and exclusion before observation persistence: 1 test /6 steps. Exactly six real audit rows, no collection jobs; fixture settings/owner restored by cleanup. Only provider HTTP and the PostgREST network driver were replaced. |
| Existing concurrency | All 18 real-session cases passed again; 14 actual PostgreSQL Lock waits observed. |
| Types | Three added function blocks match the actual disposable catalog signatures. Existing upstream HTTP-wrapper types were preserved. Deno typechecking of route/composition/integration passed. |
| Production build | Passed; existing chunk-size and Browserslist warnings remain. |
| Frontend typecheck | `npm run typecheck` passed against the added catalog-derived RPC types. |

Local Deno is 2.9.6. The repository CI pin remains 2.9.8; npm did not provide that version locally, so this record does not claim a local 2.9.8 run. CI now runs the new route's type/composition checks and real-SQL admission integration. Hosted results are separate evidence.

The first real-SQL integration run exposed an existing test-driver defect: its `text[]` cast serialized arrays as JSON strings, which PostgreSQL refuses as native arrays. The responsible shared test adapter now emits typed native array elements. The same real admission path then passed without changing production deadlines or bypassing a fence.

`clean-code-guard`, `test-guard` and `docs-guard` were applied to the changed code, tests and record. Detailed query/provider logs remain outside committed evidence under `.tmp/`; all credentials used by these local tests are synthetic. The disposable runtime is inspected and pinned by container ID, requires a recognised task label and `_harness` database, and refuses a live cron launcher before fixture mutation.

## Remaining C3 and release order

At this admission-only candidate, daily dispatch, inventory reservations, worker-state reads, metric collection, persistent throttling, retention and inactive schedules remained open. The [dispatch continuation](2026-11-01-meta-owned-worker-dispatch.md) now supplies `enqueue-daily`; drain/retention still refuse input validation rather than simulate successful work. No inactive cron was installed by this slice.

Migration merge/application require separate decisions after review, followed by deployed catalog/ACL/cache verification before dependent runtime deployment. No production Edge Function deployment occurred: this unmerged runtime depends on unapplied C2/C3 schema. Full Instagram G-X, C4 persisted reports, C5 unified UI, live reconciliation, rollback/restoration and seven scheduled due-date receipts remain open.
