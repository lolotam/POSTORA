import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing, newDeferral, readDeferral } from "./deferredPublish.ts";
import { type ContainerState, pollContainer, type PollContainerOptions } from "../_shared/metaContainerStatus.ts";
import { createCarouselChildren, threadsChildWait, waitForCarouselChildren } from "./carouselChildren.ts";

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

for (const latencyMs of [14_000, 100]) {
  Deno.test(`resumed ten-child carousel preserves worker reserve with ${latencyMs}ms status responses`, async () => {
    const start = 1000;
    let now = start;
    let requests = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `child-${i}`);
    const wait = threadsChildWait(0, start);
    const check = () => waitForCarouselChildren("threads", ids, (id) => `status:${id}`, wait,
      (api, url, options) => pollContainer(api, url, {
        ...options,
        now: () => now,
        fetcher: (_url, timeoutMs) => {
          requests++;
          now += Math.min(latencyMs, timeoutMs);
          if (latencyMs > timeoutMs) return Promise.reject(new Error("timeout"));
          return Promise.resolve(new Response(JSON.stringify({ status: "FINISHED" })));
        },
      }));
    if (latencyMs === 14_000) {
      const pending = await assertRejects(check, ContainerStillProcessing) as ContainerStillProcessing;
      assertEquals(pending.carouselChildren, ids);
      assertEquals(requests, 7);
      assertEquals(now, wait.deadlineMs);
    } else {
      assertEquals(await check(), { finished: ids, dropped: [] });
      assertEquals(requests, 10);
      assertEquals(now, start + 1000);
    }
  });
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

for (const count of [6, 7]) {
  Deno.test(`Threads retains all ${count} carousel child IDs when the worker's time runs out`, async () => {
    const ids = Array.from({ length: count }, (_, i) => `child-${i}`);
    const error = await assertRejects(() => waitForCarouselChildren("threads", ids, (id) => `status:${id}`,
      { ...WAIT, deferThreads: true }, fakePoll({ "child-0": { state: "waiting" } }, [])), ContainerStillProcessing);
    const pending = error as ContainerStillProcessing;
    assertEquals(pending.kind, "threads_carousel");
    assertEquals(pending.carouselChildren, ids);
    const persisted = readDeferral({ deferred: { ...newDeferral(pending.kind, pending.containerId, new Date()), carousel_children: pending.carouselChildren } });
    assertEquals(persisted?.carousel_children, ids);
    const states = Object.fromEntries(ids.map((id) => [id, { state: "finished" } as ContainerState]));
    const resumed = await waitForCarouselChildren("threads", persisted!.carousel_children!, (id) => `status:${id}`,
      { ...WAIT, deadlineMs: 0, deferThreads: true }, fakePoll(states, []));
    assertEquals(resumed.finished, ids);
  });
}
