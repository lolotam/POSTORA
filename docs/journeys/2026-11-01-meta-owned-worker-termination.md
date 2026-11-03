# Owned Meta analytics dependency termination

Scope: the real `meta-owned-analytics-sync` handler, request reader, store, admission, dispatch, collection, retention, provider transport and terminal audit. Only external database/network replies, caller cancellation and elapsed clock time are controlled. These tests do not prove SQL transaction rollback, live Meta behavior or production collection.

## Invariants and coverage

`supabase/functions/meta-owned-analytics-sync/termination.test.ts` drives the actual routes through their successful paths before injecting failures. Its database matrix covers 24 dependency positions for each platform, in both caller-abort and real-timeout modes: 96 cases. The test dependency deliberately ignores cancellation, then acknowledges late after the response. No new provider/database operation or job/dispatch/cleanup success count may follow that unknown outcome. One independently bounded final audit remains required.

| Action | Dependency positions |
|---|---|
| Admission | Initial protected credential read, the permit read before each debugger/identity HTTP request, and permission observation write. |
| Daily dispatch | Single-platform selection; `all` ordering read and subsequent actual target selection; initial enqueue/admission decision and durable post-admission advancement. |
| Drain | Master-switch read, claim, initial credential and HTTP permit reread, checkpoint reads before/after inventory, page reservation/commit, metric reservation/persistence, job completion, throttle read/write. |
| Retention | Independent-scope target selection and actual cleanup acknowledgement. |

The successful route cases require the correct action's acknowledged queued/collected/deleted count, rather than merely checking HTTP 200. For timed database cases, the actual five-second dependency ceiling must abort the supplied signal and return before eight seconds, without spending the whole 40-second invocation budget. Caller cancellation must also stop dependencies that ignore their signal. The late result is released and observed; it cannot resume the invocation.

Additional real-clock cases cover debugger/identity fetches and response bodies for both platforms, including ignored stream cancellation; a noncooperative terminal audit; stalled/oversized request bodies before any account operation; and the final-write reserve. Consuming 34 seconds shortens a new dependency to approximately one second. After the 35-second work cutoff, no new dependency may start. The terminal audit is independent of a disconnected caller and retains its own five-second limit.

The suite is registered as its own CI step in the existing Deno job. Timers remain native; the tests do not reduce production ceilings, replace internal use cases, disable sanitizers or grant network access to production. Total expected local runtime is about five minutes because every timeout position runs against the real ceiling.

## Executed evidence and review

The first matrix attempt exposed a fixture mistake: a second selection read was expected on a single-platform request, although ordering reads occur only for `all`. Those four steps failed as unreachable. The corrected cases exercise real `all` ordering and its subsequent third selection call; no production condition or test assertion was weakened. The completed corrected suite passed six tests / 118 steps. A repeat is tied to immutable candidate `8c048be55f52be5939a43b99bbc5c3ba7779b0a8` in the current [proof artifact](evidence/2026-11-01-meta-saved-analytics-proof.json).

A separate admission regression proved that Meta error code 2 with HTTP 400 could still be durably refused. Both debugger and operational identity cases failed before the fix. Unknown provider errors now leave dispatch resumable regardless of HTTP spelling. A valid-token debugger reply missing user/scope evidence or containing duplicate scopes is an invalid contract, while actually observed missing permissions and definitive identity/token failures remain distinct. The final focused C4 pair passed 14 tests / 60 steps; the C3 pair passed 13 tests / 57 steps. See the [collection continuation](2026-11-01-meta-owned-worker-collection.md#follow-up-transient-admission-error-carried-by-http-400).

Source/test guards checked the actual production call sites, trust-boundary fixtures, native clocks, late-acknowledgement behavior, fail-closed response counts and scope of the evidence. The initially failed logs remain separate from successful attempts.

## Remaining acceptance

This completes the local dependency-cancellation/timeout matrix, not every C3 or release requirement. Native SQL concurrency/authority tests, integrated captured-value semantics and browser journeys have their own evidence. Larger retention-policy dry-run continuation, remaining mixed-capture journeys, full Instagram canonical capability/calendar and G-X, selected-account credential binding, separately approved deployment, Meta reconciliation and seven actual scheduled due dates remain open. No production operation or release approval follows from this test suite.
