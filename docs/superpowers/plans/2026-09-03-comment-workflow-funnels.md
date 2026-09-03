# Comment Workflow — Implementation Record

**Spec:** `docs/superpowers/specs/2026-09-03-comment-workflow-funnels.md`
**Branch:** `feat/comment-workflow-funnels`
**Status:** Built. This document records what was done, in the order it was done, and what remains.

The original forward-looking plan was superseded twice: once by a codebase review that rejected a parallel webhook and a workspace-scoped schema, and once by an adversarial Codex review that rejected the revised plan on twelve counts. Rather than leave a plan describing work that was not done, this is the record of what was.

---

## Order of work

Each slice was committed only after its own gates passed.

### 1. Schema and harness suite — `22acbf63`
`supabase/migrations/20260904120000_comment_workflow.sql`, `supabase/tests/comment_workflow.sql`, registered in `scripts/db-harness.sh`.

Three tables, one view, one validation function, one composite key added to `media_files`. The suite proves cross-owner, cross-platform and cross-media rejection, every CHECK, one event per comment, claim uniqueness, RLS denial on all three tables and the view, and that the flag ships off.

**Gate:** `bash scripts/db-harness.sh supabase/tests/comment_workflow.sql` — 18 suites, all green.

**Mutation-checked:** flipping the view's `security_invoker` to false makes the suite fail on "the stats view does not leak across users", so the assertion is real.

### 2. Matcher, adapter, engine — `1033e29c`
`_shared/commentWorkflowRules.ts`, `_shared/metaPrivateReply.ts`, `_shared/commentWorkflow.ts`, plus tests and four one-word exports added to `_shared/commentActions.ts`.

**Gate:** `deno test` + `deno check` on each new module.

**Mutation-checked, four mutations:**

| Mutation | Caught |
|---|---|
| never release the usage claim | yes |
| ignore the seven-day window | yes |
| move the usage claim after the sends | yes |
| send a DM on Threads too | **no** — fixed the test, then re-verified |
| treat a rule-read error as no rules | equivalent mutant (same observable behaviour) |

The Threads gap is worth recording: the test asserted that no `/messages` call was made, which held even with the platform guard removed, because a Threads account has no linked Page and the adapter fails before the network. The assertion is now on `dm_status`.

### 3. Ingestion wiring — `f9fcb5a2`
`facebook-instagram-webhook/index.ts` (now delegating to a new `commentRouting.ts`), `_shared/threadsCommentIngest.ts`.

Routing was extracted from `index.ts` because that file registers its server at module load, so nothing in it could be tested. Both paths now do the whole decision in one background task.

**Gate:** the full edge suite — 1398 passed, 0 failed, 41 ignored.

**Mutation-checked:** letting a claimed comment continue to the handler fails the routing test.

### 4. Frontend — `e130368b`
`src/features/comment-workflow/**`, `src/pages/automation/CommentWorkflowPage.tsx`, plus the flag, the route, the nav entry and the generated types.

**Gates:** `bun run typecheck`, `bunx eslint` on the new files (0 errors, 0 warnings), `bun run test` (1341 passed, 15 skipped, 0 failed), `bun run build`. Repo-wide lint is unchanged at its pre-existing 1420 problems.

---

## What the reviews changed

The Codex review is the reason for most of what follows. Each was verified against the code before being acted on.

| Objection | Verified | Outcome |
|---|---|---|
| `social_accounts` already has `UNIQUE (id, user_id)` and `(id, user_id, platform)` | yes, both, in the live schema | dropped the redundant constraint; the FK now uses the triple, which binds platform structurally |
| Threads mentions reach the same ingest door | yes, `threads-webhook` and `threads-mentions` both pass `kind: "mention"` | mentions refused before matching |
| `threads-webhook` awaits ingestion on the response path | yes | the whole routing decision moved into `runInBackground` |
| Releasing the claim after a timeout can double-send | yes, `callGraph` flags an unreachable upstream separately | `indeterminate` added; such a leg keeps the claim |
| `media_files` insert policy does not constrain `file_path` | yes | `ownedStoragePath` applied before signing |
| The flag needs `FLAG_KEYS` and `baseFromDb` too | yes, seven sites in total, plus `FeatureFlagIndicator` | all eight edits made |
| `ARRAY['']` passes `cardinality(...) > 0` | yes | a validation function rejects blank array entries |
| `src/features/` is the convention | yes — connectors, partner-hub, webhook-observability, whatsapp-inbox | the frontend follows it |
| Separate arrays cannot prove send-vs-write ordering | yes | one shared timeline |
| No Meta ingestion regression test | yes | routing extracted and tested |

**Declined, with reasons.**

- *Move the edge engine out of `_shared` into a feature-owned module.* The deploy model copies `_shared` and each function directory into the functions volume; a sibling directory is not deployed. `_shared` is the only place two edge functions can share code here, which is why `commentAutomation.ts`, `autoReplyRules.ts` and `threadsCommentIngest.ts` already live there.
- *Build a leased, fenced state machine with recovery for `pending` rows.* This is a durable queue, and a substantially larger piece of work than the feature. The event row is written before any send so a killed worker is visible rather than silent; the limit is stated in the spec rather than hidden.
- *Emit an informational `comment.workflow_handled` event to n8n.* A real gap, but it is a new external contract and belongs to whoever needs it. The spec records the decision and the shape it should take.

---

## Remaining, in order

1. **Merge**, flag off. The code is inert until step 4.
2. **Apply the migration** on production via `ssh-contabo-mcp`, rehearsed first on a throwaway database — a Postora migration self-commits, so an outer `BEGIN` does not rehearse it. Then `NOTIFY pgrst, 'reload schema'`, or the stats view stays invisible to PostgREST.
3. **Deploy the edge functions** through the volume copy and SHA256 verification in `docs/runbooks/deploy-edge-function.md`. Changed files: `_shared/commentWorkflow.ts`, `_shared/commentWorkflowRules.ts`, `_shared/metaPrivateReply.ts`, `_shared/commentActions.ts`, `_shared/threadsCommentIngest.ts`, `facebook-instagram-webhook/index.ts`, `facebook-instagram-webhook/commentRouting.ts`.
4. **Turn the flag on** and smoke-test: one `exact` rule on a test post, comment from a second account, confirm a public reply, a DM, one `sent/sent` event row, and that a second identical comment records `skipped / already_served`. Then set the account's handler to `n8n` and confirm the claimed comment does **not** reach the subscriber.

An admin can reach the page the moment it merges, since admins receive every non-visibility flag. Step 2 should follow the merge promptly rather than sit.
