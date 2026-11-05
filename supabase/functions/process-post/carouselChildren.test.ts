import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing } from "./deferredPublish.ts";
import type { ContainerState, PollContainerOptions } from "../_shared/metaContainerStatus.ts";
import { createCarouselChildren, waitForCarouselChildren } from "./carouselChildren.ts";

const body = (url: string) => ({ image_url: url, is_carousel_item: true });

Deno.test("every child is created at once and the ids keep the media order", async () => {
  const started: string[] = [];
  const resolvers: (() => void)[] = [];
  const create = (childBody: Record<string, unknown>) => {
    started.push(childBody.image_url as string);
    return new Promise<Record<string, unknown>>((resolve) => {
      resolvers.push(() => resolve({ id: `c-${childBody.image_url}` }));
    });
  };
  const pending = createCarouselChildren(["u1", "u2", "u3"], body, create);
  // Every child is created before any of them answers: the wait is not paid one child at a time.
  assertEquals(started, ["u1", "u2", "u3"]);
  assertEquals(resolvers.length, 3);
  // The last child answers first: the ids still come back in the media order.
  resolvers[2]();
  resolvers[1]();
  resolvers[0]();
  assertEquals(await pending, ["c-u1", "c-u2", "c-u3"]);
});

Deno.test("a reply without a container id fails the carousel instead of publishing an empty child", async () => {
  const create = () => Promise.resolve({});
  await assertRejects(() => createCarouselChildren(["u1"], body, create), Error, "Instagram returned no container id for a carousel item");
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
