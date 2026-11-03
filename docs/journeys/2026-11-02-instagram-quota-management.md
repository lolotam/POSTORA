# Canonical competitor quota and management journey

Executed source: `5a66366c0650a8940ddeca486c9767fa6cb02fca`. The [proof record](evidence/2026-11-02-instagram-quota-management-proof.json) binds source/tree identities, executed-file hashes, preparation/results, retained failures and cleanup. This contributes to J6 and the management portions of J5 in the [release specification](../specs/2026-10-30-instagram-release-gates.md#4-seeded-e2e-design-and-journey-assertions). Full G-X and production completion remain unaccepted.

## User-visible defect reproduced and fixed

The assembled run at `3bf06d702282629d7aa2a137250f92c47af83195` completed five canonical tests and failed the new quota journey. Real SQL refused reactivation at the owner's five-competitor limit. The use case correctly returned `{ outcome: "failure", error }`, but `CompetitorTrackingWorkspace` handled that result in neither its reactivation success callback nor its error display. React Query did not call `onError` because the use case returned a resolved result, so the user saw no explanation. The retained browser trace and screenshot show the removed row and full quota without the expected refusal.

The same result pattern made definite removal failures silent in the confirmation dialog. Two focused UI regressions failed before correction. The workspace now maps the typed reactivation failure through its existing translated error copy and derives removal errors from either a thrown mutation error or its explicit failure result. The removal dialog stays open with the stored row intact. Raw database details remain hidden; no mutation is automatically replayed. No application use case, database enforcement rule or public contract changed.

## Actual Auth, SQL and screen behavior

The new journey uses the current Instagram page, real synthetic-owner login, PostgREST and migrated SQL. It does not inject a tracking gateway or fabricate mutation/report responses.

- Owner B sees `5 of 5 tracked` and a real `/pricing` link. Tracking a newly analyzed handle receives the actual SQL quota refusal and the UI names the limit. Watchlist rows and collection jobs remain unchanged, and the write adds no provider call.
- A confirmed UI removal keeps the row identity and removal marker, frees one slot, closes its dialog and restores focus to the list heading. Two paired authenticated HTTP add requests compete for that slot: one succeeds, one returns the quota refusal, and exactly one new handle is persisted. This tests the final-slot outcome; it does not claim a separately observed PostgreSQL Lock wait.
- UI reactivation at the full limit displays the quota refusal and leaves both rows and jobs unchanged.
- Lowering owner A's actual local quota override from 20 to 3 retains all 11 existing active rows and their snapshots. A removed row cannot reactivate, and the UI names the new limit.
- Setting the ordinary owner's override to -1 produces unlimited tracking without an upgrade link. Reactivation reuses the removed row's ID, clears its removal marker, preserves stored snapshots and creates a real queued job. No drain or provider capture is invented. The original quota override is restored afterward.
- A separately signed-in administrator has unlimited tracking despite its stored quota of zero, sees no upgrade prompt and can add a row. Provider receipts remain unchanged after the earlier discovery, including through reads and enqueue.

## Validation and limits

All **six canonical tests passed** at the executed source, with no failures, skips, retries or flaky results. All **37 screen tests passed**, including the two failure regressions. Full typecheck and strict E2E typecheck passed. The production build passed at `fdbe4b81e2dd16d92362f6e7211ef98e9aadcd51`; the final source only corrects a test query option, so production inputs are unchanged. The failed initial type check is retained separately: Testing Library does not support the Playwright-style `exact` role option, which was removed rather than bypassing type checking.

The fresh local database passed its baseline, 151 newer migrations, 69 baseline SQL suites and one isolated suite. Final-source immutable lint/i18n against `a7b79b7e9429d0fe2b63c04b427576e4d6e663e3` reports **NO REGRESSIONS**; historical debt remains. Scoped ESLint, code/test/documentation guards and graph maintenance completed. Independent SQL after teardown confirmed only the baseline user, no fixture namespace/cache/history/OAuth client or collection job, no live lease, no active cron and the cron launcher off. Both HTTP listeners stopped. Predecessor containers/volumes and failed artifacts remain preserved.

This does not complete J5's new-target save-to-capture/report or lost-response reconciliation journey, nor the remaining canonical J/E rows. Protected reconnect, canonical Instagram metric/calendar adoption, verified provider reasons, trusted workflow/verifier/bootstrap, independent reviews, migration-history recovery and the production approval/observation sequence remain open. The [combined deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains **NO-GO**.

Changes affect the competitor workspace, its UI regressions and the assembled browser test. No production mutation or deployment occurred. No Edge Function runtime file changed, so no Edge Function redeployment is required; the frontend fix remains on the PR branch pending the complete approved package. `mem0` is unavailable; the source-bound record preserves the continuation.
