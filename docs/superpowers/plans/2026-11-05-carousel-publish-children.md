# Carousel publishing: children wait and deferred carousel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Threads waits for every carousel child before building the carousel; Instagram (both logins) creates children in parallel, waits for them inside the deferrable budget, and hands a still-processing carousel container to the reconciler exactly as a reel.

**Architecture:** One new pure module `process-post/carouselChildren.ts` (parallel create + wait-all, injectable I/O, unit-tested) is wired into the three carousel sites in `process-post/index.ts`. `deferredPublish.ts` gains the kind `"ig_carousel"`; the reconciler and the SQL are untouched because neither reads the kind.

**Tech Stack:** Deno edge functions (TypeScript), `std@0.224.0` asserts, `_shared/metaContainerStatus.ts` `pollContainer`.

**Spec:** `docs/superpowers/specs/2026-11-05-carousel-publish-children-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` before editing anything under `supabase/functions/**` (Edge Function shape, security rules). Never log a status URL or an access token; log container ids and Meta error messages only.
- Deno imports: `https://deno.land/std@0.224.0/assert/mod.ts` for asserts; `pollContainer`, `CONTAINER_STATUS_FIELDS`, `containerFailureMessage` from `../_shared/metaContainerStatus.ts`; `unfinishedError` from `./deferredPublish.ts`.
- Gates (run from the repo root, Windows Git Bash): `export DENO_DIR=/f/Dev/Runtimes/deno; MAP=.github/deno/process-post-import-map.json; npx -y deno check --node-modules-dir=none --import-map="$MAP" supabase/functions/process-post/index.ts && npx -y deno test --allow-env --node-modules-dir=none --import-map="$MAP" supabase/functions/process-post/ supabase/functions/_shared/composioFiles.test.ts`.
- Comments explain why, never what; match the existing file's comment voice (see `deferredPublish.ts`). No speculative parameters. No `console.log` of request bodies.
- Commit each task scoped to its files with `git commit -- <files>`; message in English, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The reconciler (`reconcile-deferred-publishes/*`), `supabase/migrations/**` and `src/**` are not touched.

---

### Task 1: `ig_carousel` kind and the `carouselChildren` module

**Files:**
- Modify: `supabase/functions/process-post/deferredPublish.ts` (`DeferredKind`, `DeferralSchema`, `giveUpMessage`)
- Create: `supabase/functions/process-post/carouselChildren.ts`
- Create: `supabase/functions/process-post/carouselChildren.test.ts`
- Modify: `supabase/functions/process-post/deferredPublish.test.ts` (two assertions)

**Interfaces:**
- Produces: `DeferredKind` includes `"ig_carousel"`; `giveUpMessage("ig_carousel")` → `"Instagram did not finish processing the carousel within 30 minutes. Safe to retry."`.
- Produces: `createCarouselChildren(urls, childBody, create): Promise<string[]>` and `waitForCarouselChildren(api, ids, statusUrl, wait, poll?): Promise<{ finished: string[]; dropped: { id: string; reason: string }[] }>` exactly as below. Task 2 and Task 3 consume them.

- [ ] **Step 1: Write the failing tests**

`supabase/functions/process-post/carouselChildren.test.ts`:

```ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing } from "./deferredPublish.ts";
import type { ContainerState, PollContainerOptions } from "../_shared/metaContainerStatus.ts";
import { createCarouselChildren, waitForCarouselChildren } from "./carouselChildren.ts";

const body = (url: string) => ({ image_url: url, is_carousel_item: true });

Deno.test("every child is created at once and the ids keep the media order", async () => {
  const started: string[] = [];
  const create = (childBody: Record<string, unknown>) => {
    started.push(childBody.image_url as string);
    // The last child answers first: order must come from the input, not from the replies.
    const delay = childBody.image_url === "u3" ? 0 : 5;
    return new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ id: `c-${childBody.image_url}` }), delay));
  };
  const ids = await createCarouselChildren(["u1", "u2", "u3"], body, create);
  assertEquals(ids, ["c-u1", "c-u2", "c-u3"]);
  assertEquals(started, ["u1", "u2", "u3"]);
});

Deno.test("the first Meta error fails the whole carousel with Meta's message", async () => {
  const create = (childBody: Record<string, unknown>) =>
    Promise.resolve(childBody.image_url === "u2" ? { error: { message: "Media type unsupported" } } : { id: "c-ok" });
  await assertRejects(() => createCarouselChildren(["u1", "u2"], body, create), Error, "Media type unsupported");
});

function fakePoll(states: Record<string, ContainerState>, seen: PollContainerOptions[]) {
  return (_api: "instagram" | "threads", url: string, options: PollContainerOptions): Promise<ContainerState> => {
    seen.push(options);
    const id = url.replace("status:", "");
    return Promise.resolve(states[id]);
  };
}

const WAIT = { deadlineMs: 10_000, maxAttempts: 15, intervalMs: 2000 };

Deno.test("all finished children come back in order, each checked first against the deadline", async () => {
  const seen: PollContainerOptions[] = [];
  const outcome = await waitForCarouselChildren("threads", ["a", "b"], (id) => `status:${id}`, WAIT, fakePoll({ a: { state: "finished" }, b: { state: "finished" } }, seen));
  assertEquals(outcome, { finished: ["a", "b"], dropped: [] });
  assertEquals(seen.map((o) => [o.checkFirst, o.deadlineMs, o.maxAttempts, o.intervalMs]), [[true, 10_000, 15, 2000], [true, 10_000, 15, 2000]]);
});

Deno.test("a child Meta failed is dropped with Meta's reason and the others still finish", async () => {
  const outcome = await waitForCarouselChildren("threads", ["a", "b", "c"], (id) => `status:${id}`, WAIT,
    fakePoll({ a: { state: "finished" }, b: { state: "failed", reason: "Media too large" }, c: { state: "finished" } }, []));
  assertEquals(outcome.finished, ["a", "c"]);
  assertEquals(outcome.dropped, [{ id: "b", reason: "Media too large" }]);
});

Deno.test("a child still processing at the deadline fails retryably, never as a deferral", async () => {
  const error = await assertRejects(
    () => waitForCarouselChildren("instagram", ["a"], (id) => `status:${id}`, WAIT, fakePoll({ a: { state: "waiting" } }, [])),
    Error,
    "Safe to retry",
  );
  assertEquals(error instanceof ContainerStillProcessing, false);
});
```

Append to `supabase/functions/process-post/deferredPublish.test.ts` (its imports already bring `readDeferral`, `newDeferral`, `giveUpMessage`; add nothing else):

```ts
Deno.test("a deferred carousel is read off its row and given up by name", () => {
  const deferral = newDeferral("ig_carousel", "c-7", NOW);
  assertEquals(readDeferral({ deferred: deferral }), deferral);
  assertEquals(giveUpMessage("ig_carousel"), "Instagram did not finish processing the carousel within 30 minutes. Safe to retry.");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run the gate test command (Global Constraints). Expected: `carouselChildren.test.ts` fails to resolve `./carouselChildren.ts`; the new `deferredPublish.test.ts` case fails on the type/enum.

- [ ] **Step 3: Implement**

`supabase/functions/process-post/deferredPublish.ts`:

```ts
export type DeferredKind = "ig_reel" | "ig_business_reel" | "ig_carousel" | "threads";
// …
  kind: z.enum(["ig_reel", "ig_business_reel", "ig_carousel", "threads"]),
// …
export function giveUpMessage(kind: DeferredKind): string {
  if (kind === "threads") return "Threads did not finish processing the video within 30 minutes. Safe to retry.";
  const media = kind === "ig_carousel" ? "carousel" : "video";
  return `Instagram did not finish processing the ${media} within 30 minutes. Safe to retry.`;
}
```

`supabase/functions/process-post/carouselChildren.ts`:

```ts
/**
 * Carousel children for Instagram and Threads. Meta rejects a CAROUSEL container whose
 * children are still processing, so every child is waited for before the carousel is built.
 * Instagram children are created at once: created one by one and each waited for, several
 * images alone used up a first run's wait budget (the 2026-11-05 pilot failures).
 *
 * Spec: docs/superpowers/specs/2026-11-05-carousel-publish-children-design.md
 */

