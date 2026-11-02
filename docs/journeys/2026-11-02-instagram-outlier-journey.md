# Owner and competitor outliers through real reports and screens

Executed source: `038f18a25adda3386a18a643f4e00541c7b5b638`. The [proof record](evidence/2026-11-02-instagram-outlier-journey-proof.json) binds the clean execution checkout, candidate-labelled local services, reports, input hashes, retained regression failure and cleanup. This supplies local assembled J7 evidence under the [release specification](../specs/2026-10-30-instagram-release-gates.md#4-seeded-e2e-design-and-journey-assertions); it is not independent G-X acceptance or production permission.

## Proven presentation defect and correction

The owner media table displayed the score and verdict, but its metric basis appeared only inside an English `title` tooltip. The competitor table already displayed public views/interactions as visible text. The distinction required by the [competitor contract](../specs/2026-10-30-competitor-ui-and-retention.md#6-analytics-and-completeness-rules) was therefore not visible in the owner screen.

The new canonical journey at `76be6a89b2cd5382ced7a28cf7985459f1db4072` passed its preceding numerical, label, pagination and period assertions, then failed because `Metric basis: owner organic views` was absent. Eight other canonical tests passed. The failed report, screenshot, page snapshot and trace retain that source identity. An earlier strict test typecheck used `media.items` rather than the actual `media.page.items`; that setup error was corrected before the browser run and is not the product regression.

`MediaPerformanceTable.tsx` now displays the server-provided metric basis beside each verdict: owner organic views, reach or interactions. Null basis remains absent; it is never guessed from a media type or a default. Four Arabic translation entries provide the same distinction. The canonical scoring algorithm, metric selection, report DTO and database are unchanged. Existing tooltip diagnostics remain available.

## Assembled behavior proved

The browser signs in through real local Auth, opens the competitor detail screen, changes its period, loads actual SQL continuation data, then opens the owner performance screen, loads its continuation and changes period. Report responses are not intercepted. The registered production routes, owner-scoped SQL, assemblers, frontend adapters and controls all execute. Only outbound provider HTTP is synthetic; saved reads add no provider or paid calls.

Both reports/screens preserve the inclusive boundaries **3× outlier**, **1.5× above**, **1× normal** and **0.5× below**. A measured zero remains a zero score/below; null views produce `no_data`, a 24-hour-old item produces `too_early`, and too few older posts produce `small_baseline`. The owner views cohort uses twelve older media; a separate owner interactions cohort scores with exactly six, both with median 100. The repeated older capture of the owner's first media does not replace its latest observation.

The competitor's original score is equal in seven/thirty-day reports and remains visibly correct after continuation data is appended. The owner views and interactions verdicts are equal after changing thirty to seven days, including baseline size, median and metric basis. Baseline history is not restricted to the display window. Competitor public views/interactions and owner organic metrics remain separately labelled. The owner labels are verified as visible text in English and Arabic, with `lang=ar` and `dir=rtl` in the latter.

The fixture's six-predecessor interaction captures now explicitly store their measured `total_interactions`; the earlier seed populated component fields without that independent measurement. The stable immature example is 24 hours old. The competitor example uses the existing cursor-tie entry so the separate historical growth truth model retains its original weekly counts. No elapsed days or live provider ordering are fabricated.

## Validation and release limits

All **nine canonical browser/API/MCP tests passed**, with no failures, skips, retries or flaky results. Fresh preparation passed the baseline, 152 newer migrations, 70 baseline SQL suites and one isolated suite. Full frontend typecheck/build passed in the clean execution checkout. The affected screen/pagination suites passed 16 tests against the final production UI bytes before their commit; that input attribution remains separate from the later clean-checkout execution. Scoped ESLint, strict final-input E2E TypeScript checking and the Deno fixture-server check passed. Immutable lint/i18n reports **NO REGRESSIONS** against `f0e0d59df6279bf3e4e75d1514fae2dccc0f4c1d`; historical debt remains. Graph maintenance completed.

Independent cleanup confirmed only the baseline user, no namespace/cache/history/OAuth client, no collection jobs, competitor profile/media/coverage rows or live leases, disabled cron and stopped HTTP listeners. Previous containers/volumes remain preserved. Production-code, test and documentation guards completed. `mem0` is unavailable; these source-bound records preserve the continuation.

This proves the stated representative J7 report/screen behavior. It does not establish exact 48-hour microsecond maturity boundaries, which still need an authoritative server clock seam; complete Arabic localization of pre-existing badge text is not claimed. Protected reconnect, remaining J/E journeys and verified provider eligibility/threshold reasons remain open, alongside canonical Instagram metric/calendar adoption, trusted release infrastructure, independent review and migration-history recovery. The [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains **NO-GO** pending the full G-X and approved production observation sequence.

No production schema/runtime, credential, eligibility, schedule, retention, paid provider request or social publication changed. This batch adds two frontend deployment inputs and fixture/test evidence; it changes no Edge Function implementation and requires no Edge redeployment by itself. The new frontend bytes must enter the refrozen combined package before any main merge/deployment.
