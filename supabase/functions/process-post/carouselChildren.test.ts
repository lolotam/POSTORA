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
