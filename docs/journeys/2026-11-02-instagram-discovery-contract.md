# Instagram discovery authority and canonical release tooling

Discovery runtime source: `f0b73ad20275e9c4a749f68e044cbb1c026568bc`. Executed source/tooling checkpoint: `5ada6702f9d17251aa350d1a00bc989f204ec430`. This record covers local implementation and verification. The approved targets, full G-X requirement and production boundaries remain those in the [completion design](../specs/2026-11-01-meta-analytics-completion-design.md) and [release gates](../specs/2026-10-30-instagram-release-gates.md).

## Proven defects and resulting behavior

The interactive `brand-scrape` route selected its Instagram viewer from legacy metadata, supplied a Page token to Business Discovery, used the former field-expansion syntax, and shared a platform/handle cache across callers. It discarded account-query failures, classified every video as a Reel and converted omitted measurements to zero. Strategy was recorded separately from the response/profile, so cached and historical results could lose their source. These defects were traced through the actual route and existing consumers before the change.

The route now resolves service-recorded capabilities and the protected Facebook User credential before reading its Instagram cache. A trusted denial remains a scope refusal; missing/expired authority requires reconnect; metadata and Page tokens cannot supply substitute authority. Owner and credential/capability revision enter the versioned cache identity. Failed account/capability/cache/history reads or writes refuse instead of masquerading as empty data or completed work. The direct own-account path retains `graph_own` provenance.

The interactive adapter reuses the scheduled Graph URL builder, cursor and media parser. Requests use documented Business Discovery expansion, bounded pages/bodies/timeouts, cursor reconstruction and duplicate-ID filtering. FEED videos retain their format. Missing counts and dependent scores remain null, including through rendering, sorting, exports and saved sessions. Actual zero remains measured zero. Optional profile/media text is validated at the provider boundary. Graph codes 10/200 alone do not establish missing viewer permission; code 190 remains a reconnect refusal.

`official`, `graph_own` and `apify` source values survive response, cache, session and UI round-trips; legacy sessions without provenance remain unknown. Frontend requests/cache/session state are scoped to the authenticated owner, including late pagination responses. Existing native Threads routing was traced to its unconditional dedicated-endpoint response; the dead fallback condition was removed without resurrecting it. Shared nullable consumers were updated across the existing brand and analytics screens.

Instagram interactive paid fallback requires an explicitly true, successfully read admin setting; missing/malformed settings do not authorize it. No setting or paid provider was enabled or invoked by this work. Scheduled Apify remains deferred. The supported OAuth/reconnect journey and live selected-account capability evidence remain acceptance work; this slice does not certify all of Task 2 or full G-X.

## Executed checks and limits

- Registered discovery route and viewer tests: **13 tests / 19 nested steps** passed using synthetic provider/Auth/PostgREST boundaries. These are not real SQL/Auth integration proofs. The affected route file passed again after the test-environment cleanup fix: **six tests / 19 steps**.
- Existing shared Graph adapter suite: **45 tests** passed. This checks the actual builder/parser and bounded transport used by the scheduled adapter; no complete worker or live Meta rerun is inferred.
- Frontend: **34 tests across four suites** passed in two sequential invocations (17 + 17). An initial worker-start timeout collected no tests; another earlier run exposed an incomplete `useAuth` fixture, which was corrected to provide the real required session shape. Those attempts are retained.
- Final `typecheck` and production `build` exited zero. Source/test guard review and scoped whitespace validation passed.
- Scoped ESLint found one new unused-expression diagnostic in test cleanup. Replacing that expression with an explicit `if/else` preserved restoration behavior; the affected Deno suite and file lint passed afterward.
- Immutable lint/i18n for `5ada6702f9d17251aa350d1a00bc989f204ec430` against C3 `2b04837163f81cb4220c36e6d393d4ac27afd68a` passed **NO REGRESSIONS**. Historical debt remains.

The [proof record](evidence/2026-11-02-instagram-discovery-and-gates-proof.json) pins source/artifact hashes and the original failure attempts. The earlier [13 owner browser journeys](evidence/2026-11-02-meta-owned-browser-proof.json) remain attributed to execution revision `a98d7fe34e29ff3cf47d2d62caa9dbb622f33f1a`; they have not been relabelled as rerun on this changed parent screen. Canonical assembled journeys and exact-revision hosted/independent acceptance remain open.

## Canonical checker and current refusal

The canonical checker now reconciles all **78 required IDs**, immutable source/artifact manifests, reviewed test identities, native Playwright outcomes, value-call chains, migration history and event bindings, protected workflow/bootstrap receipts, and separate hosted/live evidence. Its real Git/filesystem suite passed **79 tests**, with no skips or cancellations. Reviewed receipts and static caller bindings still require manual architecture/guard review; this command executes no test, external approval or production operation. Local readiness cannot authorize release or activation.

The tooling has a separate main-based draft, [PR #349](https://github.com/lolotam/POSTORA/pull/349). Its four changed files and relevant helper/spec inputs match the fully tested version; both positive catalogue/complete-ledger tests also passed from that clean checkout. This makes tooling review independent of the pending analytics runtime release.

Running the checker on the real `5ada6702` candidate returned `failed`, `releaseReady: false`, and `productionActivationAuthorized: false`. Its canonical fixture/config, workflow/CODEOWNERS, API contract test, journey/runbook and external evidence gaps are retained. The source inventory additionally contains four historical duplicate migration prefixes:

| Prefix | Existing files |
| --- | --- |
| `20260825120000` | `ai_agent_tools_connector_fields.sql`, `inbound_media_understanding.sql` |
| `20260828190000` | `account_configs_prepare.sql`, `clear_false_positive_meta_reauth.sql` |
| `20260904120000` | `comment_workflow.sql`, `social_contacts.sql` |
| `20260906120000` | `byok_provider_keys_and_routing.sql`, `whatsapp_evolution_sync_outcome.sql` |

Those migration files were not changed or reapplied. Reconcile their source/application provenance before activating the migration gate; do not hide the collision findings or amend applied SQL to obtain a green result. Canonical fixture construction continues separately and does not substitute for accepted execution evidence.

## Production and remaining work

The [latest authorized read-only check](2026-11-01-meta-saved-analytics.md#current-production-readback-and-remaining-work) still finds missing protected bindings for selected Facebook/Instagram and a missing trusted capability row for Instagram. The new saved readers remain absent. No token was selected and no provider request was sent in that check.

The [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains NO-GO. Its older frozen saved-report manifest does not include these discovery bytes or future canonical fixtures. Complete canonical product adoption/fixtures, required reviews and capability/calendar evidence, reconcile migration inventory, then refreeze the combined package before requesting its concrete production approvals. Production SQL/runtime application, eligibility, collection/schedules, Meta reconciliation, rollback/restoration and seven distinct scheduled due dates remain unperformed. `mem0` was unavailable; this record preserves the findings and proof.
