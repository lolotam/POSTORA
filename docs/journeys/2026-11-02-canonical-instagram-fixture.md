# Canonical Instagram fixture foundation and local smoke

Executed candidate: `baba9e3b5b9a7814125dada5383e9c4ff38b3f74`. This is fixture infrastructure and one local smoke journey, not acceptance of the full [Instagram release gates](../specs/2026-10-30-instagram-release-gates.md). Production was not changed. The [proof record](evidence/2026-11-02-canonical-instagram-fixture-proof.json) binds the source and local artifacts.

## What now runs

The canonical fixture composes the registered production report, sync, discovery, competitor, API and MCP routes with real disposable Auth, PostgREST and PostgreSQL. Its manifest separates normal owners A/B from the administrator and includes direct/Page-linked accounts, protected authority states, shared competitor handles, quotas and saved boundary histories. Only Meta data transport is synthetic; the browser receives an empty local font stylesheet and an explicit closed connection for unavailable Realtime notifications. Neither substitutes report data or successful collection receipts.

The new `instagramRelease` fixture modules own its manifest/provider seam, SQL seed, registered server, browser adapter and lifecycle. `playwright.instagram-release.config.ts` supplies the isolated entry point, and `e2e/instagram-release.spec.ts` exercises the smoke. Existing synthetic signing settings and the competitor presentation fixture are reused. The execution-source guard covers the canonical configuration and refuses remote Docker before container inspection.

The smoke signs in through the real application as all three identities and reads each identity's real quota RPC. It verifies normal-owner limits/usage of 20/11 and 5/5, the separate administrator's unlimited entitlement, zero completed collection jobs, zero provider calls and zero active cron jobs. It then removes only its verified namespaced identities and settings. Independent SQL readback found one preserved non-login harness sentinel, no canonical namespace, cron launcher `off` and zero active jobs. Backing containers and volumes remain for inspection; the HTTP server stopped.

## Defects exposed by execution

The first commit attempt was refused by the unchanged local secret guard because it matched two constant references. Both were verified synthetic references and are now resolved from the existing settings object. No guard was disabled or exempted.

The first runtime attempt refused inherited `NTFY_TOKEN`; it was removed only from the test process environment. A fresh migrated database retains `db-harness.sh`'s non-login sentinel, so the pristine-state check now recognizes that exact identity while rejecting every other existing Auth identity, including malformed/null identity fields.

Vite 5's `envFile:false` also skips collecting process environment exports. The lifecycle now defines only the two approved synthetic public inputs explicitly, without reading repository `.env` files. Font requests are fulfilled locally; unexpected browser/server destinations still fail. The fixture closes its exact loopback Realtime endpoint without inventing subscription events. The smoke uses Playwright's configured page/context, so trace and screenshot policies cover the actual browser.

Auth-admin deletion exposed application cascade triggers that require application-table privileges. Cleanup now uses the existing isolated SQL adapter after checking the namespace, candidate and Auth identity. Its deletion matches UUID, email and namespace together. The temporary attempt to grant Auth schema access was removed; the final preparation script has no added application grants. Original failures and predecessor databases remain attributed to their original candidates.

## Proof and remaining work

The final Chromium smoke passed once, with zero skips, retries or flaky results. Nine safety tests, strict Node TypeScript, Deno checks and scoped ESLint passed. The fresh database passed the baseline, 151 newer migrations, 69 SQL suites and one isolated suite. These checks do not rerun or relabel the earlier 13 owner journeys at `a98d7fe34e29ff3cf47d2d62caa9dbb622f33f1a`.

Immutable lint/i18n at the executed candidate against C3 `2b04837163f81cb4220c36e6d393d4ac27afd68a` passed **NO REGRESSIONS**. Ordinary lint still reports 1,216 errors / 129 warnings, and the inline-disabled lane reports 1,362 / 138. Those are historical findings, not a clean full lint result. Source/test/docs guard review and the code-graph update completed.

The actual canonical checker still returns `releaseReady:false` and refuses the full gate. Five required files remain absent: the migration workflow, CODEOWNERS, native API release-contract test, canonical journey and release runbook. Execution ledgers, full J/E journeys, reconnect/interactive fallback composition, verified Instagram metric/calendar adoption, migration recovery and hosted/live acceptance remain open. Four immutable historical migration-prefix collisions were confirmed; no historical SQL was renamed, changed or replayed to clear them.

The [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains NO-GO. Protected selected-account bindings, approved SQL/runtime application, collection eligibility/schedules, Meta reconciliation, rollback/restoration and seven distinct scheduled due dates remain outstanding. `mem0` was unavailable; this source record preserves the continuation.
