# Handover: project status on 2026-10-31

**Written:** 2026-10-31 · **For:** the next person or agent working on Postora.

**Before you start:** read `ARCHITECTURE.md` before touching `src/**` or `supabase/functions/**`. Nothing loads it automatically. `CLAUDE.md` sets the task workflow and the deploy rules. This file records state; it does not restate those rules.

This is a point-in-time snapshot. Once something here is merged or decided, the PR or the linked spec is the current record, not this file.

---

## 1. State of `main`

`main` is at `dadf2c24` (#322). Everything below is merged. Edge-function changes are live, because a Dokploy schedule syncs `supabase/functions/**` from `main` about every two minutes.

### Merged on 2026-10-31

| PR | What | Production check |
|---|---|---|
| #319 (with #318) | **Scheduler lease.** Adds the `cron_run_leases` table and the `acquire_cron_run_lease` / `release_cron_run_lease` RPCs. `process-scheduled-posts` takes a 5-minute lease scoped to its holder and renews it after every post. It stops at `RUN_BUDGET_MS = 100000`, answers 503 if it cannot get the lease, and always releases it at the end. This stops two overlapping runs from publishing the same post twice. | Deployed hash matches `main`. Scheduler runs clean. The lease table is empty between runs. |
| #320 | **Instagram release-gate docs after #317.** Updates migration versions `20261031090000`, `…091000` and `…092000` in §5 of `docs/specs/2026-10-30-instagram-release-gates.md`, records two deviations, and defines a substitute for the migration ledger (see §4). Matching plans are updated under `docs/plans/`. | Docs only. |
| #321 | **Lint batch 0.** Fixes all 66 non-`any` ESLint errors, with no suppression comments. Also fixes `escapeMarkdownLabel` in `src/components/media/embedSnippets.ts`: the old replacement `"\\$&"` did nothing, so a file name could inject a link into the Share/Embed snippet. It now escapes `[`, `]` and `\`, and has tests. | The SHA256 of all 11 changed edge-function files matches `main`. |
| #322 | **Ultracave voice.** The SessionStart hook `.claude/hooks/caveman-ultra.mjs` injects the caveman `ultracave` rules into every Claude Code session in this repo. The rules are vendored under `.claude/hooks/caveman/` (Apache-2.0). They live there because `.gitignore` shares only `settings.json` and `hooks/` from `.claude/`. | n/a |
| #273 | Notes on installing the Cloud Agent and running the dev server. | Docs only. |

Earlier in the same week: Instagram collection rollout controls (#317), Instagram retry and reel fixes (#315, #316), `process-post` type-checking on Deno 2.9 (#314), atomic story recording (#313), moving off Cloudinary to Openinary (#301, #303, #304, #308), Resend hardening (#305, #307), and direct uploads over 10 MB (#295).

### What looked like duplicate publishing

- The Oct 26 "duplicates" were not duplicates. They were one feed post plus one story (`instagram_post_type ["feed","story"]`).
- In the last 180 days, the only true duplicates are two posts on Oct 31, caused by overlapping scheduler runs. #318 and #319 fix this.

---

## 2. Open work

### PR #323: `no-explicit-any` batch 1 (`src/hooks`), draft

- Removes 117 of the 121 errors in 33 files, which takes lint errors from 1,341 to 1,224.
- No suppression comments.
- Locally: `tsc` is clean apart from the known error below, 451 tests pass, and the lint regression gate passes.
- At the time of writing it was waiting on CI and on the owner's go-ahead to merge.
- What it leaves on purpose:
  - **4 `as unknown as` casts in `useCanvasWorkflow.ts`.** `@xyflow/react` `Node[]`/`Edge[]` and the `Json` columns share no type.
  - **`useAIConfiguration.ts:154`.** `ai_models.admin_params` is missing from the generated types.
  - **3 × `(supabase.auth as any).oauth` in `useOAuthConsent.ts`.** See the bug below.

### Remaining `no-explicit-any` errors (about 1,224 after #323)

| Area | Count, approximate |
|---|---:|
| `supabase/functions/_shared` | 296 |
| `src/components` | 193 |
| `supabase/functions/partner-api` | 119 |
| `supabase/functions/n8n-api` | 87 |
| `src/pages` | 86 |
| `supabase/functions/whatsapp-evolution-bridge` | 55 |
| `supabase/functions/messaging-api` | 34 |
| other edge functions | the rest |

About 345 of these are in test files.

The owner approved continuing in batches, one PR per batch. Batch 1 handled the source files and the test files with two agents in parallel, each on its own set of files. That worked.

**`n8n-community-node/nodes` (18 errors) is a directory in this repo.** `CLAUDE.md` says the real node lives in a separate repo. Leave that directory alone until the owner says whether it should exist here at all.

### Bug found, not fixed: the OAuth consent page reads the wrong fields

`src/hooks/useOAuthConsent.ts` reads these fields:

| The code reads | auth-js 2.118 returns |
|---|---|
| `data.redirect_to` | `redirect_url` |
| `data.client.icon` | `client.logo_uri` |
| `data.scopes` (an array) | `scope` (a space-separated string) |

If the self-hosted GoTrue returns what the SDK types say, three things break:
- the auto-redirect never fires;
- the scope list is always empty;
- the client icon never shows.

**Check the real response from `api.postora.cloud` first, then fix it in its own PR.** Fixing it also removes the last 3 `any`s from that file.

### Deferred by the owner

- **Permit guard on the paid Apify path.** The owner explicitly deferred it. Do not start it without asking.

### Small follow-ups

- **Regenerate `src/integrations/supabase/types.ts`.** At least `ai_models.admin_params` is missing, and there may be more.
- **One known `tsc` error on `main`:** `src/components/post/BlueskyMediaValidation.tsx(123,50) TS2345`. A `TFunction` doesn't match the expected translate signature.
- **Merged remote branches can't be deleted from the cloud session.** The git proxy returns HTTP 403, so the owner deletes them in the GitHub UI.

---

## 3. Gotchas that are not obvious from the code

- **The lint gate is stricter than "no new errors".** `scripts/ci/lint-i18n-regression.mjs` refuses any new suppression comment (`suppression_added`). It also refuses any diagnostic of any rule on a line the PR touches (`new_diagnostics`), even one that was already there. If you edit a line that holds an old `any`, fix that `any` too. Run the gate locally before pushing:
  ```bash
  node scripts/ci/lint-i18n-regression.mjs --event pull_request --base "$(git merge-base origin/main HEAD)" --head HEAD --report /tmp/gate.json --summary /tmp/gate.md
  ```
- **`deno-lint-ignore` applies only to the next line.** Don't put another comment between it and the line it suppresses.
- **Cloud sessions can't reach esm.sh.** Deno tests that import from it, such as `n8n-api/postMediaDelete.test.ts`, run only in CI.
- **Edge-function deploys.** `main` syncs to the functions volume on its own. After a merge, verify by comparing SHA256 hashes in `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/` with `git show main:<path>`. Never use `npx supabase functions deploy`. `docs/runbooks/deploy-edge-function.md` has the manual path.
- **Migrations.** The self-hosted DB has no `supabase_migrations.schema_migrations` ledger. Apply migrations from a fetched ref, as `CLAUDE.md` step 7 and the runbook describe. Never use the dirty working tree in `/root/postora-runtime`, and never `git reset --hard` it. The ledger substitute (lineage matching) is in §5 of the release-gates spec.
- **The Edge worker lifetime is 150 s.** Long loops need a time budget, like the 100 s budget in `process-scheduled-posts`.

---

## 4. Where the records live

| Topic | Current record |
|---|---|
| Layering, security rules, and which agent doc owns what | `ARCHITECTURE.md` (§0 is the document map) |
| Task workflow, MCP routing, deploys | `CLAUDE.md` |
| Instagram release gates and the migration-ledger substitute | `docs/specs/2026-10-30-instagram-release-gates.md` |
| Instagram rollout plans | `docs/plans/2026-10-30-instagram-*.md` |
| Large media uploads and deferred publishes | `docs/runbooks/large-media-uploads.md` |
| Fix history across sessions | the mem0 MCP, `user_id="HP"`, `app_id="lolotam-postora"` |
