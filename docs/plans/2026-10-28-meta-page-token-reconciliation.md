# Milestone 2 subplan: Page-token reconciliation before owner ingestion

Status: P1 SQL prerequisite accepted locally at `2c9cefcd`; P2 maintained types and adapter/provider/route integration are next, not yet implemented. [Acceptance and evidence](2026-10-26-instagram-insights-and-competitor-tracking.md#p1-page-reconciliation-sql-prerequisite-accepted-locally). Orchestrator owns the subplan and acceptance; Codex Astra 6 High remains the independent read-only reviewer. Initial implementation/tests/SQL stay MiniMax Token Plan `minimax-coding-plan/MiniMax-M3.1-Flash`; corrections stay Grok `grok-4.7-build-fast`/high. Project-specific §13 overrides the general pipeline SQL lane.

Spec: [captured Page-token reconciliation](../specs/2026-10-28-meta-page-token-reconciliation.md). Parent: [Instagram plan §14](2026-10-26-instagram-insights-and-competitor-tracking.md#14-user-approved-sequential-milestone-gates-2026-10-27). Resume existing `feat/instagram-insights-competitors` checkout; commit verified slices locally only. No worktree/branch switch or push is implied.

## Decisions and evidence

- Consultation 38 chooses unchanged captured User grant → operational Page rederivation → new atomic reconciliation writer. User renewal remains reconnect/OAuth-driven. It rejects Page-token `fb_exchange_token`, unsupported indefinite web renewal, grant-only rotation, post-HTTP recapture and owner-wide health/token writes.
- Existing binding table already holds service-written provider User/Page/IG identity. New writer must constrain the derived token to that identity and the original captured account/credential, not invent a link from metadata. Consultation 39 accepts original version fencing plus locked identity agreement for supported lifecycle writers; no begin wrapper/projection change. Arbitrary service-role identity writes without advancing fences are not covered by that guarantee.
- Public official documentation snapshots and 4,286-file dispatch baseline are retained externally. `mem0`, named brainstorming/planning/guards and graph CLI remain unavailable; source/contract/advisory/manual equivalents are disclosed, not tool passes. Existing graph was read only for orientation.
- User made `lolotam/POSTORA` public; GitHub confirms `PUBLIC`. The existing six CI jobs use standard `ubuntu-24.04`. Attempt 2 of previously authorized remote PR run 40682861422 on `aa985e0a` passed all six jobs with 56 executed steps; full job logs are retained. It does not test local `dd7257d2` and is not a push. Do not carry consultation 38's historical billing-blocker sentence forward as a freshly verified status.

## Global constraints (verbatim from parent §4)

1. Read `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md` (§3–4, §12–17, §23–28, §31–39), `PROJECT_AGENT.md`, this plan and the source spec before changing code. Follow directory-scoped instructions.
2. Implement only the numbered task(s) assigned. Do not commit, push, merge, deploy, run production SQL, modify secrets or touch the standalone n8n node repository. The orchestrator reviews and commits scoped files.
3. Preserve unrelated user work and existing API behavior. No broad refactors, platform-version migration, scraping index, Facebook insights, hashtag search, Ad Library, or optional work without explicit approval.
4. Derive caller identity from verified auth. Service-role reads and writes must structurally enforce resource ownership, including denormalized user IDs and post/account links. RLS alone does not protect service-role work.
5. Null means unavailable, never zero. Failed reads/writes are failures, never empty data or successful syncs. Validate untrusted inputs/responses, sanitize client errors, redact logs, and log every refusal/early exit.
6. No token-prefix heuristics, raw tokens in frontend/contracts/logs, browser-readable new credentials, or provider URLs containing credentials in logs. Provider calls use explicit timeout, bounded retries and trusted-host cursor construction.
7. Scheduled and on-demand work uses atomic durable claims, expiring leases, checkpoints, idempotent upserts and bounded wall-clock/request budgets. No unbounded waitUntil jobs or browser-owned scheduling.
8. Keep UI → application ports/domain; infrastructure implements ports; only feature composition roots wire infrastructure. React Query hooks belong to UI, not framework-independent application modules. New modules must have real production callers.
9. Rehearse additive migrations and tenant-negative tests before release. Apply and verify prerequisites before deploying dependent functions/frontend. Enable new schedules only after functions boot and readiness is verified.

Additional boundary: accepted migrations, direct refresh, OAuth/shared utilities and DTO v1 are immutable unless a separately reviewed additive contract explicitly needs a compatible new object. Preserve unrelated untracked journey. Collection OFF, credential mode legacy, PR draft, no competitor implementation. No production access is necessary for these local slices.

## Numbered tasks

### P1 — Additive SQL prerequisite only

Initial author: MiniMax Flash. Scope: new `supabase/migrations/20261028110000_meta_page_token_reconciliation.sql`, new `supabase/tests/meta_page_token_reconciliation.sql`, and new `supabase/tests/meta_page_token_reconciliation_race_fixture.sql`. Inventory confirms `20261028100000` already belongs to the accepted alias migration; `20261028110000` is unused at contract freeze. Do not add a begin wrapper, new table, operation enum or capture-projection change. No TypeScript/CI/runner/docs/accepted migration edits by implementer.

Implement the exact spec writer and nonsecret result with controlled search_path and explicit PUBLIC/anon/authenticated revocation; grant only the callable seam to service_role. Reuse accepted capture/lock/state/failure primitives rather than a second credential/capture store. Do not create schedules. Use stable existing MAR SQLSTATE classes where applicable. Comments explain User grant preservation, selected-only effects, unknown expiry and provider-assertion limitations.

The orchestrator registers the new suite/manual fixture in `scripts/db-harness.sh` and documents their inventory in `supabase/tests/README.md`, preserving every existing suite and assertion. Then freeze a new immutable candidate.

Acceptance: full isolated PostgreSQL17/UTC baseline plus all existing/new suites, cross-owner and browser-denial tests, strict key/null/token/identity refusals, exact User secret/revision/expiry and unselected-sibling preservation, selected IG generation/FB fence advance, retained reauth/refresh/metadata/scopes, success clears only selected failure evidence, closed/expired/superseded/competing consume, original binding/membership/revision drift, and real observed two-session lock/expiry/reconnect/deletion/job-result controls. Verify actual final catalog privileges and prerequisite byte preservation. Failed preparation remains retained. SQL acceptance alone is not a completed runtime module or owner milestone.

### P2 — Maintained types and adapter/provider/route integration

Only after P1's SQL contract is independently accepted: add final new RPC signatures to maintained DB types and verify against the catalog. Implement feature-owned Page reconciliation modules under `supabase/functions/refresh-tokens/`, with active callers in the existing composition root. Keep direct modules/behavior intact except the smallest additive dispatch seam. Exact files and maximum module count are frozen in its separate brief; no generic framework.

Implement the spec's bounded same-capture provider procedure, strict raw RPC envelopes and operation-specific result validation. Preserve admin/cron/manual/bulk/sweep/legacy behavior. Add tests and additive registrations to existing required CI lanes; no new paid runner or gate exclusions. Return stable sanitized incomplete/reconnect/deferred outcomes instead of invented refresh successes. Do not call the User-rotation writer.

Acceptance: actual registered-handler positive/negative controls, real adapter-to-SQL calls, Page provenance/subject/canonical identity and binding agreement, explicit unknown expiry, unchanged User grant/siblings, zero provider/write on malformed auth/settings/unsupported inputs, unknown errors not counted, attributable failures/alerts only, finite budgets/cursor hardening/redaction, stale/lost responses, relocated positive and behaviorally broken-copy negative. Run immutable full Node/Deno/typecheck/build/comparator and lint/i18n no-regression gates; manual guards and read-only final review; exact staged bytes before local commit. No push/deployment.

### P3 — Owner collector, report and UI handoff

Only after P2 acceptance, continue parent owner tasks 4/6 → 5/10 authenticated report reader/API/proxy → 9 owner UI → whole-flow verification, one independently accepted slice at a time. Use accepted owner claim size 25 and frozen report DTO v1. Provider-day alignment and direct media classification remain evidence gates; never invent observed wire support. UI requires reference-grounded design first. Do not implement competitor discovery/collection/UI as part of this handoff.

## Review verdicts

| Review | Finding/decision | Verdict | Reason |
|---|---|---|---|
| Astra 38 | Reconcile Page tokens without speculative User renewal | accept | Supported derivation procedure; no unsupported grant-rotation claim |
| Astra 38 | Reuse captured User authority, add distinct atomic success writer | accept | No second secret store; exact target and full captured grant must remain fenced |
| Astra 38 | Permit explicit unknown Page expiry | accept | No inherited User expiry, stale old expiry or invented lifetime |
| Astra 38 | Known local expiry/missing material is not provider revocation | accept | Reconnect/defer truthfully without fabricated health evidence |
| Astra 38 | Historical hosted billing blocker | historical only | Repository is now public and an actual rerun is underway; await executed-step results |
| Astra 39 | Locked binding evidence plus captured versions; no begin wrapper | accept | Supported lifecycle writers advance the relevant fences; raw unfenced service writes remain an explicit limitation |
| Astra 39 | Exact request/result and selected-only transactional effects | accept | Preserve User grant, siblings and reauth; validate active state and post-wait capture/User expiry |
| Astra 39 | Proposed migration version collides with alias migration | accept and corrected | Directory confirms `20261028100000_meta_oauth_identity_alias.sql`; new version is `20261028110000` |
| Astra 39 | Six calls still require one overall provider deadline | accept | Four-second persistence reserve remains required; individual timeouts cannot consume it |
| Astra 39 | Exact protected Page matching can bound portfolio work | accept for P2 | Same-capture-context binding read may permit early stop; retain documented `/accounts` token derivation |
| Astra 39 | Hosted status green only for `aa985e0a` | accept | Six executed successful jobs do not cover any unpushed revision |
| Astra 40 | SQL permits NBSP/BOM at credential boundaries | accept; bounded correction verified | New validators explicitly reject the ECMAScript trim set at either boundary; preserve valid literals and opaque IDs |
| Astra 40 | Repository must reproduce actual post-admission waits | accept; verified | New capability/fence holder modes and fresh-stat observer were independently replayed through the actual repository fixture |
| Astra 40 | Existing late-expiry transaction checks need no lock-framework rewrite | accept | Five independent observed waits prove pre-deadline commit and capture/User-expiry rollback |
| Astra 41 | Accept only the local SQL prerequisite after exact-byte staging | accept | Tested/staged/committed tree is exactly `fe6ed37567f7d868a38cff89a2c6d045a6a7fd58`; runtime callers and live verification remain pending |
| Astra 41 | Two wording caveats are documentation follow-ups, not material holds | accept and retain | Expiry must be set before capture for MAR07; privileged postgres EXECUTE is not literal owner-only access |

## Contract review completion

Consultations 38–39 are read-only and independently adjudicated above. Astra disclosed using supplied source/evidence after prior policy-denied reads; no fresh advisor-side inspection or tests are claimed. The migration collision was independently confirmed and corrected before dispatch, not ignored as a suffix change. Freeze this spec and plan as separate local commits, then dispatch only P1. Contract acceptance is not SQL implementation acceptance, protected-refresh completion, whole-owner acceptance or release approval.

## P1 acceptance boundary and retained follow-ups

P1 is now accepted only as the local prerequisite described in the linked parent acceptance record. No HTTP consumer is implemented by this commit. Freeze its SQL/catalog contract before P2; do not relabel local SQL acceptance as runtime completion or permission to merge/deploy.

- Before the manual fixture's next reuse, make C14/C16 ordering explicit: set known User expiry **before taking the capture**. Shorten a capture deadline after capture. A User-expiry edit after capture is correctly `MAR04` mismatch, not the intended `MAR07` late-expiry case. The accepted independent replay used the correct order and recorded actual waits and complete rollback. Do not silently amend the frozen fixture or claim amended bytes were tested as the accepted tree.
- Clarify the older helper header's “owner alone” wording in a separately scoped documentation change: privileged `postgres` retains default EXECUTE, just as for accepted refresh RPCs. Browser roles and direct service-role helper calls remain denied. Actual executable ACLs, not that header, define the boundary.
- Named memory/brainstorming/guard tools and graph CLI were unavailable; retained manual/source/advisory equivalents are not named-tool passes. Live configured-version Meta validation, retention/cleanup readiness and the whole owner journey remain later activation gates.
