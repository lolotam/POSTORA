# Instagram publish timeouts — implementation plan

Spec: `docs/superpowers/specs/2026-10-30-ig-publish-timeout-design.md`. The owner approved the
order 1 → 2 → 4, with 3 once agreed.

| Step | State | Branch / PR |
|---|---|---|
| 1. Worker lifetime 150 s | **Done** (prod, verified) | server-only `main/index.ts` |
| 2. Publish settled from the container | Review | `fix/ig-publish-timeout`, PR #315 |
| 3. Correct the two live records | **Done** (prod, verified) | SQL, one transaction |
| 4. Retry guard | This plan | `fix/ig-retry-guard` |

The local toolchain, every time, from `supabase/functions/process-post`:

```bash
SP=/tmp/claude-0/-home-user-POSTORA/fac76cf6-3ff9-5ccb-81e4-64ed061ac508/scratchpad
export DENO_DIR=$SP/deno298-cache DENO_CERT=/root/.ccr/ca-bundle.crt
D="$SP/deno298/deno"; F="--no-lock --node-modules-dir=none --import-map=$SP/import_map_pin.json"
$D check $F index.ts && $D test $F -A . ; rm -f deno.lock
```

---

## Step 2 — finish PR #315

- [x] Rewrite per the Codex P1 and 9 MergePilot findings (commit `36db47c9`).
- [x] Reply to and resolve all 10 threads; update the PR body.
- [ ] Wait for CI ("Typecheck and test process-post") and the re-review. Fix and push any new
  finding (no round limit), replying on each thread before the push.
- [ ] Merge (squash) when CI is green, no thread is open, and there is no conflict.
- [ ] Deploy check, about 2–3 minutes after the merge. Compare the volume against `main` for
  `process-post/{index,instagramPublish,deferredPublish}.ts`:
  `sha256sum` in `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`
  against `git show origin/main:<path> | sha256sum`.
- [ ] Watch the next real Instagram reel in the edge logs. Expect either a normal publish, or
  `publish attempt N went unanswered … container is …` followed by a deferral, never
  "Request timed out" as a failure.

## Step 4 — retry guard

Start only after #315 is merged, because both change `process-post/index.ts`. Then run
`git merge origin/main` into `fix/ig-retry-guard`.

### Task 4.1 — the pure rule, test first

Files: `process-post/instagramRetryGuard.ts` and `process-post/instagramRetryGuard.test.ts`.

```ts
export const RETRY_STATUSES = new Set(["failed", "completed"]);
export const RETRY_LOOKBACK_MS = 10 * 60 * 1000;

export type RetryGuardDecision =
  | { kind: "publish" }                                   // no evidence it is live
  | { kind: "already_live"; media: MediaSummary }         // one copy
  | { kind: "already_live_copies"; count: number };       // two or more

export function isRetryRun(postStatus: string | null | undefined, resume: boolean): boolean;
export function retryWindowStart(post: { created_at: string; scheduled_at?: string | null }): number;
export function retryGuardDecision(
  media: MediaSummary[], caption: string | null | undefined, notBeforeMs: number,
): RetryGuardDecision;
```

Tests, which should fail before the code is written:

- one caption match after the window → `already_live`;
- two matches → `already_live_copies` (2);
- no match, a match before the window, or an empty or whitespace caption → `publish`;
- `isRetryRun`: `failed` and `completed` give true; `pending`, `scheduled` and `processing`
  give false; a resume run gives false;
- `retryWindowStart` takes the later of `created_at` and `scheduled_at`, minus 10 min.

Refactor: `matchPublishedMedia` (from #315) becomes a thin wrapper over a shared
`captionMatches(media, caption, notBeforeMs)`, so the two cannot drift. Its existing tests stay
as they are.

### Task 4.2 — wire it into both logins

File: `process-post/index.ts`.

1. Keep the entry `post.status` (read before the run sets `processing`) and pass
   `retryRun = isRetryRun(post.status, !!resume)` into both IG posters through the existing
   options and context object. Do not add a new global.
2. `findPublishedMedia` → `listRecentMedia(mediaListUrl, token, limit)`. It returns
   `MediaSummary[] | null`, where `null` means the read failed (non-200, timeout or exception),
   and uses an 8 s timeout. The step 2 resume path keeps calling `matchPublishedMedia` on its
   result.
3. Add a guard at the top of `postToInstagram` and `postToInstagramBusinessLogin`, before any
   container is created and only when `retryRun && post.caption && !storyOnly`:
   - `null` → `console.warn("[instagram] retry guard could not read media; publishing")`, then
     continue;
   - `already_live` → return success with `{ id, url: permalink }` and the warning from the
     spec. Business Login uses `insertIGRow` with the id and permalink, **without**
     `enrichInBackground`, because comments are not re-run.
   - `already_live_copies` → return success with no id and the N-copies warning.
4. Log one line per decision: `[instagram] retry guard: <kind> for post <id> account <id>`.
   Never log the token.

### Task 4.3 — validate

- [ ] Run the toolchain above: `deno check` clean, `deno test process-post/` all pass.
- [ ] Guard pass: `clean-code-guard` on `instagramRetryGuard.ts` and the `index.ts` diff, and
  `test-guard` on the new tests.
- [ ] Re-read the diff for a first-run path that could reach the guard. There must be none,
  because `isRetryRun` is false for `pending` and `scheduled`.

### Task 4.4 — ship

- [ ] Commit scoped to the files of this branch: `git commit -- <files>`, including the spec and
  this plan.
- [ ] Push, open a draft PR, subscribe, mark it ready, then CI → reviews → merge.
- [ ] Deploy check: compare `index.ts` and `instagramRetryGuard.ts` SHA256 in the volume against
  `main`.
- [ ] Live check on a test account: take a failed IG row whose post is live and retry it. The row
  must become success with the existing permalink, and no new media item may appear in
  `/tmp/igmedia.sh <account>`.

## Wrap-up

- [ ] mem0 `add_memory`: issue, root causes A and B, steps 1–4, files, and the server-only
  `main/index.ts` gotcha.
- [ ] Final report to the owner, in Arabic.
- [ ] Remove the worktrees `/home/user/POSTORA-reel` and `/home/user/POSTORA-retry` after their
  merges.
- [ ] Follow-ups, still open:
  - Threads publish timeout;
  - the `graphId` guard on the other 11 paths (owner's choice أ/ب).
