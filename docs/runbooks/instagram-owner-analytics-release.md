# Instagram owner analytics release evidence

Status: partial local evidence. Artifact inventory and isolated real Auth/PostgREST/SQL/worker/browser fixtures exist; two local journeys passed during development. Complete owner traceability, API/MCP parity, remaining journeys, schema reconciliation and live acceptance remain pending. This runbook grants no production approval and does not replace the [canonical Task 11 release gates](../specs/2026-10-30-instagram-release-gates.md).

Scope: owned-account analytics under the [Meta completion specification](../specs/2026-11-01-meta-analytics-completion-design.md) and its [implementation plan](../plans/2026-11-01-meta-analytics-completion.md), A6–A8. Competitor acceptance is unchanged; this owner-only record cannot mark canonical G-X passed.

## Freeze and verify the artifact inventory

Run from the repository root, using the full immutable candidate SHA and a local evidence directory outside task commits:

```powershell
node scripts/check-instagram-owner-analytics-gates.mjs --candidate <candidate-sha> --out <evidence-directory>/owner-artifacts.json
node scripts/check-instagram-owner-analytics-gates.mjs --verify <evidence-directory>/owner-artifacts.json
node --test scripts/check-instagram-owner-analytics-gates.test.mjs
```

The inventory reads committed Git blobs, not checkout bytes, and records SHA256 hashes, commit/tree IDs, the recursive local import closure of owner report/sync and API/MCP roots, frontend/configuration files and external import specifiers. It rejects unresolved local/bare imports, computed dynamic imports, runtime imports outside `supabase/functions/`, missing required frontend/config paths and changed recorded hashes. It includes type-only local dependencies conservatively; that is deployment inventory, not proof that each module has a runtime caller.

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

The dedicated Playwright config overrides the Supabase URL/key with public synthetic fixture values, refuses to reuse an existing frontend server, and waits for the application entry module before launching tests. Auth uses real email/password login, not a fabricated browser session. Browser routes allow loopback app/API traffic only. The real report/sync composition roots use real local Auth/PostgREST/Postgres; only Meta transport is synthetic and public provider egress is refused. The gateway forwards to two fixed internal services; only its host ports are published, bound to loopback. All fixture cron jobs remain inactive.

The initializer restores the repository baseline plus newer migrations and runs the existing SQL harness. `core.autocrlf=false` preserves committed LF bytes in its archive on Windows. The schema-only dump lacks Auth migration rows and original Auth object ownership: before starting the pinned GoTrue image, preparation restores only the captured Auth migration-version metadata and local Auth ownership after checking the exact table-column shape. The metadata contains no production user data. This column-shape check is not the full production schema/ACL lineage reconciliation required by B1.

Re-seeding is confined to the fixed synthetic owner/account in the dedicated labelled container, refuses an active worker lease, and resets that fixture's histories/jobs/throttle before inserting deterministic values. It does not modify shared accounts or pilot credentials. Traces and preparation logs stay in the local temporary directory and must not be committed.

The two implemented journeys cover real login, stored pagination and end-of-list, period reset, visible isolated chart points, 202 enqueue → real worker/SQL → refreshed report/UI, disabled collection with retained data, and identical foreign/nonexistent 404 refusals with JWT identity precedence. They found and reproduced the authenticated-only status-RPC mismatch documented in the repair candidate; the production correction does not widen grants.

## Remaining owner-local evidence

The following are requirements, not executed receipts:

- Extend the real-boundary fixtures with user identity changes, failed reads, retries and stale-worker fencing. Keep provider transport fixtures distinct from database/Auth evidence.
- Prove canonical report/API/MCP parity, account/period reset, complete pagination, AR/EN/RTL and missing/error states. A copied-fixture disconnection must fail behaviorally without changing the immutable source.
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
