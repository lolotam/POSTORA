# Instagram owner analytics release evidence

Status: partial local evidence. Artifact inventory and isolated real Auth/PostgREST/SQL/worker/browser fixtures exist; six local journeys pass, including direct/API/MCP report parity. Full prerequisite traceability, remaining fencing evidence, production schema reconciliation and live acceptance remain pending. This runbook grants no production approval and does not replace the [canonical Task 11 release gates](../specs/2026-10-30-instagram-release-gates.md).

Scope: owned-account analytics under the [Meta completion specification](../specs/2026-11-01-meta-analytics-completion-design.md) and its [implementation plan](../plans/2026-11-01-meta-analytics-completion.md), A6–A8. Competitor acceptance is unchanged; this owner-only record cannot mark canonical G-X passed.

## Freeze and verify the artifact inventory

Run from the repository root, using the full immutable candidate SHA and a local evidence directory outside task commits:

```powershell
node scripts/check-instagram-owner-analytics-gates.mjs --candidate <candidate-sha> --out <evidence-directory>/owner-artifacts.json
node scripts/check-instagram-owner-analytics-gates.mjs --verify <evidence-directory>/owner-artifacts.json
node --test scripts/check-instagram-owner-analytics-gates.test.mjs
```

The inventory reads committed Git blobs, not checkout bytes, and records SHA256 hashes, commit/tree IDs, the recursive local import closure of owner report/sync and API/MCP roots, frontend/configuration files and external import specifiers. It rejects unresolved local/bare imports, computed dynamic imports, runtime imports outside `supabase/functions/`, missing required frontend/config paths and changed recorded hashes. Candidates containing the shared frontend analytics feature also inventory its files and canonical metric source; a missing canonical source is rejected. Earlier candidates without that feature remain readable. It includes type-only local dependencies conservatively; that is deployment inventory, not proof that each module has a runtime caller.

Exit zero means **artifact inventory/verification succeeded only**. The JSON always has `scope: "instagram-owner-analytics-artifact-inventory"`, `canonicalTask11GX: "not_evaluated"` and `releaseReady: false`. External import URLs alone do not freeze their resolved transitive versions; B1 still needs the deployed resolver/configuration and resolved-dependency evidence. A changed candidate needs a new inventory and candidate-bound validation results.

The first inventory of the [Instagram repair candidate](../journeys/2026-11-01-instagram-performance-candidate.md), `9fa3ffcce1d5a965a319d34bfe8c0ee9d9a7eb38`, found 72 runtime files. That count describes that exact commit, not future candidates.

## Reproduce the isolated local journeys

Requirements: a local Docker Unix/named-pipe context, Node/npm, Git and Playwright Chromium. The preparation script refuses remote Docker endpoints, production-stack hosts and existing fixture container/network names. It creates new disposable resources only, retaining them for inspection. It never resets an existing database.

```powershell
node scripts/prepare-instagram-owner-release.mjs
node scripts/prepare-instagram-owner-release.mjs --verify-existing
npm exec --yes --package deno@2.9.0 -- deno run --node-modules-dir=none --allow-env=DOCKER_HOST --allow-run=docker --allow-net=127.0.0.1:65435 e2e/fixtures/instagramOwnerReleaseSeed.ts
npm exec --yes --package deno@2.9.0 -- deno run --node-modules-dir=none --allow-env --allow-run=docker --allow-net=127.0.0.1:65431,127.0.0.1:65435,127.0.0.1:65436 e2e/fixtures/instagramOwnerReleaseServer.ts
```

Leave the fixture server running, then in another terminal:

```powershell
npx playwright install chromium
npx playwright test --config playwright.owner-analytics.config.ts
node --test scripts/check-instagram-owner-analytics-gates.test.mjs scripts/instagram-owner-release-safety.test.mjs
```

The dedicated Playwright config overrides the Supabase URL/key with public synthetic fixture values, refuses to reuse an existing frontend server, and waits for the application entry module before launching tests. Auth uses real email/password login, not a fabricated browser session. Browser routes allow loopback app/API traffic only. The real report/sync, n8n API and MCP composition roots use real local Auth/PostgREST/Postgres; only Meta transport is synthetic and public provider egress is refused. The gateway forwards to two fixed internal services; only its host ports are published, bound to loopback. Postgres starts with `cron.launch_active_jobs=off` before baseline restoration; preparation also deactivates all cron rows. Verification requires both the disabled launcher and zero active rows, preventing jobs created active by historical migrations from running during preparation.

The initializer restores the repository baseline plus newer migrations and runs the existing SQL harness. `core.autocrlf=false` preserves committed LF bytes in its archive on Windows. The schema-only dump lacks Auth migration rows and original Auth object ownership: before starting the pinned GoTrue image, preparation restores only the captured Auth migration-version metadata and local Auth ownership after checking the exact table-column shape. The metadata contains no production user data. This column-shape check is not the full production schema/ACL lineage reconciliation required by B1.

Re-seeding is confined to the fixed synthetic owner/account in the dedicated labelled container, refuses an active worker lease, and resets that fixture's histories/jobs/throttle before inserting deterministic values. It does not modify shared accounts or pilot credentials. Traces and preparation logs stay in the local temporary directory and must not be committed.

The six implemented journeys cover real login, stored pagination and end-of-list, period reset, visible isolated chart points, 202 enqueue → real worker/SQL → refreshed report/UI, disabled collection with retained data, identical foreign/nonexistent 404 refusals with JWT identity precedence, account-read loading/failure/retry, Arabic/RTL and keyboard controls, identity changes without previous-owner data, and full direct/API/MCP report parity. They found and reproduced the authenticated-only status-RPC mismatch documented in the repair candidate; the production correction does not widen grants.