import { type ContainerState, type MetaContainerApi, pollContainer, type PollContainerOptions } from "../_shared/metaContainerStatus.ts";
import { unfinishedError } from "./deferredPublish.ts";

export interface CarouselChildCreate {
  /** POSTs one child container; resolves with Meta's JSON reply. */
  (body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Creates every child container at once. The first Meta error fails the whole carousel. */
export async function createCarouselChildren(
  urls: string[],
  childBody: (url: string) => Record<string, unknown>,
  create: CarouselChildCreate,
): Promise<string[]> {
  const replies = await Promise.all(urls.map((url) => create(childBody(url))));
  return replies.map((reply) => {
    const error = reply.error as { message?: string } | undefined;
    if (error) throw new Error(error.message ?? "Instagram rejected a carousel item");
    return String(reply.id);
  });
}

export interface ChildWait {
  deadlineMs: number;
  maxAttempts: number;
  intervalMs: number;
}

export interface ChildWaitOutcome {
  finished: string[];
  dropped: { id: string; reason: string }[];
}

type Poll = (api: MetaContainerApi, statusUrl: string, options: PollContainerOptions) => Promise<ContainerState>;

/**
 * Waits for each child in order, checking first (a child created a moment ago is often ready).
 * A child Meta marks ERROR or EXPIRED is dropped with Meta's reason, for the caller to decide
 * on; a child still processing at the deadline fails retryably: no carousel container exists
 * yet, so nothing could finish it later.
 */
export async function waitForCarouselChildren(
  api: MetaContainerApi,
  ids: string[],
  statusUrl: (id: string) => string,
  wait: ChildWait,
  poll: Poll = pollContainer,
): Promise<ChildWaitOutcome> {
  const outcome: ChildWaitOutcome = { finished: [], dropped: [] };
  for (const id of ids) {
    const container = await poll(api, statusUrl(id), {
      maxAttempts: wait.maxAttempts,
      intervalMs: wait.intervalMs,
      checkFirst: true,
      deadlineMs: wait.deadlineMs,
    });
    if (container.state === "failed") {
      outcome.dropped.push({ id, reason: container.reason });
      continue;
    }
    if (container.state === "waiting") throw unfinishedError({ deadlineMs: wait.deadlineMs }, id, api === "threads" ? "Threads" : "Instagram");
    outcome.finished.push(id);
  }
  return outcome;
}
```

Check `ContainerState`'s exact shape in `_shared/metaContainerStatus.ts` (lines 13–19) before writing: `failed` carries `reason: string`; `published` counts as finished for a child (it cannot happen for a child, but the switch must not throw on it).

- [ ] **Step 4: Run the tests to see them pass**

Run the gate command. Expected: all process-post tests pass, including the five new and one appended case.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-post/deferredPublish.ts supabase/functions/process-post/deferredPublish.test.ts supabase/functions/process-post/carouselChildren.ts supabase/functions/process-post/carouselChildren.test.ts
git commit -- supabase/functions/process-post/deferredPublish.ts supabase/functions/process-post/deferredPublish.test.ts supabase/functions/process-post/carouselChildren.ts supabase/functions/process-post/carouselChildren.test.ts -m "feat(process-post): carousel children helpers and the ig_carousel deferral kind"
```

---

### Task 2: Instagram carousels (both logins) use the helpers and defer the carousel container

**Files:**
- Modify: `supabase/functions/process-post/index.ts` — Facebook-login carousel block (~4698–4790), Business-login carousel block (~5453–5509) and its enclosing `catch` (~5510), the fallback message in the main loop (~2192), the import list (~125–145).

**Interfaces:**
- Consumes: Task 1's `createCarouselChildren`, `waitForCarouselChildren`, `"ig_carousel"`.
- Consumes (already in `index.ts`): `pollContainerStatus` / `pollBusinessLoginContainerStatus`, `publishInstagramMedia` / `publishBusinessLoginMedia`, `findPublishedMedia`, `PUBLISHED_LOOKBACK_MS`, `claimFollowUps`, `deferrableDeadline`, `WORKER_STARTED_AT_MS`, `CONTAINER_STATUS_FIELDS`, `ContainerStillProcessing`.

- [ ] **Step 1: Read the two reel blocks**

Read `index.ts` 4477–4600 (Facebook-login reel) and 5327–5400 (Business-login reel) once: the carousel blocks mirror their resume, `"PUBLISHED"` and follow-up handling.

- [ ] **Step 2: Facebook-login carousel block**

Replace the block from `const containerIds: string[] = [];` (~4701) through the `publishInstagramMedia` call (~4773) with:

```ts
    // A resumed run already has the carousel container; creating another would publish twice.
    let carouselId: string;
    if (timing.resume) {
      carouselId = timing.resume.deferral.container_id;
    } else {
      const childEndpoint = `https://graph.facebook.com/v18.0/${igUserId}/media`;
      const containerIds = await createCarouselChildren(
        optimizedMediaUrls.slice(0, 10),
        (url) => ({ image_url: url, is_carousel_item: true, access_token: accessToken, ...(igAltText ? { alt_text: igAltText } : {}) }),
        async (childBody) => {
          const response = await fetch(childEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childBody) });
          return await response.json();
        },
      );
      // The children share the carousel's deferrable budget so the publish still fits the worker.
      const children = await waitForCarouselChildren(
        "instagram",
        containerIds,
        (id) => `https://graph.facebook.com/v18.0/${id}?fields=${CONTAINER_STATUS_FIELDS.instagram}&access_token=${accessToken}`,
        { deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS), maxAttempts: 30, intervalMs: 2000 },
      );
      // Instagram refuses a carousel missing a child, so one failed child fails the carousel.
      if (children.dropped.length > 0) throw new Error(containerFailureMessage("instagram", children.dropped[0].reason));

      const carouselBody: Record<string, unknown> = {
        media_type: "CAROUSEL",
        children: children.finished.join(","),
        caption: post.caption,
        access_token: accessToken,
      };
      // (keep the existing collaborator, location eligibility, igMediaCreateWithLocationRetry and
      //  collaborator-retry code here unchanged, ending with:)
      if (carouselData.error) throw new Error(carouselData.error.message);
      carouselId = graphId(carouselData, "Instagram carousel container");
    }

    // The carousel can be finished later like a reel: the reconciler resumes a still-processing one.
    const carouselStatus = await pollContainerStatus(carouselId, accessToken, {
      deferKind: "ig_carousel",
      deadlineMs: deferrableDeadline(timing.deadlineMs, WORKER_STARTED_AT_MS),
    });
    let publishData: { id: string };
    if (carouselStatus === "PUBLISHED") {
      // Only a resumed run sees this: an earlier run's publish went unanswered, or its worker
      // stopped, after Instagram published. The container id is not the media id: find the media.
      const firstDeferredAt = Date.parse(timing.resume?.deferral.first_deferred_at ?? "");
      const media = await findPublishedMedia(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        accessToken,
        post.caption,
        (Number.isFinite(firstDeferredAt) ? firstDeferredAt : Date.now()) - PUBLISHED_LOOKBACK_MS,
      );
      if (!media) {
        return {
          url: username ? `https://www.instagram.com/${username}/` : `https://instagram.com`,
          warnings: [...warnings, "Instagram had already published this carousel, but it could not be identified, so its first comment, comment setting and story share were not applied."],
        };
      }
      publishData = { id: media.id };
    } else {
      publishData = await publishInstagramMedia(igUserId, carouselId, accessToken, "ig_carousel");
    }

    // On a resumed run they may have run once already, before a worker stopped: never twice.
    const followUps = await claimFollowUps(timing.resume);
    if (followUps) {
      await postInstagramFirstComment(publishData.id);
      await disableIgComments(publishData.id);
    }
