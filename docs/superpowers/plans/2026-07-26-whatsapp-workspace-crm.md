# WhatsApp Workspace CRM — Implementation Plan

**Design:** [`../specs/2026-07-26-whatsapp-workspace-crm-design.md`](../specs/2026-07-26-whatsapp-workspace-crm-design.md)
**Branch:** `feat/whatsapp-workspace-crm` (off `deefc7d8`)

Implementation is delegated to the OpenAI Codex CLI one task at a time via the
`codex-delegate` skill. Codex never commits; each task is reviewed, re-gated, and
committed by the orchestrator.

## Execution order

The order below is **not** the order the tasks were originally numbered. It follows
the dependency and risk constraints found during orientation.

| # | Task | Why here |
|---|---|---|
| 1 | **T8** Remove flow scaffolding | `npm test` is red on the baseline. Until this lands, every later gate run shows inherited failures and reviews cannot tell new breakage from old. Small and mechanical. |
| 2 | **T1** Database contracts | Everything else depends on the real table, column, and RPC names. A wrong name here means rework in every later task. **Checkpoint with the user after this commits.** |
| 3 | **T3** Secure account access | Fixes a live cross-tenant leak. Highest severity, and it does not depend on any UI work. |
| 4 | **T2** Workspace invitations | Backend service; needs T1's schema. |
| 5 | **T5** CRM data layer | Needs T1's schema and regenerated types. |
| 6 | **T6** Pipeline board | Needs T5's hooks. |
| 7 | **T7** Chat deep links | Needs T5 and T3's widened conversation contract. |
| 8 | **T4** Workspace context & team UI | Needs T2's endpoints; consumes the provider the other UI tasks read. |
| 9 | **T9** Types & documentation | Documents what actually shipped. |
| 10 | **T10** Verification | Full gate sweep + guards + security review. |

Deployment is **not** part of this plan's execution. See "Handoff" below.

## Environment prerequisites

- **Docker Desktop must be running** before task 2 (T1). The migration and its RLS
  tests are verified against a disposable local Postgres via `npx supabase start`;
  `src/integrations/supabase/types.ts` is regenerated from that same local database.
  Production cannot be used: `CLAUDE.md` records the `supabase_postora_mcp` token as
  read-only, and production has no migration tracking at all.
- `deno` 2.8.3, Node 24, `codex-cli` 0.144.1 — all verified present.

## Gates

Run after every task, by the orchestrator, never trusted from Codex's self-report:

```
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Plus, where the task touches them:

```
deno test --allow-env supabase/functions/_shared/whatsappWorkspaceAccess.test.ts
npx supabase test db          # requires Docker
```

Guard skills per the repo's `CLAUDE.md`: `clean-code-guard` on changed production
code, `test-guard` on changed tests, `docs-guard` on changed docs.

## Commit discipline

The working tree carries ~40 unrelated dirty paths (`b64.txt`, `stdout.txt`,
`stderr.txt`, `.claude/`, `graphify-out/`, `campaigns/`, deleted
`n8n-community-node/`, and more). Every commit therefore names its paths explicitly —
`git commit -- <paths>` — and never uses `git commit -a` or `git add .`. No secrets,
logs, or backups are committed.

## Scope boundaries

Dropped from the original migration rather than shipped unused: `whatsapp_flows`,
`conversation_notes`, `csat_surveys`, `business_hours`. Flow engine, notes, CSAT, SLA,
and website chat are later phases with their own designs.

## Handoff — deployment is the user's call

Deployment is outward-facing and hard to reverse: it applies a tenancy migration to a
production database that has no migration tracking, and replaces four live edge
functions. The orchestrator completes all verification and then stops, handing over:

1. Backup commands for the affected production tables.
2. The verified migration and the exact `psql` invocation to apply it.
3. The file list and hashes for `whatsapp-workspace`, `messaging-api`,
   `whatsapp-oauth`, `whatsapp-webhook`, and `_shared/` into the functions volume
   (`/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`),
   per `docs/runbooks/deploy-edge-function.md`.
4. The smoke-test matrix: owner, invited agent, viewer, outsider.

Nothing is applied to production, and no branch is pushed, without an explicit go.
