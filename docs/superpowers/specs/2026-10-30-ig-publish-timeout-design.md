# Instagram publish timeouts: live posts recorded as failed — design

Status: approved by the owner on 2026-10-30. The approved order is step 1 now, then step 2 (merge
after review), then step 4, and step 3 once the owner agreed ("صحح كمان سجل البوستين في نفس
الوقت"). Steps 1 and 3 are done. Step 2 is PR #315. Step 4 is this branch, `fix/ig-retry-guard`.

## The incident (2026-10-30, production)

Two customer reels failed on Instagram while Facebook, TikTok and Threads succeeded.

| Post | Account | What the user saw | What really happened |
|---|---|---|---|
| `332c151b…` | `quality_light1` | "Request timed out", twice | **Live.** The 20 s `fetchWithTimeout` on `media_publish` fired at 15:03:23, and Instagram published at 15:03:26 (`/reel/DfH2vTxFdK4/`). The client retried: a new container was created and also reports `PUBLISHED`, but no second copy appears in the account's media list. |
| `1b8159e7…` | `smartenergykw` | "Publishing was interrupted" | **Live** (`/reel/DfG49pok2ST/`), recorded failed for two reasons. The request landed on a worker that was already 30 s old inside its 60 s lifetime (`workerTimeoutMs` in the server-only `main/index.ts`). The worker hit "wall clock duration reached" mid-poll, and the stale sweeper then failed the post. |

There are two root causes, both with evidence (edge logs, `platform_posts` rows, Graph API
container status and media list):

- **A. An unanswered publish is treated as failure.** Instagram keeps publishing after we stop
  waiting. On 2026-10-30, 2 of the 3 `media_publish` timeouts were in fact live.
- **B. The worker's lifetime ends mid-publish.** A reused worker can have far less than 60 s
  left, and nothing in `process-post` knew that.

The harm is that the user is told "failed" about a live post. A retry then risks a duplicate,
and every follow-up step (first comment, comment disable, story mirror, analytics) is skipped.

## Step 1 — worker lifetime 60 s → 150 s (done, prod)

- `main/index.ts` line 71 is now `const workerTimeoutMs = 150 * 1000`, which is Supabase's
  default wall clock.
- A backup is at `/root/backups/functions-main-index.ts.20261030-164759`.
- The change was applied with `docker compose restart functions`.
- Verification: the file inside the container reads `150 * 1000`, OPTIONS on `process-post`
  answers 200, and the reconciler answers 401 without its secret.
- `main/` is excluded from the Edge Functions Sync (`rsync --exclude "main"`), so this change
  survives deploys. That is also why it is documented in `docs/runbooks/deploy-edge-function.md`:
  it lives nowhere in git.

## Step 2 — `process-post` never fails a publish it cannot prove failed (PR #315)

This is the fix for root cause A, kept inside B's new bound.

- **One publish loop.** `instagramPublish.ts` `publishContainer` serves both logins.
- **Bounded by the worker.** Every request is cut to the time left before
  `workerPublishDeadline` (worker start + 150 s − 5 s to record), keeping 5 s for the follow-up
  check. With no room left, a reel is deferred unsent and the reconciler publishes it next
  minute.
- **Settled from the container.** Once any request went unanswered, the run ends through a
  bounded container check:

  | Container state | Outcome |
  |---|---|
  | `PUBLISHED` | Defer a reel; any other container gets "appears to be live". |
  | `FINISHED` | Publish again while attempts and time remain. Meta publishes a container at most once. |
  | `ERROR`/`EXPIRED` | Meta's reason. A failed status query is *unknown*, never a failure. |
  | unknown | Defer a reel; any other container keeps its error. |

- **Resumed `PUBLISHED` reels keep their follow-up steps.** The media id is recovered from the
  account's latest media: the only item with the post's caption since the first deferral minus
  10 minutes. The first comment, comment disable, story mirror and `enrichInBackground` then run.
  No match gives success plus a warning naming the skipped steps. An unrecorded story re-defers
  the reel.
- **Deferrable polls** end 45 s before the worker's end.

Done means CI is green, every review thread is answered and resolved, and the PR is merged. The
changed files must then be verified in the functions volume by SHA256 after Edge Functions Sync.

## Step 3 — correct the two live posts' records (done, prod)

This ran as one transaction and was verified afterwards:

| Row | Post | Recorded as |
|---|---|---|
| `093740d0…` | `332c151b` | success, media `18115999544269401`, `https://www.instagram.com/reel/DfH2vTxFdK4/`, posted 15:03:26 |
| `bfbc275e…` | `1b8159e7` | success, media `17867370522678126`, `https://www.instagram.com/reel/DfG49pok2ST/`, posted 06:03:09 |

On both rows `response_data.deferred` was removed and a `corrected` note was added, with
`previous_error` and the reason. Both posts are now `completed`.

## Step 4 — a retry never re-posts what is already live (this branch)

### Why it is still needed after step 2

Step 2 defers a *reel* whose publish went unanswered. Some live posts can still end as failed
rows:

- an image or carousel whose publish went unanswered while the container shows `PUBLISHED`. It
  fails with "appears to be live", because only video containers can be finished later;
- an unanswered publish whose container could not be read;
- any row a future bug records wrongly.

The user's next move is Retry. Every Retry path ends in `process-post`:

- **the web app** (`usePostRetry` deletes the failed rows, then invokes `process-post`);
- **n8n `POST /api/v1/posts/retry`** and **MCP `retry_failed_post`** (`retryFailedPost` →
  `dispatchRetry` → `process-post` with `platforms` and `account_ids`).

Each path creates a **new** container and publishes it, so the post appears twice.

### Behaviour

When `process-post` publishes to an Instagram account (either login) **for a post that already
finished once**, it first looks for the post on the account:

1. **Detecting a retry.** `post.status` read at entry is `failed` or `completed`: the only terminal
   statuses in production (`select status, count(*) from posts` on 2026-10-30 shows `completed`,
   `failed`, `scheduled` and `pending`), and the same set `retryFailedPost`'s claim accepts. A
   first run (`pending`, `scheduled`, `processing`) therefore never
   pays for the lookup and can never be suppressed by an unrelated post with the same caption.
   Resume runs are excluded: they already handle `PUBLISHED`.
2. **The lookup.** `GET /{ig-user-id}/media?fields=id,caption,timestamp,permalink&limit=25`,
   with an 8 s timeout. Matches are items whose trimmed caption equals the post's caption and
   whose timestamp is at or after `max(created_at, scheduled_at) − 10 min`.
3. **The outcome:**

   | Matches | Result |
   |---|---|
   | exactly 1 | **Do not publish.** Record success with that media id and permalink, plus a warning: "This post was already live on Instagram, so it was recorded instead of being posted again." The first comment and comment disable are **not** re-run: they ran, or were lost, with the original publish, and re-running them on a live post is a separate decision. |
   | 2 or more | **Do not publish.** Record success with no media id, plus a warning that N copies are live and the duplicates should be checked. A wrong id would send analytics and comments to the wrong copy. |
   | 0, empty caption, story-only post | Publish as today. A story is not in `/media` and expires anyway. |
   | lookup failed (timeout, non-200) | **Publish as today**, and log `[instagram] retry guard could not read media`. This keeps the old behaviour on a Graph outage rather than blocking every retry. It fails open on purpose; see "Alternatives". |

4. **Where it lives.** The rule is a pure function, `retryGuardDecision(media, post, nowMs)`, in
   `process-post/instagramRetryGuard.ts`, so it can be unit-tested. `index.ts` wires it once at
   the top of `postToInstagram` and once at the top of `postToInstagramBusinessLogin`, before
   any container is created. It reuses the media-list fetch from step 2 (`findPublishedMedia`
   generalised to return all matches).

### Alternatives considered

- **Check the old container's status instead of the media list.** This is precise, but failed
  rows for images do not store a container id, the web retry deletes the rows first, and a
  container expires after 24 h. The media list works for every path and every age.
- **Fail closed when the lookup fails.** This was rejected: a Graph outage would block every
  Instagram retry, and the duplicate risk only exists when a publish already went unanswered,
  which is rare. Logged, so it is visible.
- **Guard in the web app.** This was rejected: n8n and MCP would bypass it.

### Out of scope

- **Threads.** `threads_publish` is still an unbounded fetch, with 45 s of worker left after the
  poll. A Threads timeout should be settled from the container the same way. It is a separate
  follow-up.
- **The `graphId` guard on the other 11 publish paths.** This still waits on the owner's choice.

## Tests

- `instagramRetryGuard.test.ts`:
  - one match → skip with its id;
  - two matches → skip without an id;
  - none → publish;
  - an empty caption → publish;
  - a match older than the window → publish;
  - a first-run status → no lookup;
  - a failed lookup → publish.
- `deno check process-post/index.ts` and `deno test process-post/` must pass, through the CI
  step "Typecheck and test process-post".

## Rollout

Deploy is the Edge Functions Sync from `main`, about 2 minutes after the merge. Then verify:

- the SHA256 of `process-post/index.ts` and `process-post/instagramRetryGuard.ts` in the
  functions volume matches `git show origin/main:<path>`;
- a retry on a known-live failed row (staging data or a test account) records success without a
  new media item.
