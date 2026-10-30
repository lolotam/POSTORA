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
- [x] CI on `36db47c9` is green: all 9 checks pass.
- [x] **Round 2** (`fc254a90`, `31f4d6d9` lint, `176ce358` admission). MergePilot re-reviewed `36db47c9` and opened 8 new threads. Triage:

| # | Thread (severity) | Claim | Verdict | Fix |
|---|---|---|---|---|
| R1 | `PRRT_kwDOTBx00c6yD9UX` (HIGH) | An image, carousel or story near the deadline still sends a 3 s publish past it. | **Real.** | Below `MIN_REQUEST_MS`, with nothing sent, a non-deferrable container throws "There was not enough time left to publish safely; nothing was posted. Safe to retry." and sends nothing. |
| R2 | `PRRT_kwDOTBx00c6yD9Ui` (HIGH) | Same as R1, plus: the follow-ups after publish (permalink, first comment, story mirror) only have 5 s of reserve. | **Real.** | Split the reserve. Polls end at start + 150 − 60 s, and the publish deadline is start + 150 − 30 s. That leaves 30 s for the follow-ups and the record, and a 30 s publish still fits after the poll. |
| R3 | `PRRT_kwDOTBx00c6yD9Ut` (MED) | A resume run on an old worker ignores the worker's lifetime. | **Real.** | Admission check (R4). |
| R4 | `PRRT_kwDOTBx00c6yD9U2` (MED) | A request that lands on a worker past the cutoff creates a container before any deadline is read. | **Real.** | Admission check at the top of the handler, before any claim or container: if the worker is older than 150 − 60 s, return **503 retryable** and touch nothing. **Owner decision (2026-10-30): "أ-آمن".** It applies only to callers that retry a refusal on their own: the reconciler's resume and the scheduler's run (`expected_scheduled_at` is a string). The caller audit found that the web app, n8n create, n8n/MCP retry and TikTok review do not retry a 503. Their runs still start, bounded by R1 and R2. Shipped in `176ce358`. |
| R5 | `PRRT_kwDOTBx00c6yD9U-` (MED) | The caption lookup can pick an older same-caption post, or miss the new one beyond 10 items. | **Partly real.** A reel cannot publish before its container exists. | Lower bound = `first_deferred_at − 2 min` (the container is created just before the first deferral), with `limit=25`. No match still gives success plus a warning, never a wrong id. |
| R6 | `PRRT_kwDOTBx00c6yD9VC` (MED) | A FINISHED resume that publishes drops the carried story. | **Real.** | Handled with R7. |
| R7 | `PRRT_kwDOTBx00c6yD9VJ` (MED) | Holding a live reel pending for its story ends at the give-up, with the reel recorded failed. | **Real**, and a regression this PR introduced. | A live reel (PUBLISHED, or just published) is always settled **success** now. A story still unrecorded is kept in `response_data.unrecorded_story` and gets a `system_logs` row, so it stays visible. No re-defer. |
| R8 | `PRRT_kwDOTBx00c6yD9VW` (MED) | The follow-ups can repeat when a worker dies before the settle; Business Login enriches even when `insertIGRow` returned null. | **Real**, but rare after R2. | Write one marker, `response_data.deferred.followups_started_at`, before the follow-ups. A resume that sees the marker skips them and settles success with a warning. Business Login does not enrich when `insertIGRow` returns null. |

  - Order: R1+R2 (`instagramPublish.ts`, `deferredPublish.ts`) → R7+R6 → R5 → R8 → R3+R4. Each
    step needs a failing test written first, then the toolchain run.
  - Reply on all 8 threads (commit "not yet pushed"), push, resolve them, then wait for round 3.
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
