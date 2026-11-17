import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ContainerStillProcessing, newDeferral, type ResumeContext } from "./deferredPublish.ts";
import { checkpointThreadsImage, publishThreadsContainer, threadsParentContainer, ThreadsCheckpointUnavailable } from "./threadsPublish.ts";

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


Deno.test("a new image checkpoint requires a stable row UUID and never publishes on uncertainty", async () => {
  const deferral = newDeferral("threads", "image-1", new Date(0), { mediaType: "IMAGE", attemptStartedAt: new Date(0).toISOString() });
  const responseData = { deferred: deferral };
  assertEquals(await checkpointThreadsImage(() => Promise.resolve({ platformPostId: "44000000-0000-4000-8000-000000000001", responseData }), deferral), {
    platformPostId: "44000000-0000-4000-8000-000000000001",
    responseData,
  });
  await assertRejects(() => checkpointThreadsImage(() => Promise.resolve({ platformPostId: "", responseData }), deferral), ThreadsCheckpointUnavailable);
  await assertRejects(() => checkpointThreadsImage(() => Promise.reject(new Error("lost acknowledgement")), deferral), ThreadsCheckpointUnavailable);
  await assertRejects(() => checkpointThreadsImage(undefined, deferral), ThreadsCheckpointUnavailable);
});

Deno.test("the image publish guard runs before sending and marks every unknown outcome", async () => {
  const events: string[] = [];
  await assertRejects(() => publishThreadsContainer(async () => {
    events.push("send");
    throw new Error("lost");
  }, "image-1", "threads", 20_000, () => 0, {
    beforeSend: () => { events.push("mark"); return Promise.resolve(); },
    onUnknown: () => events.push("uncertain"),
  }), ContainerStillProcessing);
  assertEquals(events, ["mark", "send", "uncertain"]);

  let sends = 0;
  await assertRejects(() => publishThreadsContainer(() => {
    sends++;
    return Promise.resolve({ id: "must-not-send" });
  }, "image-1", "threads", 20_000, () => 0, {
    beforeSend: () => Promise.reject(new ThreadsCheckpointUnavailable("mark lost")),
  }), ThreadsCheckpointUnavailable);
  assertEquals(sends, 0);
});

for (const markDelay of [6000, 8000]) Deno.test(`publish uses the budget remaining after a ${markDelay}ms durable marker write`, async () => {
  let clock = 0;
  let releases = 0;
  const observedTimeouts: number[] = [];
  const operation = () => publishThreadsContainer((timeout) => {
    observedTimeouts.push(timeout);
    return Promise.resolve({ id: "published-image" });
  }, "image-1", "threads", 10_000, () => clock, {
    beforeSend: () => { clock += markDelay; return Promise.resolve(); },
    onDefinitelyUnsent: () => { releases++; return Promise.resolve(true); },
  });
  if (markDelay === 8000) {
    await assertRejects(operation, ContainerStillProcessing);
    assertEquals(observedTimeouts, []);
    assertEquals(releases, 1);
  } else {
    assertEquals(await operation(), { id: "published-image" });
    assertEquals(observedTimeouts, [4000]);
    assertEquals(releases, 0);
  }
});

Deno.test("an unconfirmed definitely-unsent release stays fail-closed without sending", async () => {
  for (const released of [false, Promise.reject(new Error("lost release acknowledgement"))]) {
    let sends = 0;
    let clock = 0;
    await assertRejects(() => publishThreadsContainer(() => {
      sends++;
      return Promise.resolve({ id: "must-not-send" });
    }, "image-1", "threads", 10_000, () => clock, {
      beforeSend: () => { clock = 8_000; return Promise.resolve(); },
      onDefinitelyUnsent: () => typeof released === "boolean" ? Promise.resolve(released) : released,
    }), ThreadsCheckpointUnavailable);
    assertEquals(sends, 0);
  }
});

Deno.test("malformed error payloads route to uncertainty; definitive errors reject", async () => {
  const malformedPayloads = [
    { error: "bad" },
    { error: true },
    { error: [] },
    { error: {} },
    { error: { message: "" } },
  ];

  for (const payload of malformedPayloads) {
    let unknownCalls = 0;
    await assertRejects(
      () =>
        publishThreadsContainer(
          () => Promise.resolve(payload),
          "container-malformed",
          "threads",
          10_000,
          () => 0,
          { onUnknown: () => { unknownCalls++; } },
        ),
      ContainerStillProcessing,
    );
    assertEquals(unknownCalls, 1);
  }

  // Definitive explicit provider error throws Error and does NOT call onUnknown
  let unknownCalls = 0;
  await assertRejects(
    () =>
      publishThreadsContainer(
        () => Promise.resolve({ error: { message: "Invalid OAuth access token", code: 190 } }),
        "container-explicit",
        "threads",
        10_000,
        () => 0,
        { onUnknown: () => { unknownCalls++; } },
      ),
    Error,
    "Threads publish error: Invalid OAuth access token",
  );
  assertEquals(unknownCalls, 0);
});
