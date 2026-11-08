import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type InstagramStoryPorts, readStoryWork, runInstagramStory, type StoryWork } from "./instagramStory.ts";
import type { ClaimedJob } from "../worker.ts";

function fixture(phase: StoryWork["phase"] = "processing") {
  let work: StoryWork = {
    postId: "00000000-0000-4000-8000-000000000001", accountId: "00000000-0000-4000-8000-000000000002",
    resultId: "00000000-0000-4000-8000-000000000003", generation: 1, consentVersion: "v1",
    giveUpAt: 100_000, phase, ...(phase !== "queued" ? { containerId: "original-container" } : {}),
  };
  const calls: string[] = [];
  const ports: InstagramStoryPorts = {
    now: () => 1000,
    load: async () => ({ work, context: { authorized: true, primarySucceeded: true, eligible: true, mediaValid: true } }),
    checkpoint: async (_job, next) => { work = next; calls.push(`checkpoint:${next.phase}`); return true; },
    create: async () => { calls.push("create"); return { id: "created-container" }; },
    status: async () => "finished",
    publish: async () => { calls.push("publish"); return { id: "story-media" }; },
    settle: async (_job, _work, result) => { calls.push(result.published ? "success" : `failure:${result.error}`); return true; },
  };
  const job = (): ClaimedJob => ({ id: "job", user_id: "owner", kind: "instagram_story", payload: { ...work }, attempts: 1, claim_token: "lease" });
  return { ports, calls, job, work: () => work };
}

Deno.test("Story creation checkpoints the intent and returned container before handing off", async () => {
  const f = fixture("queued");
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "continue");
  assertEquals(f.calls, ["checkpoint:creating", "create", "checkpoint:processing"]);
  assertEquals(f.work().containerId, "created-container");
});

Deno.test("a slow Story retains its original container without publishing", async () => {
  const f = fixture(); f.ports.status = async () => "waiting";
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "continue");
  assertEquals(f.work().containerId, "original-container");
  assertEquals(f.calls, []);
});

Deno.test("an unanswered Story dispatch never dispatches again and can reconcile published", async () => {
  const f = fixture();
  f.ports.publish = async () => { f.calls.push("publish"); throw new Error("network"); };
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "continue");
  assertEquals(f.work().phase, "publishing");
  await runInstagramStory(f.job(), f.ports, 40_000);
  assertEquals(f.calls.filter((call) => call === "publish").length, 1);
  f.ports.status = async () => "published";
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "done");
  assertEquals(f.calls.at(-1), "success");
});

Deno.test("lost claim prevents Story dispatch", async () => {
  const f = fixture(); f.ports.checkpoint = async () => false;
  await assertRejects(() => runInstagramStory(f.job(), f.ports, 40_000), Error, "story_claim_lost");
  assertEquals(f.calls, []);
});

for (const refusal of ["authorized", "eligible", "mediaValid"] as const) {
  Deno.test(`Story refuses ${refusal}=false without provider mutations`, async () => {
    const f = fixture("queued");
    f.ports.load = async () => ({ work: f.work(), context: { authorized: true, primarySucceeded: true, eligible: true, mediaValid: true, [refusal]: false } });
    assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "failed");
    assertEquals(f.calls.some((call) => call === "create" || call === "publish"), false);
  });
}

Deno.test("a persisted Story success retries only its database settlement", async () => {
  const f = fixture("published");
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "done");
  assertEquals(f.calls, ["success"]);
});

Deno.test("confirmed publication is recorded even after consent withdrawal, without provider access", async () => {
  const f = fixture("published");
  f.ports.load = async () => ({ work: f.work(), context: { authorized: false, primarySucceeded: true, eligible: false, mediaValid: false } });
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "done");
  assertEquals(f.calls, ["success"]);
});

Deno.test("a slow checkpoint cannot dispatch past the worker deadline", async () => {
  const f = fixture(); let time = 1000;
  f.ports.now = () => time;
  f.ports.checkpoint = async () => { time = 39_500; return true; };
  assertEquals((await runInstagramStory(f.job(), f.ports, 40_000)).kind, "continue");
  assertEquals(f.calls, []);
});

Deno.test("unknown dispatch gives up as uncertain and never retries provider publishing", async () => {
  const f = fixture("publishing"); f.ports.now = () => 100_001;
  const settled: unknown[] = [];
  f.ports.settle = async (_job, _work, result) => { settled.push(result); return true; };
  assertEquals((await runInstagramStory(f.job(), f.ports, 120_000)).kind, "failed");
  assertEquals(settled, [{ published: false, error: "story_publish_unconfirmed", uncertain: true }]);
  assertEquals(f.calls, []);
});

Deno.test("canonical work validation removes injected fields and refuses malformed provider identity", () => {
  const f = fixture();
  assertEquals(readStoryWork({ ...f.work(), token: "do-not-retain" }), f.work());
  assertEquals(readStoryWork({ ...f.work(), mediaId: {} }), null);
  assertEquals(readStoryWork({ ...f.work(), generation: 0 }), null);
});
