import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing, newDeferral, type ResumeContext } from "./deferredPublish.ts";
import { publishThreadsContainer, threadsParentContainer, ThreadsCheckpointUnavailable } from "./threadsPublish.ts";

Deno.test("a resumed parent is reused without creating another container", async () => {
  const resume = { platformPostId: "row", deferral: newDeferral("threads_carousel", "parent-1", new Date(0)) };
  assertEquals(await threadsParentContainer(resume, () => { throw new Error("must not recreate"); }), "parent-1");
});

Deno.test("finishing children checkpoints the parent before returning it for publish", async () => {
  const events: string[] = [];
  const resume: ResumeContext = {
    platformPostId: "row",
    deferral: { ...newDeferral("threads_carousel", "child-1", new Date(0)), carousel_children: ["child-1", "child-2"] },
    checkpointContainer: async (next) => {
      events.push("checkpoint");
      assertEquals(next.container_id, "parent-1");
      assertEquals(next.carousel_children, undefined);
      assertEquals(next.give_up_at, resume.deferral.give_up_at);
    },
  };
  const parent = await threadsParentContainer(resume, async () => { events.push("create"); return "parent-1"; });
  events.push("ready-to-publish");
  assertEquals(parent, "parent-1");
  assertEquals(events, ["create", "checkpoint", "ready-to-publish"]);
  resume.checkpointContainer = () => Promise.reject(new Error("checkpoint unavailable"));
  await assertRejects(() => threadsParentContainer(resume, () => Promise.resolve("parent-2")), ThreadsCheckpointUnavailable, "could not be confirmed");
});

Deno.test("an unanswered Threads publish is deferred with the same ID and never resent inline", async () => {
  let calls = 0;
  const error = await assertRejects(() => publishThreadsContainer(async (timeout) => {
    calls++;
    assertEquals(timeout, 20_000);
    throw new Error("response lost");
  }, "parent-1", "threads_carousel", 50_000, () => 0), ContainerStillProcessing);
  assertEquals(calls, 1);
  assertEquals((error as ContainerStillProcessing).containerId, "parent-1");
});

Deno.test("no publish starts without room to finish, and confirmed results stay distinct", async () => {
  let calls = 0;
  const publish = async () => { calls++; return { id: "published-1" }; };
  await assertRejects(() => publishThreadsContainer(publish, "parent-1", "threads_carousel", 2000, () => 0), ContainerStillProcessing);
  assertEquals(calls, 0);
  assertEquals(await publishThreadsContainer(publish, "parent-1", "threads_carousel", 10_000, () => 0), { id: "published-1" });
  await assertRejects(() => publishThreadsContainer(async () => ({}), "parent-1", "threads_carousel", 10_000, () => 0), ContainerStillProcessing);
  await assertRejects(() => publishThreadsContainer(async () => ({ error: { message: "permission denied" } }), "parent-1", "threads_carousel", 10_000, () => 0), Error, "permission denied");
});
