# Carousel publishing: wait for the children, finish the carousel later

Date: 2026-11-05. Status: design, owner approved the approach in chat ("start") after the diagnosis of the failed carousel posts on the connected accounts of `flexitolkw@gmail.com`. Scope note: the owner's approval named the Facebook-login Instagram carousel and Threads; the Business-login Instagram carousel (`graph.instagram.com`) has the same shape and the same defect, so it is included.

## 1. The defect (production, 2026-11-05)

Both carousel failures on the pilot were carousel-specific; single images and reels on the same accounts publish.

- **Threads** (`supabase/functions/process-post/index.ts`, carousel branch of `postToThreads`, ~lines 6559–6628): each child container is created with `is_carousel_item=true` and its id is pushed at once. Nothing waits for a child to reach `FINISHED`. The CAROUSEL container is then created with `children=<ids>` and Meta rejects it with a container error (thrown as `Threads API error [code=…]` from `createThreadsContainer`), because a child that is still processing is not a valid carousel child.
- **Instagram, Facebook login** (~lines 4698–4790) and **Instagram, Business login** (~lines 5453–5509): the children are created one after another, each one polled to `FINISHED` before the next is created, then the CAROUSEL container is created and polled with `{ deadlineMs: timing.deadlineMs }` and no `deferKind`. A first run's whole wait budget is `FIRST_RUN_POLL_BUDGET_MS` (35 s, `deferredPublish.ts`). Several images plus the carousel container do not fit, the carousel poll ends `waiting`, and `unfinishedError` fails the account with "Instagram did not finish processing the media in time. Safe to retry." The reel path on both logins already escapes this through the deferral mechanism (`ContainerStillProcessing` → `recordStillProcessing` → `reconcile-deferred-publishes` cron); the carousel path does not.

## 2. Goal

A carousel of up to 10 images publishes on Threads and on both Instagram logins. Threads waits for every child before it builds the carousel. Instagram creates the children in parallel, waits for them, and if the carousel container itself is still processing when the worker's time is up, the pending row is left for the reconciler exactly as a reel is, and the resumed run publishes it.

## 3. Non-goals

- Making Threads carousels deferrable (the children are images and finish in seconds once waited for; a Threads carousel with a video child stays bounded by the first run, as today).
- Changing the reconciler (`reconcile-deferred-publishes/*`): it only forwards `platform_post_id` to process-post in resume mode and never reads the deferral kind.
- A migration: `record_deferred_platform_post` and the sweep RPC do not read `deferred.kind` (checked: no `kind` reads under `supabase/migrations` or `src`).
- Retrying or republishing the failed pilot posts.

## 4. Design

### 4.1 `deferredPublish.ts`: one new kind

- `DeferredKind` gains `"ig_carousel"`; `DeferralSchema.kind` enum gains it too.
- `giveUpMessage(kind)` names what was deferred: `"Instagram did not finish processing the carousel within 30 minutes. Safe to retry."` for `ig_carousel`; the reel and Threads texts are unchanged.
- The fallback error in the main loop (`index.ts` ~line 2192, "was still processing the video and it could not be finished later") says "the media" instead of "the video".

One kind serves both Instagram logins: on resume the handler is chosen from the account, not from the kind, and nothing on the resume path branches on the kind (only a log line prints it).

### 4.2 New module `process-post/carouselChildren.ts`

Two pure helpers with injectable I/O so the logic is unit-tested without `index.ts`:

```ts
export interface CarouselChildCreate {
  /** POSTs one child container; resolves with Meta's JSON reply. */
  (body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Creates every child container at once. The first Meta error fails the whole carousel. */
export async function createCarouselChildren(
  urls: string[],
  childBody: (url: string) => Record<string, unknown>,
  create: CarouselChildCreate,
): Promise<string[]>;

export type ChildWaitOutcome =
  | { finished: string[]; dropped: { id: string; reason: string }[] };

/**
 * Waits for each child in order (check-first). A child Meta marks ERROR/EXPIRED is `dropped`
 * with Meta's reason; a child still processing at the deadline throws the non-deferrable
 * `unfinishedError` (no carousel container exists yet, so nothing could resume it).
 */
export async function waitForCarouselChildren(
  api: "instagram" | "threads",
  ids: string[],
  statusUrl: (id: string) => string,
  wait: { deadlineMs: number; maxAttempts: number; intervalMs: number },
  poll = pollContainer,
): Promise<ChildWaitOutcome>;
```

