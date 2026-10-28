# O1 — bounded authenticated owner intake and status

Status: accepted locally at `bf74af2a`. [Spec](../specs/2026-10-28-instagram-owner-intake.md) · [parent milestone order](2026-10-26-instagram-insights-and-competitor-tracking.md#14-user-approved-sequential-milestone-gates-2026-10-27). O1 authenticated owner intake and status endpoint is accepted locally with all 14 independent automated gates green, 25 real-SQL store scenarios, 16 registered-route real-SQL scenarios, 30 actual boundary controls, and zero regressions. O1 is the first small part of parent Tasks 4/6; worker/collection is Slice O2.

Read-only Astra consultation **45** approves a real user-JWT enqueue/status boundary over the unchanged SQL, before combining service collection, provider credentials, metrics and checkpoints. It discloses using supplied source contracts after prior policy-denied reads, not fresh advisor-side inspection/tests. Initial work stays MiniMax Token Plan `minimax-coding-plan/MiniMax-M3.1-Flash`; corrections Grok `grok-4.7-build-fast/high`; advisor read-only.

## Exact implementer scope — seven paths

1. New `supabase/functions/instagram-insights-sync/index.ts`: environment/client composition and actual Deno.serve registration.
2. New `supabase/functions/instagram-insights-sync/handler.ts`: strict request/auth/settings/deadline/response use case and ports.
3. New `supabase/functions/instagram-insights-sync/store.ts`: user-context-only accepted RPC invocation and strict projections.
4. New `supabase/functions/instagram-insights-sync/handler.test.ts`.
5. New `supabase/functions/instagram-insights-sync/store.test.ts`.
6. New `supabase/functions/instagram-insights-sync/handlers.test.ts`: actual registered index, relocation and behavioral copied-root mutation.
7. `.github/workflows/ci.yml`: additive required owner-intake step/arrays in the existing Deno job, preserving every old lane, runner, permission, timeout and exemption. No new paid runner, job, dependency, skip or no-check exemption.

Maximum **three new production modules**, all with active production callers. No SQL, maintained-type, shared-helper, config, package/lockfile, OAuth/refresh, frozen report DTO, frontend, competitor or schedule change. Orchestrator-owned spec/subplan/tracker records are separate from the implementer's allowlist. Preserve the unrelated untracked journey; no branch/worktree switch. Implementer does not stage, commit, push, merge, deploy, access production or change settings.

## Contract checkpoints

- Authenticated-only SQL is not callable as service_role. Keep the same server-verified JWT on the owner RPC client; no user ID substitution or admin override. Service use is settings/sanitized logging only.
- Both enqueue/status require enabled collection and protected mode. Off returns before new-schema access. Failed settings are unavailable, never defaults. No settings are written.
- Freeze exact none/full status variants: scalar pending count only for actual jobs, no job_id, explicit nullable fields, exact target and optional requested-date agreement. SQL selects omitted-day Kuwait date.
- One 15-second deadline, five-second dependency ceilings and one-second logging reserve; 4-KiB streaming body limit. Lost write outcome is indeterminate with no automatic retry or status-read substitute.
- SQL owns throttle/idempotence/force generations; endpoint does not claim collection success. No provider/worker/drain scaffold is included.

## Required independent gates

1. Focused store/handler and actual-index tests/typechecks, including raw-driver/accessor/auth/settings/body/calendar/date/secret controls and exact off-state zero-schema behavior.
2. Disposable real-SQL adapter tests using authenticated role/claims; owner isolation, actual service-role denial, both status variants, force/throttle/normal/completed semantics, write ambiguity and cleanup. Accepted migration/fixture bytes and executable catalog unchanged.
3. Relocated positives and copied identity/routing mutation fail behaviorally while original source remains unchanged.
4. Full immutable existing protected Deno/report/outlier/proxy/SQL gates, complete Node/typecheck/build/comparator/lint+i18n no-regression inventory, plus the newly required O1 tests. Reduce local concurrency if needed, never timeouts or assertions; retain failed attempts.
5. Disclosed manual production/test guard equivalents where named tools remain unavailable, final Astra read-only review, exact staged/committed blobs and full-tree identity before a scoped local commit. No acceptance based on delegate self-report.

## Next and release boundary

After O1 acceptance, separately bound the service-side owner collector using existing claim/context/progress/snapshot/complete/throttle contracts: owner claim cap25, lease120s, credential/job-generation fencing and provider/ingestion evidence. Then DB report reader/authenticated API/proxy → reference-grounded owner UI → complete owner journey. Do not implement competitors first. Parent quota/history/soft-removal and frozen DTO v1 remain unchanged.

Milestone **2 of 4** remains incomplete. PR294 stays draft, legacy active, collection OFF. Hosted green covers remote `aa985e0a` only, not local accepted slices. No new-work push, merge, production migration, deployment, cutover or activation is implied. Live configured-version Meta and provider-day/media-classification readiness remain later gates, not invented fixtures.

## O1 local acceptance evidence (2026-10-29)

- **Commit**: `bf74af2a` (`feat(instagram): add authenticated owner insights intake and status endpoint`).
- **Files**:
  - `.github/workflows/ci.yml` (additive owner intake CI steps)
  - `supabase/functions/instagram-insights-sync/index.ts`
  - `supabase/functions/instagram-insights-sync/handler.ts`
  - `supabase/functions/instagram-insights-sync/store.ts`
  - `supabase/functions/instagram-insights-sync/handler.test.ts`
  - `supabase/functions/instagram-insights-sync/store.test.ts`
  - `supabase/functions/instagram-insights-sync/handlers.test.ts`
- **14 Independent Automated Verification Gates**:
  1. `owner-intake-six-file-typecheck`: passed (2.02s)
  2. `owner-intake-pure`: passed (96 tests passed, 0 failed, 18.35s)
  3. `owner-intake-actual-route`: passed (23 tests passed, 0 failed, 8.00s)
  4. `independent-boundary-controls`: passed (6 tests passed, 0 failed, 1.62s)
  5. `required-protected-pure`: passed (222 tests passed, 0 failed, 4.02s)
  6. `required-actual-handlers`: passed (206 tests passed, 0 failed, 12.02s)
  7. `outlier`: passed (28 tests passed, 0 failed, 1.25s)
  8. `report-v1`: passed (62 tests passed, 0 failed, 1.51s)
  9. `historical-proxy-mcp`: passed (147 tests passed, 0 failed, 1.01s)
  10. `typecheck`: passed (79.60s)
  11. `full-node`: passed (2,211 tests passed across 320 files, 15 skipped across 2 files, 542.26s)
  12. `production-build`: passed (39.24s)
  13. `comparator-self-tests`: passed (99.39s)
  14. `immutable-no-regressions`: passed (253.64s, zero regressions against base `a57dc86d`)
- **Real-SQL Database Evidence (PG17 container)**:
  - 25 store scenarios passed with clean rollback and audit receipts.
  - 16 registered HTTP route -> SQL scenarios passed with authenticated role and claim verification.
  - 24 preflight role/policy/grant scenarios passed.
- **Boundary Controls**:
  - 30/30 registered index boundary controls passed with non-blocking stream cancellation and raw-envelope descriptor validation.

