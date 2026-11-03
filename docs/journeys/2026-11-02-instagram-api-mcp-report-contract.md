# Instagram SQL report parity through API and MCP

Executed source: `05c466ffa8f92a6bc73842edd779e415bc373681`. This is local assembled evidence for the existing Instagram owner-report DTO. It does not accept full G-X or approve production operations. The [proof record](evidence/2026-11-02-instagram-api-mcp-report-contract-proof.json) binds the source, execution files, results and local artifacts.

## Behavior exercised

The previously missing `supabase/functions/n8n-api/instagramReleaseContract.test.ts` now runs under Playwright through `playwright.instagram-release.config.ts`. Its HTTP client calls the actual registered MCP `get_post_analytics` tool and the actual `/api/v1/analytics` router. Neither report responses nor internal ownership, authentication, database readers or proxy calls are stubbed. The existing [canonical fixture](2026-11-02-canonical-instagram-fixture.md) supplies disposable Auth, PostgREST, PostgreSQL and the registered production report handlers. Only provider HTTP is synthetic; these journeys assert that it receives zero calls.

For explicit periods of 7, 14, 30 and 90 days, the test compares the authenticated UI backend report with the public API and an OAuth MCP connection granted only `posts:read`. Every stored/report field is compared, including pagination metadata, source, nulls, zero values, outliers, freshness and completeness. The rolling assembly instant and window endpoints are checked against the request interval and exact requested duration rather than incorrectly requiring sequential requests to share a timestamp. Calendar labels remain part of the comparison.

The seed's null view measurement and measured zero come from observations inside all four windows. A SQL-backed Reel scores 3 with label `outlier` and median 100. Zero reach retains a null engagement rate. Stored daily nulls and zeros remain distinct. Snapshots without a successful collection job retain freshness `never` and `lastSuccessAt:null`; capture time is not reported as a successful sync.

The authorization journey verifies indistinguishable foreign-owner/nonexistent 404 responses separately at the direct report, API and registered MCP boundaries. A normal user's body `user_id` cannot select another owner. A grant lacking `posts:read` is refused with 403 and creates the expected owner-scoped refusal audit row. A cursor on the legacy API/MCP route is refused with `INVALID_CURSOR`. Selecting the unverified versioned Instagram contract remains an honest 409 `window_mismatch` through both API and MCP.

The test creates only a namespace-bound local OAuth client and synthetic token hashes. It uses the fixture's actual generated profile API key without adding it to health receipts or proof documents. Normal cleanup removes the client; the existing identity-verified fixture cleanup also handles an interrupted setup and removes audit rows for its verified owners. The smoke no longer tears down shared fixture rows before subsequent journeys run; the existing global lifecycle performs cleanup after the full suite.

## Executed checks

- The immutable candidate passed **three Playwright tests**, with zero failures, skips, retries or flaky results: the real-Auth/quota smoke, four-period report parity, and registered-route authorization/refusals.
- The new disposable database passed the baseline, **151 newer migrations, 69 baseline SQL suites and one isolated suite**. The cron launcher stayed off and there were zero active schedules.
- **Nine fixture safety tests**, strict TypeScript for the new contract test, the Deno composition check and scoped ESLint passed. The workflow YAML parsed successfully.
- Existing service-proxy compatibility tests passed **39 tests and eight steps**. Those unit tests retain the other-platform routing checks; they are not assembled Facebook/Threads parity or live-provider evidence.
- Immutable lint/i18n against C3 `2b04837163f81cb4220c36e6d393d4ac27afd68a` passed **NO REGRESSIONS**. Historical lint debt remains: ordinary 1,216 errors / 129 warnings, inline-disabled 1,362 / 138. i18n aggregate/callsite counts remain 364 / 414.
- Independent post-run SQL found only the non-login harness sentinel, no fixture namespace, no fixture OAuth clients or tokens, no MCP audit rows, zero active schedules and the cron launcher off. Both fixture HTTP servers stopped. Candidate databases/volumes were preserved.
- The code-graph update completed. Test, code and documentation guard review found no remaining issue in this change. No production runtime code or migration changed, so no Edge Function redeployment is required for this test-only batch.