`createCarouselChildren` uses `Promise.all`; ids are returned in the input order. `waitForCarouselChildren` calls `pollContainer` from `_shared/metaContainerStatus.ts` with `checkFirst: true` and the given deadline for every child.

### 4.3 Instagram carousel, both logins

Identical shape at the two sites (Facebook login `graph.facebook.com/v18.0`, Business login `graph.instagram.com/v22.0`), each using its own existing create/poll/publish helpers:

1. **Resume:** when `timing.resume` is set, no child and no carousel container is created; `carouselId = timing.resume.deferral.container_id`.
2. **First run:** `createCarouselChildren` over `optimizedMediaUrls.slice(0, 10)` with the existing child body (`image_url`, `is_carousel_item: true`, `access_token`, optional `alt_text`). Then `waitForCarouselChildren("instagram", ids, …, { deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS), maxAttempts: 30, intervalMs: 2000 })`. An Instagram child that is `dropped` fails the carousel with Meta's reason (Instagram rejects a carousel whose children list is incomplete; no partial carousel). Then the CAROUSEL container is created as today (collaborator retry and location eligibility unchanged).
3. **Carousel poll:** `poll…ContainerStatus(carouselId, accessToken, { deferKind: "ig_carousel", deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS) })`. `"PUBLISHED"` (only a resumed run sees it) → `findPublishedMedia` with the deferral's `first_deferred_at` minus `PUBLISHED_LOOKBACK_MS`, mirroring the reel block; when the media cannot be identified the account is still a success with the reel block's warning wording adapted to "carousel".
4. **Publish:** `publishInstagramMedia(igUserId, carouselId, accessToken, "ig_carousel")` / `publishBusinessLoginMedia(…, "ig_carousel")`, so an unanswered publish is settled from the container state and may defer, as for reels.
5. **Follow-ups, Facebook login:** first comment, comment setting and the story mirror run only when `claimFollowUps(timing.resume)` is true (a first run always; a resumed run once).
6. **Business login catch:** the `catch` that wraps the feed/carousel branch (~line 5510) rethrows `ContainerStillProcessing` before recording a failed row, exactly as the reel branch's catch (~line 5399) does. Without this the deferral never reaches `recordStillProcessing`.

The deferrable deadline is used for the children as well as the carousel so the children cannot consume the reserve the publish needs.

### 4.4 Threads carousel

After the child-creation loop, `waitForCarouselChildren("threads", childIds, id => graph.threads.net/v1.0/{id}?fields=…, { deadlineMs: timing.deadlineMs, maxAttempts: 15, intervalMs: 2000 })`. A `dropped` child is removed with a warning in the same shape as a creation failure (console error, counted in the existing "N of M carousel images were rejected" warning, partial carousel still published; zero children still throws the existing "rejected all carousel child containers" error). A child still `waiting` at the deadline throws `unfinishedError({ deadlineMs: timing.deadlineMs }, id, "Threads")` (non-deferrable). `deferrable = media_type === "VIDEO"` and the CAROUSEL container's own poll are unchanged.

## 5. Security

No new RPC, grant, secret or external endpoint. Access tokens stay in request bodies/query strings as today; the new module logs only container ids and Meta's error messages (never a status URL).

## 6. Tests

- `process-post/carouselChildren.test.ts`: parallel create returns ids in order and fails on the first Meta error; all-finished returns every id; a `failed` child is `dropped` with Meta's reason; a `waiting` child at the deadline throws a non-deferrable error (never `ContainerStillProcessing`); every child is polled with `checkFirst: true` and the given deadline (fake `poll`).
- `process-post/deferredPublish.test.ts`: `readDeferral` accepts `kind: "ig_carousel"`; `giveUpMessage("ig_carousel")` names the carousel.
- Existing suites stay green: `deferredPublish.test.ts`, `instagramPublish.test.ts`, `index.test.ts`, `reconcile-deferred-publishes/run.test.ts` (untouched).

## 7. Deploy and verification

Edge sync of `process-post` from `main` after merge. Verification: the owner publishes a 3-image carousel to Threads and to the Instagram pilot account from the web app; `platform_posts` shows `success` for both, or a `pending` Instagram row carrying `deferred.kind = "ig_carousel"` that the next reconciler minute settles `success`. The failed pilot posts are not retried.
