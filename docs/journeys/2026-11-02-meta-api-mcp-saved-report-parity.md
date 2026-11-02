# Saved Meta analytics API/MCP parity and offline dependency preparation

Local executed source: `97c6708804a94f725945100638061ba0e99e65ff`. The [proof record](evidence/2026-11-02-meta-api-mcp-parity-proof.json) binds the candidate, raw/normalized execution hashes, fixture preparation and local artifacts. This extends local validation; full G-X and production completion remain unaccepted.

## Facebook and Threads report behavior

`e2e/meta-owned-release.spec.ts` now compares the actual saved-report payload observed by the browser with the authenticated public API and registered MCP `get_post_analytics` tool. Both platforms explicitly select `analyticsContractVersion:1`. The existing fixture supplies real Auth, PostgREST, report SQL, HTTP routing and signed cursors; no report payload or ownership decision is mocked.

The comparison covers every field except the independently validated assembly timestamp: source, account identity, current/previous periods, metric definitions, availability and zero values, deltas, observations, trend buckets, post values, sync state, completeness and signed continuation. It runs on the first 25-post page and the one-post continuation. The existing browser assertions independently require 26 distinct loaded posts and correct zero/unavailable rendering. Thus empty or duplicated pages cannot satisfy transport parity by agreeing with each other.

The ownership journey also checks identical foreign-owner/nonexistent API 404 responses and their exact MCP refusals. A malformed signed cursor produces `invalid_cursor` at both public boundaries. Provider-call counters are unchanged through these read/refusal journeys. The same suite retains its actual browser identity switch, revision-conflict recovery, worker refresh and permission/expired-token failure checks. The worker uses synthetic provider HTTP and real persisted queue/report operations; this is not live Meta reconciliation.

Existing fixture roots and the actual synthetic owner API key were reused. No new account-generation scheme, production credential, report adapter or registry capability was introduced.

## Dependency-cache failure and correction

The [earlier hosted failure](2026-11-02-instagram-api-mcp-report-contract.md#hosted-dependency-cache-follow-up) exposed two preparation gaps. Variable imports hid registered entry points from Deno's graph. Literal loader callbacks made them discoverable, but an actual separate-cache startup still reproduced a missing executable dependency after a successful `deno check`: checking types did not populate the whole runtime JavaScript graph.

The canonical workflow now runs `deno cache` before the separate type check. Startup retains `--cached-only` and the fixture's network restrictions. The cache step fetched the exact missing `auth-js.mjs` dependency and the remaining executable modules. It does not execute a provider request or start collection. The correction changes only fixture loading and CI preparation.

The canonical suite then passed locally with that separately prepared cache. It was followed, on the same immutable candidate and migrated disposable database, by the existing owner suite. The canonical lifecycle removed its namespace/Auth/OAuth/audit rows before the owner fixture was seeded. The second fixture's two synthetic owners, their history and the non-login harness sentinel were retained for inspection after its runtime stopped. Independent SQL found 13 accounts: 12 fixture accounts and the baseline sentinel's account, zero unexpected owners, zero active schedules, the cron launcher off and no running Meta job or live Instagram lease. Both HTTP servers stopped.

A local PowerShell wrapper initially stopped on an npm warning before any owner journey executed. The seed was retained unchanged, and a hidden child process with explicit exit-code handling ran the owner suite. That wrapper failure is not counted as a passing journey or a product regression.

## Executed proof

- **Three canonical Playwright tests** passed again, with zero failures, skips, retries or flaky results. They cover real Auth/quota, four-period legacy Instagram parity, scoped MCP authorization and honest versioned-contract refusal.
- **All 13 required owner journeys** passed once, with zero failures, skips, retries or flaky results. `scripts/check-instagram-owner-journeys.mjs` accepted the actual report. The six Facebook/Threads journeys include the added API/MCP assertions.
- The newly prepared database passed the baseline, **151 newer migrations, 69 baseline SQL suites and one isolated suite**. These are local harness results, not production migration approval.
- The literal-import change passed Deno checking with a separate cache and again with `--cached-only`; an actual startup remained necessary to find the missing executable-cache step. The existing nine safety tests and scoped ESLint passed. The owner composition also passed its Deno check. Code, test and documentation guard review completed, and the code graph was updated.
- Immutable lint/i18n passed **NO REGRESSIONS** for `409f950e` against `02b94a40`, for executed source `97c67088` against `409f950e`, and for `b8bd1f11` against `97c67088`. The latter adds the CI cache command and documentation; it does not change the tested application, fixture-server or Meta-test inputs. Historical lint/i18n debt remains.

The [hosted canonical job](https://github.com/lolotam/POSTORA/actions/runs/41385591492/job/125085596371) also succeeded: three tests passed on GitHub's actual prepared merge candidate `0a15860485e4d584c6b7093ffb048e1aae9a3274` for PR head `b8bd1f11ebd21eab4d3e7a90a2ab827deb1462dd`. The [hosted owner job](https://github.com/lolotam/POSTORA/actions/runs/41385591492/job/125085596667) subsequently succeeded on that same merge candidate: all 13 journeys passed and the required-journey checker accepted their actual report. Those are distinct executions from the local `97c67088` results. Their source identities and log hashes remain separate in the proof record; neither is full G-X acceptance.

## Limits and remaining work

This establishes saved Facebook/Threads report and pagination parity at the actual API/MCP composition, complementing the existing Instagram legacy evidence. It does not establish live-provider acceptance, successful versioned Instagram reporting, all canonical J/E journeys or trusted-origin release-ledger acceptance. The proof is author-recorded and is not a substitute for the still-missing protected workflow/verifier/bootstrap and independent reviews.

Instagram's latest recorded production diagnostic still lacks the selected account's protected credential binding and trusted capability. No legacy-token fallback or metric/calendar promotion was made. A verified Instagram registry and worker/UI contract adoption, four immutable historical migration-prefix incidents, remaining G-X artifacts, approved production prerequisites/runtime/eligibility/schedules, live Meta reconciliation, rollback/restoration and seven successful scheduled due dates per platform remain outstanding. The [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains NO-GO.

No production code, schema, credential, setting, schedule or social content changed in this batch. No Edge Function redeployment is required for these fixture/test/CI/documentation changes. `mem0` was unavailable; these source records preserve the continuation.