Earlier attempts remain recorded separately. At `374d17df42ec65147a5321f98a251a28f2d6b745`, one test passed and two failed because the test client negotiated SSE but parsed JSON. At `f5fe55bff565844c115fbec7e5ab5fdaef26abe3`, two passed and one failed because the expected row lay outside the rolling seven-day window. The final source selects the existing JSON transport and checks in-window observations; it does not change production report semantics to satisfy the test. Their logs and JSON reports remain attributed to those sources.

## Reproduction and CI scope

Use a clean immutable checkout of the executed source, the repository's installed dependencies and a local Docker context. Preparation refuses existing fixture containers/networks instead of resetting a database. Preserve and inspect an earlier fixture before preparing another. Refuse inherited credentials and repository `.env` inputs; this suite needs no production secret.

Run from that checkout, with `docker`, `deno` and Node on PATH:

```sh
deno cache --no-config --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none e2e/fixtures/instagramReleaseServer.ts
deno check --no-config --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none e2e/fixtures/instagramReleaseServer.ts
node --experimental-transform-types --test e2e/fixtures/instagramReleaseSafety.test.ts
node scripts/prepare-instagram-owner-release.mjs
npx playwright test --config playwright.instagram-release.config.ts --fail-on-flaky-tests
```

The explicit cache command prepares runtime dependencies before the configured server uses `--cached-only`; the separate check validates types. The added `Canonical Instagram Auth SQL API MCP contract` job in `.github/workflows/owner-analytics-local.yml` prepares its own database and runs this entry point. It retains the synthetic report and fixture artifacts. Local success is not hosted acceptance or evidence that the protected migration workflow exists.

## Hosted dependency-cache follow-up

The first hosted canonical job [failed before any journey ran](https://github.com/lolotam/POSTORA/actions/runs/41383125981/job/125078022767). Its actual prepared candidate was GitHub's merge `896655f0b34c642da8e2adcc460cc07c3ad83204`, for PR head `02b94a401f8166f55ce7cbc4a891699d7c883007`. The configured offline server could not load `https://esm.sh/@supabase/auth-js@2.118.0/denonext/auth-js.mjs` from the empty hosted cache. Database preparation and all nine safety tests had passed. This failure does not invalidate or relabel the separately recorded local result, and local success did not prove hosted dependency readiness.

The route-capture helper accepted a variable import path, so Deno's dependency analysis could not discover those registered entry points. The local cache already held their runtime modules. The helper now accepts a loader callback, and each caller uses a literal dynamic import. Deno can discover the same route modules without duplicating a preload list or changing registration order. `deno check` passes with a separate newly populated cache, and the dependency graph contains all six formerly opaque entry points. An actual cold-cache startup then reproduced the missing executable dependency: type-check success alone does not cache the full runtime graph. The workflow therefore runs `deno cache` explicitly before the separate type check. The `--cached-only` server restriction remains in place. These are fixture preparation changes, not production route or report-contract changes. The [subsequent parity record](2026-11-02-meta-api-mcp-saved-report-parity.md#executed-proof) owns the successful corrected hosted canonical result and repeated local suites; full G-X remains incomplete.

## Remaining acceptance

This provides the local legacy report portion of A14/A15/J8. It does not claim successful versioned Instagram pagination, a verified provider calendar, canonical worker/UI adoption, all-platform assembled compatibility, or the full J/E journeys. A14/J8 remain incomplete until those obligations have their own execution evidence. The author-recorded proof is not an origin-verified external release receipt.

The actual canonical checker still returns `releaseReady:false`. Four required sources remain missing: `.github/workflows/instagram-migration-gate.yml`, `.github/CODEOWNERS`, `docs/journeys/2026-10-26-instagram-insights-and-competitor-tracking.md`, and `docs/runbooks/instagram-insights-release.md`. Four immutable historical migration-prefix incidents and missing trusted workflow/verifier/bootstrap evidence remain. No historical SQL was renamed, replayed or exempted.

Selected-account protected bindings, independent review, approved production prerequisites/runtime application, collection eligibility and schedules, Meta reconciliation, rollback/restoration and seven successful scheduled due dates per platform remain outstanding. The [analytics deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains NO-GO. `mem0` was unavailable; this record preserves the continuation.
