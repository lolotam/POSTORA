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

## Usable sibling follow-up

Source `f9feeec0a37beebd530f58127660cae37941c3aa` fixes two further reproduced selection failures. A newer candidate with a known missing/expired protected binding no longer masks a usable older protected viewer. A direct-login account can no longer establish a missing Business Discovery permission. Ranking and denial classification share the existing Page-linked eligibility predicate. Real RPC, malformed-receipt and credential-generation errors still propagate; they are not treated as unusable siblings.

The corrected original-source run reproduced both failures. The final affected Deno suites passed **15 tests / 21 steps**, and scoped ESLint passed. The zero-match filter attempt and earlier malformed test binding remain diagnostic attempts, not RED proof. This fix is included in the [canonical fixture smoke candidate](2026-11-02-canonical-instagram-fixture.md); that smoke exercises Auth and quotas, not discovery or full G-X.

## Discovery review follow-up

Source `076d323c52a51e701dc41f07a4954fa7d25aea5e`, following `3c59f38989fd5d90fca2f8ba0e93e080f6bba5db`, completes a five-file discovery source/test follow-up after review of PR #347. The targeted runs below executed the changed bytes subsequently committed in their identified revisions. The earlier source and canonical proof attributions above remain unchanged.

- [Handle validation](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988876): Instagram uses the canonical normalizer result for authority matching and cache identity. Interior `@` is rejected; accepted leading `@`, whitespace and case resolve to one handle. Facebook/TikTok normalization is unchanged.
- [Post-limit cache reuse](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988910): `maxPosts` now participates in the owner/authority-scoped Instagram cache identity, so increasing the configured limit recollects the bounded result.
- [Throttle classification](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988886): HTTP 429, Graph codes 4/17/32/613 and usage at least 80% return `DISCOVERY_RATE_LIMITED`/429. This refusal does not invoke paid fallback, including when that fallback is enabled. HTTP 429 bodies are cancelled under the original eight-second attempt ceiling, without parsing malformed throttle text; cleanup rejection cannot mask the known throttle. Code 190 and trusted permission-refusal behavior remain covered.
- [Provider parser failures](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988879): shared target/media parser errors become sanitized discovery errors and can enter fallback only under the existing explicit admin permission.
- [Incomplete pagination](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988888): duplicate-only intermediate pages already followed valid cursors. Both transports now refuse completion when the unchanged `ceil(maxPosts / 25)` page budget ends with a valid next cursor and too few unique posts. That attempt cannot save an undersized successful cache result; the page allowance is not expanded.
- [Profile counts](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988892): only safe nonnegative integers are measurements. Fractional, unsafe and other invalid counts become null; measured zero remains zero.
- [Hook continuation](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988860): the latest response's `hasMore` drives both the exposed state and the load-more guard. Subsequent responses also update the next offset and displayed total instead of retaining first-page metadata.

The [credentialless-viewer comment](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988871) is already handled by the effective protected-binding resolver. A new regression with `hasProtectedCredential: false` and an absent binding passes against the original source and confirms usable-sibling selection; the pure selector was not rewritten. The [sequential capability-read concern](https://github.com/lolotam/POSTORA/pull/347#discussion_r4437988881) is deferred by scope: no bulk RPC, concurrency policy or provider budget was introduced.

Focused validation for this follow-up:

- Original-source Deno reproduction: **five parent tests / eight nested steps failed**; the credentialless and uncapped duplicate-only continuation controls passed. The hook reproduction had **two failures / 11 passes**. Logs: `.tmp/discovery-review-red-deno.log` and `.tmp/discovery-review-red-hook.log`.
- At `3c59f389`, registered-route/parser plus unchanged viewer suites passed **20 tests / 31 nested steps**, and the hook suite passed **13 tests**. Logs: `.tmp/discovery-review-green-deno.log` and `.tmp/discovery-review-green-hook.log`. Provider/Auth/PostgREST and hook HTTP boundaries are synthetic; no real SQL/Auth or Meta integration is implied.
- Root review then identified the HTTP 429 body-release omission. A real `ReadableStream` cancellation observer reproduced **two failing nested steps**, including cancellation rejection. After the bounded cleanup correction in `076d323c`, the affected registered-route/parser suite passed **13 tests / 32 nested steps**, and both changed files passed scoped ESLint with **zero errors / zero warnings**. Logs: `.tmp/discovery-review-cancel-red-deno.log`, `.tmp/discovery-review-cancel-green-deno.log` and `.tmp/discovery-review-cancel-eslint.json`. The hook source was unchanged by this correction.
- Source/test guards and scoped whitespace validation passed. Scoped ESLint retains **10 pre-existing errors / zero warnings**, all in `brand-scrape/index.ts`; the other four files are clean. Actual ESLint comparison against `4120afa8` recorded identical per-file counts in `.tmp/discovery-review-eslint-baseline.json`.

Combined typecheck/build, graph maintenance and immutable full lint belong to the integrating orchestrator after the parallel source slices finish. This follow-up ran no deployment, production mutation, paid provider call or canonical browser journey, and supplies no new G-X release approval.