```

Then keep the permalink fetch as is, and wrap the story mirror: `if (followUps && shareToStory && !igPostTypes.includes("story")) { await publishAndRecordStoryMirror(); }`. Check that `containerFailureMessage` is imported from `../_shared/metaContainerStatus.ts` (it is used at ~3730, so it is); add `createCarouselChildren`, `waitForCarouselChildren` to the imports from `./carouselChildren.ts`.

- [ ] **Step 3: Business-login carousel block**

Replace the block from `const containerIds: string[] = [];` (~5454) through the `publishBusinessLoginMedia` call (~5503) with the same shape, using `graph.instagram.com/v22.0`, `pollBusinessLoginContainerStatus`, `publishBusinessLoginMedia(…, "ig_carousel")`, `blMediaCreateWithLocationRetry`, `checkBLLocationEligibility`, and `instagramLocationId`. On `"PUBLISHED"`, mirror the Business reel block (5363–5384): `findPublishedMedia` over `https://graph.instagram.com/v22.0/${igUserId}/media`; found → `insertIGRow("feed", "success", media.id, media.permalink ?? fallbackUrl, …)`, `subResults.push`, `enrichInBackground(rowId, media.id, "feed", url)` when `rowId`; not found → `insertIGRow("feed", "success", undefined, fallbackUrl, undefined, { warnings: [note] })` with `note = "Instagram had already published this carousel, but it could not be identified, so its first comment and comment setting were not applied."`. Otherwise the existing success recording stays (`finalizeBLLocationDebug`, `insertIGRow`, `subResults.push`, `enrichInBackground` only when `rowId || !timing.resume`, as the reel does).