The API fixture sets a public synthetic `profiles.api_key`, letting the real database trigger calculate its hash; neither API nor MCP authentication is replaced. The parity journey compares every report field after independently validating the three request-clock instants (`generatedAt`, `period.windowStart`, `period.windowEnd`). It normalizes only those instants; persisted measurements, provenance, coverage, cursors, scope and errors must match exactly. This proves the current legacy owner contract, not the future unified contract.

## Executed local evidence, 2026-11-01

Source candidate: `d7f23934683254039237b97983e9bbe6124236e7`. The artifact inventory contains 72 runtime files and verifies successfully; `releaseReady` remains false. Node 24.21.0, npm 11.19.0, Docker 29.9.2, Playwright 1.57.0 and npm-packaged Deno 2.9.0 were used locally. Hosted CI pins different Node/Deno versions and must supply its own result.

| Check | Observed result and scope |
|---|---|
| Fresh isolated preparation | Baseline + 140 newer migrations + 57 baseline suites + 1 isolated suite passed. Launcher disabled from first startup; zero active schedules verified. The database archive is bound to `0eb9f2b3bb3f5bccf206d9a92a15dba189500e54`; `git diff --exit-code` proves the harness, migrations and SQL suites unchanged at the source candidate. The startup correction used during rehearsal is committed in that candidate. |
| Browser/API/MCP journeys | Six passed, zero skipped, retries disabled. Tests are in `e2e/instagram-owner-release.spec.ts`; no real Meta transport or pilot account was used. |
| Inventory and socket safety suites | Six Node tests passed, zero skipped. |
| Fixture compilation and frontend types | `deno check` for server/seed and `npm run typecheck` passed. Targeted ESLint and `git diff --check` passed. |
| Lint/i18n regression gate | **NO REGRESSIONS** against `1c1f892b412951b0cb9afd74914bb5e5fb8edc63` for this source candidate. Existing debt remains: 1224 ordinary errors, 1370 no-inline-config errors, 364 i18n aggregate findings. This is not a clean-lint claim. |
| Copied-fixture negative control | A separate copy returned 404 instead of dispatching the report. The real parity journey failed at its direct-report 200 assertion, process exit 1. The committed server's SHA256 was unchanged; the copy and trace were retained outside the repository, then the normal server was restored. |
| Independent static review | One confirmed issue: cron could run before post-restore deactivation. Fixed with startup launcher disablement and verification; no production reach was found. Later identity/RTL/API/MCP additions received agent source/test guards, not a second independent review. |

Local evidence is retained outside task commits: `postora-owner-release-prepare-tJdt3t`, `postora-owner-d7f23934-{artifacts,resolved-dependencies,playwright}.json`, and the negative-control log/source/trace under the local temporary directory. The resolved-dependency file describes this local Deno resolver only; it is not deployed dependency evidence. Previously used containers were stopped and preserved with a `-preserved-20261101043442` suffix; their network configuration was retained separately. No production resources were modified.

Runtime caller chains exercised: `InstagramPerformanceScreen` → `useInstagramInsightsReport` → default Supabase gateway → report composition/store → PostgREST/SQL; Sync button → sync composition → durable worker/store → SQL → report/UI; n8n `handleRequest` → `handleGetPostAnalytics` → real function invoker → report; MCP registered `get_post_analytics` → authenticated n8n route → report. These are executed routes, not import-presence claims.

## Remaining owner-local evidence

The following are requirements, not executed receipts:

- Extend the real-boundary journeys with stale-worker fencing and complete the prerequisite-to-evidence mapping. Keep provider transport fixtures distinct from database/Auth evidence. Existing unit/SQL fencing tests are not a substitute for any required end-to-end assertion.
- Complete all canonical owner acceptance cells beyond the six journeys above. The existing parity, account/period reset, pagination, AR/EN/RTL, failure/retry and negative-control receipts do not evaluate competitor cells or the future unified schema.
- Bind executed commands, tool versions, exits, test titles, skip counts, artifact hashes and actual runtime caller chains to the candidate. Run source/test/docs guards and independent review. An absent artifact or skipped required assertion remains a blocker.

Until these exist and run, A6 is partial. The artifact checker is intentionally not a local or release acceptance pass.

## Production sequence after local prerequisites

The authoritative gate ledger owns decisions. Before any pilot, satisfy its prerequisites or record Waleed's explicit approved scope amendment in that owning specification. This runbook cannot supply the amendment.

1. Prepare the full B1 release/schema manifest and read-only production preflight, including object definitions/ACLs/owners, migration lineage, installed functions and rollback compatibility. The artifact inventory above is only one input.
2. Obtain the distinct B1/B2 approvals before merging or deploying the backend candidate. A main merge can trigger automatic Edge reconciliation; see the [deployment runbook](deploy-edge-function.md).
3. Obtain the named-account and live-probe approvals. Complete C1–C2 reconnect/session checks and separately approved C3 publishing proof, then D1 target admission and D2 one-owner activation. Record exact allow-list/switch state and zero non-pilot provider calls/writes.
4. Separately approve exact pilot enqueue/drain schedules before measuring stability. Retention remains off. Capture seven distinct provider-calendar due dates, each completed strictly before its next due instant, with receipts and retry lineage.
5. Reconcile metrics using the completion spec's exact windows/observations/tolerances. Rehearse rollback and prove zero further writes. Restore only with a separate approval, read back active settings and capture a successful post-restoration scheduled receipt. Disabled collection after rehearsal cannot count as complete.

No production deployment, switch, allow-list, credential, cron, retention or pilot operation has been executed by this preparation step.
