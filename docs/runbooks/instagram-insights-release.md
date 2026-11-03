# Instagram insights release procedure

**Current disposition: NO-GO for the complete release.** This procedure fills the operational source required by the [release specification](../specs/2026-10-30-instagram-release-gates.md); it does not approve a production write or supersede its activation gates. The [implementation evidence index](../journeys/2026-10-26-instagram-insights-and-competitor-tracking.md) identifies what has actually run. The [combined Meta deployment package](2026-11-01-meta-analytics-deployment-package.md) owns the proposed final package and its unresolved prerequisites.

## Prepare an immutable local candidate

Use a clean checkout of the exact committed candidate, with the repository's installed Node/Playwright dependencies, Deno and a local Docker engine. Do not use a checkout containing `.env` files, modified execution inputs or inherited provider credentials. The fixture rejects unapproved environment configuration and remote Docker contexts. Its execution-source checker binds the checkout HEAD to the database's `postora.owner-candidate` label.

Run from that checkout:

```powershell
git rev-parse HEAD
node scripts/prepare-instagram-owner-release.mjs
deno cache --no-config --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none e2e/fixtures/instagramReleaseServer.ts
deno check --no-config --lock=scripts/ci/deno-analytics.lock --frozen --node-modules-dir=none --cached-only e2e/fixtures/instagramReleaseServer.ts
npx playwright test --config playwright.instagram-release.config.ts --fail-on-flaky-tests
```

Deno dependency integrity: the commands above and the analytics steps of `ci.yml` and `owner-analytics-local.yml` verify remote and npm modules against the committed `scripts/ci/deno-analytics.lock` with `--frozen`. Regenerate it only with Deno 2.9.8, `--no-config --lock=<new file>` and an isolated `DENO_DIR`, review the version diff, and commit it separately. The ai-image, resend and process-post steps are outside this lock. Its three jsr/esm.sh entries (`@std/assert`, `@std/internal`, `iceberg-js`) have no historical CI provenance.

Preparation creates a new isolated database and Auth/PostgREST/gateway containers. It refuses existing fixture names/networks and the production-stack host; it never resets a previous database. If preparation refuses an existing fixture, inspect its source identity and preserve its data/recovery metadata before freeing names. Never remove a volume or relabel a predecessor as the new candidate. The database harness must pass before browser evidence is usable.

The Playwright configuration owns the application and fixture server processes. Its global teardown removes only the owned synthetic namespace. A timeout, nonzero exit, failed teardown, skipped required journey or retry/flaky result is retained as failed evidence. Capture the JSON report, log and failure trace/screenshot before the next run overwrites the temporary Playwright output. Record the full candidate and Git tree, relevant Git blob hashes, executed-file hashes and newline-normalized comparisons with every execution record.

After the run, independently inspect the local database for fixture namespace/Auth/OAuth/cache/history leftovers, active schedules and live worker leases. Confirm `cron.launch_active_jobs` is off and the application/fixture listeners have stopped. Keep the disposable database for inspection; cleanup success is not permission to delete its volumes.

## Evaluate the release inventory

Run the checker from the candidate checkout with a verified `origin/main` ref:

```powershell
node scripts/check-instagram-release-gates.mjs --main-ref origin/main --phase local
```

Without its external per-run ledger, this command is an inventory with missing-evidence failures. It does not execute tests, hosted checks, independent reviews or production operations. Preserve the actual failed report as well as passing test results. Supply the separately reviewed redacted ledger only when its execution, dependency, review and bootstrap references exist; do not write receipts simply to satisfy the schema. The local and release phases and their precise acceptance requirements remain defined in the specification.

The complete fresh-candidate check set also includes the affected unit/SQL/owner journeys, TypeScript/build checks, immutable lint/i18n comparison and the required independent reviews. The [completion plan](../plans/2026-11-01-meta-analytics-completion.md) owns that inventory. A narrow canonical run proves only its named behavior. Historical migration bytes, collisions and missing workflow activation are not repaired by renaming, replaying or whitelisting old SQL.

## Freeze a reviewable production package

Only after the applicable local release prerequisites are met, regenerate the combined package for the final source. Its existing older artifact manifest cannot deploy a later branch head. Include exact ordered SQL and catalog/grant checks, backend recursive import closure, frontend build, selected account/authority identities, switches and schedule states, reconciliation/observation plan, and compatible rollback/restoration operations. Preserve the selected targets from the completion design rather than substituting a convenient account.

Read back the installed production migration/catalog/runtime state immediately before any approved application. A merged migration file does not prove that SQL is installed. Record read-only preflight failures explicitly; do not treat a failed read as an empty catalog. Missing protected bindings, unverified capability/calendar data, unresolved migration-history incidents or absent independent evidence keep the package NO-GO.

## Execute only the approved stage

The [numbered activation gates](../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step) own the required owner decisions and sequence. Attach the exact approval, candidate, operator, account/configuration and resulting redacted evidence to the approved stage. A previous merge approval or read-only target selection cannot authorize a later SQL, reconnect, runtime, eligibility, collection, schedule, retention or rollout action.

For approved backend deployment, follow [deploy-edge-function.md](deploy-edge-function.md), using the self-hosted stack, complete approved import closure, SHA256 readback and documented restart/boot checks. Main can synchronize runtime and frontend automatically, so do not merge dependent code ahead of its approved prerequisites. Keep the disabled-state verification distinct from pilot collection success.

After an approved pilot, compare persisted reports with Meta using the same account, period, provider calendar, metric definition and update instant. Record unavailable values and failures honestly. The completion design owns the observation window and scheduled-success criterion; manual retries and an inactive cron definition cannot establish stability. Rollback must preserve saved data/additive schema and prove collection has stopped. Restoration and any widening follow their own approved stage. If any required evidence is missing, retain the gate as pending and report the exact gap.
