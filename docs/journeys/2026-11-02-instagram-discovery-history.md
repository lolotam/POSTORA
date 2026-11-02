# Canonical Instagram discovery and saved-history journey

Executed local source: `0e3d01fef8bbcf6ece3257a0b6ca736ad9c139ac`. The adjacent [proof record](evidence/2026-11-02-instagram-discovery-history-proof.json) records Git blobs, raw and newline-normalized execution hashes, test results and local artifact hashes. This is author-recorded evidence for the J3 behavior in the [release gates](../specs/2026-10-30-instagram-release-gates.md#4-seeded-e2e-design-and-journey-assertions), not independent G-X acceptance or production approval.

## Reproduced defects and correction

The real `brand-scrape` producer records provenance in `profile_data.source`. The history component previously read only the optional top-level session source, so a saved official result appeared as `Source unknown`. A new regression failed on the original code: 17 tests passed and one failed. Resolving the explicit session source first, then the recorded profile source, made all 18 pass. Cache strategy never establishes provenance. The same private resolver supplies the row badge and the reused profile.

The first assembled browser execution at `ddbb91e5c071e1b790ea3ea8fa42fcaad036ee96` then exposed a second user-visible defect. Discovery, media values and the cache path worked, but `/brand-intelligence` redirected to `/analytics/instagram?tab=performance`, where saved analysis history was unreachable. That execution remains recorded as three passes and one failure, with its original trace, screenshot and report retained separately.

The current Instagram Analyze tab now opens the existing `ScrapeHistory` component in a History dialog. The legacy route keeps its existing redirect. Reuse calls the existing `useBrandScrape.loadFromSession` path and closes the dialog. The query key and SQL filters include the authenticated owner and platform. An Instagram history cannot reuse a stored Facebook profile. A failed history read displays a safe error and Retry, rather than an empty-state message. The dialog has an accessible title and description, supports Escape and restores focus to its trigger.

## Executed behavior

The new canonical browser journey signs in through real local Auth and exercises the actual discovery handler, protected viewer resolution, SQL-backed cache/history and current application route. Only the external Meta HTTP provider is synthetic.

- Discovery of `@release_competitor` returns exactly 120 followers and two posts, with distinct REEL and FEED VIDEO types, hidden likes preserved as null and views of 300 versus unavailable.
- The first owner's discovery makes two recorded provider calls through its own granted Page identity. The repeated search is a cache hit, keeps the exact data and official source, and adds no provider call.
- Navigating through the legacy redirect, opening History and reusing a saved row retains official provenance and exact media values without a new provider request. The dialog closes and restores keyboard focus.
- A real logout/login as the second owner cannot expose the first owner's current profile, cached authority or history. Discovery requires two additional calls through the second owner's Page identity. Its history contains only its own matching discovery row and no first-owner seeded history.
- The existing API/MCP contract tests now compare provider receipts with the state captured before each test. They retain the discovery evidence and prove that report reads/refusals add no provider calls, rather than clearing earlier receipts.

All four canonical tests passed with no failures, skips, retries or flaky results. The existing Auth/quota smoke and both API/MCP contract tests passed alongside J3. This run does not replace the separately attributed earlier hosted three-test and 13-owner-journey results.

## Validation and cleanup

Preparation created a new candidate-labelled disposable database; it did not reset an existing database. Its baseline, 151 newer migrations, 69 baseline SQL suites and one isolated suite passed. Deno runtime caching and the cached-only type check passed before the assembled run.

The focused UI suite passed 35 tests across three files. Full TypeScript checking passed at the executed source. The production build passed at `538ef365df35e375c6195d8baf77f583ce591168`, whose production inputs are unchanged by the final test-query correction. Immutable lint/i18n against `757fc42fa6002b782c6a3eb155695fa97fe2adc1` reports **NO REGRESSIONS** at the executed source; historical lint/i18n debt remains.

After Playwright's successful global teardown, independent SQL found only the baseline harness user, no namespace setting, scrape sessions, cache rows or fixture OAuth clients, no live Instagram lease and no active cron job. The cron launcher remained off, and both application HTTP listeners stopped. The containers and database remain available for inspection. The predecessor fixture containers and volumes were preserved separately. Code, test and documentation guard passes checked these changes, and code graph maintenance completed.

## Remaining release work

This proves the local J3 discovery/cache/history behavior. It does not establish the remaining canonical J/E journeys, protected reconnect, canonical Instagram metric/calendar adoption, live-provider acceptance or trusted-origin evidence. The protected workflow/verifier/bootstrap, missing required sources, independent reviews and four historical migration-prefix incidents remain open. Production prerequisites, runtime, eligibility, scheduling, retention, live Meta reconciliation, rollback/restoration and seven successful scheduled due dates per platform remain separately gated. The [analytics deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains **NO-GO**.

The read-only local checker was rerun against this exact source and the recorded `origin/main` ref. It still reports four migration-prefix collisions/reserved-prefix violations, missing `.github/workflows/instagram-migration-gate.yml`, `.github/CODEOWNERS`, `docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md` and `docs/runbooks/instagram-insights-release.md`, plus the absent external evidence ledger. Workflow activation and R1/R2/C1 migration-snapshot evidence remain blocked. Its actual failed report is retained in the proof; it did not run hosted checks, accept a review or authorize an operation.

No production schema, runtime, credential, setting, schedule or social content changed. This batch changes frontend code and tests; the file under `supabase/functions/` is test-only, so no Edge Function redeployment is required. `mem0` is unavailable; this source-bound record preserves the continuation.
