# Historical competitor growth through the canonical screen

Executed source: `d1ff8c8f75c026bc5a9d2b0e341c02118f650155`. The [proof record](evidence/2026-11-02-instagram-historical-growth-proof.json) binds the clean execution checkout, candidate-labelled local infrastructure, reports, source hashes, retained failure and cleanup. This supplies local assembled E2 evidence under the [release specification](../specs/2026-10-30-instagram-release-gates.md#4-seeded-e2e-design-and-journey-assertions); it does not accept full G-X or authorize production.

## Behavior exercised

The browser signs in through real local Auth and opens the production competitor screen. Its real report route reads SQL history and uses the production assembler and frontend adapter. No report response, ownership decision or growth result is intercepted. Only outbound provider HTTP is synthetic; saved report reads add no provider or paid calls.

The seeded latest observation has 120 followers, with 100 exactly seven days earlier and 80 exactly thirty days earlier. The report and visible list show **+20 (20.0%)** and **+40 (50.0%)**, retaining actual seven/thirty-day intervals. Assertions compare both baseline/end instants to the database-derived fixture reference, rather than pretending the test waited thirty days. Detail retains the same growth and weekly projection as the list.

Zero baseline, null follower measurement, missing baseline, first stored capture and baselines outside the approved S=3-day window return null numeric growth with explicit visible reasons and dashes. None becomes 0%. The approved SQL contract in the [competitor specification §11](../specs/2026-10-30-competitor-ui-and-retention.md#11-open-questions-for-waleed) selects a same-source baseline within that window; an excluded stale observation therefore produces `no_comparable_baseline`, mapped to public `missing_baseline`, rather than using an out-of-window value.

An actual intervening source change disqualifies otherwise eligible same-source endpoints. Negative follower changes remain valid: the seven-day change is −20 (−14.3%) and the thirty-day change is −40 (−25.0%). A complete synthetic three-observation week is visibly distinct from thirty observed posts with incomplete coverage and the legacy entry's unknown coverage. Positive ordering in this fixture exercises downstream logic only; it is not evidence of live Meta ordering.

## Retained failure and fixture correction

The initial source `573e58a58b21b8e79cce4e91c0a69a73ae912ce2` finished with seven passes and one failure. Its source-switch seed contained only official historical observations and a latest Apify observation. It had no eligible same-source baseline, so SQL correctly returned `no_comparable_baseline` under §11; the new assertion expected the different `source_changed` case.

The correction retains those observations and adds Apify observations eight and thirty-one days before the reference. They lie inside each approved cutoff window, before the intervening official captures. The same-source comparisons are now genuinely disqualified by an observed source change. The test expectation is unchanged and no production growth policy, schema, runtime or UI was modified. The failed report, screenshot, trace and page snapshot remain preserved with their original source identity.

## Validation and limits

All **eight canonical browser/API/MCP tests passed** at the executed source, with no skips, retries, flaky results or failures. Fresh preparation passed the baseline, 152 newer migrations, 70 baseline SQL suites and one isolated suite. Scoped ESLint, strict E2E TypeScript checking, the Deno fixture-server check and immutable lint/i18n passed; the latter reports NO REGRESSIONS against `7eb581600b779e685dae71950ac0e61eb0186bf6`, not a debt-free repository. Graph maintenance completed. Only fixture/browser tests changed in this batch, so earlier frontend build and backend unit results retain their separate source identities.

Independent cleanup found only the baseline user, no fixture namespace/cache/history/OAuth client, no collection jobs, competitor profile/media/coverage rows or live leases, disabled cron and stopped HTTP listeners. Prior containers/volumes remain preserved. Code/test/documentation guard review completed. `mem0` is unavailable; these source-bound records preserve the continuation.

This provides historical comparison evidence for E2. It does not claim the new-target J5 capture has accumulated later real observations or close the reactivation/throttle policy question. Outlier J7, other J/E journeys, canonical Instagram metric/calendar and worker/report/UI adoption, protected reconnect and verified provider reasons remain open, together with trusted release infrastructure, independent review and migration-history recovery. The [complete deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains **NO-GO**; approved production deployment, Meta reconciliation and seven distinct successful scheduled due dates per platform are still required.

No production schema/runtime, credential, eligibility, schedule, retention, paid provider request or social publication changed. This batch changes tests/fixtures and documentation only, so no Edge Function deployment is required.