In the `catch (e)` at ~5510 add, as its first line:

```ts
      // Not a failure: the main loop records the container for the reconciler to finish.
      if (e instanceof ContainerStillProcessing) throw e;
```

- [ ] **Step 4: Main-loop message**

At ~2192 change `was still processing the video and it could not be finished later` to `was still processing the media and it could not be finished later`.

- [ ] **Step 5: Gates**

Run the gate command (check + tests). Expected: `deno check` clean, all process-post tests pass.

- [ ] **Step 6: Commit**

```bash
git commit -- supabase/functions/process-post/index.ts -m "fix(process-post): Instagram carousels create children at once and finish later like reels"
```

---

### Task 3: Threads waits for its carousel children

**Files:**
- Modify: `supabase/functions/process-post/index.ts` — Threads carousel branch (~6559–6628).

**Interfaces:**
- Consumes: Task 1's `waitForCarouselChildren` (already imported by Task 2).

- [ ] **Step 1: Wait for the children before the warning/`children` assembly**

After the child-creation `for` loop and before the `if (childIds.length === 0)` check, insert:

```ts
      // Meta refuses a carousel whose children are still processing: every child is waited for.
      const children = await waitForCarouselChildren(
        "threads",
        childIds,
        (id) => `https://graph.threads.net/v1.0/${id}?fields=${CONTAINER_STATUS_FIELDS.threads}&access_token=${accessToken}`,
        { deadlineMs: timing.deadlineMs, maxAttempts: 15, intervalMs: 2000 },
      );
      for (const dropped of children.dropped) {
        console.error("Threads: Child container failed:", dropped.reason, "| id:", dropped.id);
      }
      childIds.splice(0, childIds.length, ...children.finished);
```

The existing zero-children error and the "N of M carousel images were rejected" warning then count dropped children too, because both read `childIds.length` against `safeMediaUrls.length`. The CAROUSEL container's own poll and `deferrable` are unchanged.

- [ ] **Step 2: Gates**

Run the gate command. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git commit -- supabase/functions/process-post/index.ts -m "fix(process-post): Threads waits for every carousel child before building the carousel"
```

---

### Task 4: Branch gates, review, PR (orchestrator)

- [ ] `clean-code-guard` on `carouselChildren.ts` and the three `index.ts` sites; `test-guard` on the two test files.
- [ ] Gates: the Deno gate command; `npm run typecheck`; `npm run build` (no `src/**` change, so vitest is not required by the diff; run `npm test` if any shared file changed).
- [ ] Codex `gpt-6-astra` medium review of the whole branch; fix round if needed.
- [ ] PR to `main`, body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; merge on green CI after the owner card. Edge sync of `process-post` follows from `main`.
