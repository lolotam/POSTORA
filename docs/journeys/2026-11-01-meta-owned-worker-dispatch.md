# Owned Meta analytics: durable daily dispatch

Status: implemented and proved locally on the C3 workers branch, extending the [admission slice](2026-11-01-meta-owned-worker-admission.md). This delivers daily enumeration and permission renewal, not metric collection or a completed analytics release. The owner requested completing the missing implementation first, then presenting a concrete deployment package for approval. C2/C3 schema and runtime have not been applied/deployed in production.

## Behavior and source ownership

`20261101141000_meta_owned_analytics_worker_progress.sql` adds the private global `meta_analytics_enqueue_sweeps` table and service-only next/commit RPCs. Collection jobs remain in the existing platform-owned queues. One canonical locked policy decoder supplies both dispatch and the existing boolean eligibility checks. Off reads stop before policy/sweep access; missing or malformed enabled configuration is unavailable, not an empty successful sweep.

The SQL ticket pins platform, provider-calendar due date, policy digest, round, expected previous position and exact next account. Commit derives ownership and atomically enqueues without force before advancing the cursor. A stale/consumed/expired ticket refuses. A matching grant observed since the due instant avoids unnecessary provider calls; stale or rotated authority returns `needs_admission` without advancing. Real admission renews it before another commit attempt. Existing job generation/state/claim are preserved.

The actual `meta-owned-analytics-sync` route now accepts strict `enqueue-daily` for Facebook, Threads or both. It shares the 40-second deadline, five-second dependency bounds, final audit reserve and 50 visited targets across the selected platforms. Ordering hints prefer the older next round/least recently served platform, then actual SQL start/commit checks repeat current policy. A full first platform cannot indefinitely consume the shared budget ahead of an unstarted second platform. A completed platform round reopens only on a later start; an unfinished one resumes its position.

HTTP counts describe this invocation's visited targets and acknowledged queued/refused outcomes, not newly created measurements or successful collection due dates. Partial work/refused targets remain partial. Unknown writes stop immediately without retrying or claiming an acknowledgement; a later invocation reads durable cursor/job state. Provider rate limits stop the batch without advancing that target. Persistent cross-invocation throttle storage remains part of the collection work below.

Three source regressions were demonstrated before their corrections:

- Valid uppercase policy UUIDs selected the same UUID target but failed the old case-sensitive membership test. The canonical decoder now normalizes validated UUID representations while the digest still binds the original policy document.
- A broad catch around admission plus its subsequent commit treated `MAH04` from that commit as another admission result and attempted a third write. The failing test observed three attempts instead of two. Only actual target-admission refusals are now converted to a refused outcome; a stale commit stops the invocation.
- A valid provider grant containing the required permissions plus 40 unrelated permissions exceeded the old 32-scope decoder ceiling and refused both platforms. The provider wire list remains bounded/validated, then only actually granted analytics-relevant scopes are persisted. Additional unrelated permissions cannot invalidate this feature's authority or exceed its observation storage ceiling; missing relevant scopes remain missing.

The typed store was renamed `OwnedAnalyticsStore` because it now owns both admission and dispatch RPCs. Database types add only the new catalog table/function blocks; known nullable helper/default arguments are represented explicitly. Existing upstream HTTP-wrapper signatures remain unchanged.

## Executed proof

| Boundary | Executed result |
|---|---|
| Fresh labelled PostgreSQL harness | Baseline +144 migrations +62 baseline suites +1 isolated suite passed. The new dispatch suite then passed its expanded raw-role/RLS checks. |
| Dispatch SQL behavior | More than 50 targets and two owners, same-day resume/reopen, current grant/rotation renewal, no forced generation reset, duplicate/skip/expired-policy/date tickets, refusal advancement, malformed/off/empty policies and uppercase UUIDs passed. |
| Actual HTTP orchestration with synthetic driver/provider boundaries | Admission plus dispatch suites passed 12 tests /45 steps, including the 50+50 cross-platform cap, unknown committed outcome, actual admission, rate limiting, stale-commit nonretry and unrelated-scope monotonicity. |
| Actual registered handler with real SQL | Admission and daily dispatch passed 1 test /10 steps, with actual scope persistence, fresh-grant enqueue, repeated enqueue, credential rotation and a lost committed response followed by resume. Eleven real audit rows were created; fixture cleanup restores settings and removes only owned synthetic rows/sweeps. |
| Real SQL concurrency | 24 cases passed, including the original 18. Twenty actual PostgreSQL Lock waits were observed. New cases cover duplicate commits and policy exclusion in both orders for both platforms; job generation/state/claim do not reset. |
| Frontend/build | Frontend typecheck and Vite production build passed after the catalog additions; existing bundle/Browserslist warnings remain. |

Local Deno is 2.9.6; CI retains its 2.9.8 pin and executes the coordination unit/composition and real-SQL integration suites. Logs and detailed synthetic runtime reports remain under `.tmp/`. No production credentials or provider requests are used by these tests. Final source/test/docs guard review found no unresolved behavioral or documentation findings. Review traced the private ACLs, parent-first locks, ticket CAS, unknown-write termination, actual non-test dispatch call, scope monotonicity, synthetic fixture isolation and cleanup. Focused ESLint and the final incremental frontend typecheck passed. Immutable lint/i18n comparison is recorded separately against the final candidate head.

## Production availability and remaining work

A separate read-only production check at 2026-11-01 13:15:54 UTC confirmed the reported Instagram message: its master collection setting is absent, owner/competitor rollout modes are off with zero targets, and all five relevant schedules are inactive. The [redacted receipt](evidence/2026-11-01-instagram-collection-disabled.json) records that state without changing it. Applying #332 and deploying #333 did not authorize activation.

Next deliver the fenced claimed-state/inventory reservation protocol together with its real collection consumers, metric capture/drain, persisted usage/backoff, bounded retention orchestration and six inactive schedule definitions. Then complete C4 persisted reports and C5 UI. Full Instagram G-X remains required, followed by the separately approved named pilot, reconciliation, rollback/restoration and seven consecutive successful scheduled due dates. No completed collector, live data match or release-ready claim follows from dispatch enumeration.
