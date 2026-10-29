import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyContainerStatus, containerFailureMessage, pollContainer } from "./metaContainerStatus.ts";

Deno.test("Instagram states come from status_code, the reason from status", () => {
  assertEquals(classifyContainerStatus("instagram", { status_code: "FINISHED", status: "Finished: Media has been uploaded" }), { state: "finished" });
  assertEquals(classifyContainerStatus("instagram", { status_code: "IN_PROGRESS", status: "In Progress" }), { state: "waiting" });
  assertEquals(classifyContainerStatus("instagram", { status_code: "PUBLISHED" }), { state: "published" });
  assertEquals(
    classifyContainerStatus("instagram", { status_code: "ERROR", status: "Error: Media upload has failed with error code 2207026" }),
    { state: "failed", reason: "ERROR: Error: Media upload has failed with error code 2207026" },
  );
  assertEquals(classifyContainerStatus("instagram", { status_code: "EXPIRED" }), { state: "failed", reason: "EXPIRED" });
});

Deno.test("Threads states come from status, the reason from error_message", () => {
  assertEquals(classifyContainerStatus("threads", { status: "FINISHED" }), { state: "finished" });
  assertEquals(classifyContainerStatus("threads", { status: "ERROR", error_message: "FAILED_PROCESSING_VIDEO" }), { state: "failed", reason: "ERROR: FAILED_PROCESSING_VIDEO" });
  assertEquals(classifyContainerStatus("threads", { status: "IN_PROGRESS" }), { state: "waiting" });
});

Deno.test("an unreadable answer keeps waiting rather than failing or publishing", () => {
  assertEquals(classifyContainerStatus("instagram", null), { state: "waiting" });
  assertEquals(classifyContainerStatus("threads", { status: 3 }), { state: "waiting" });
});

Deno.test("the failure message names the platform and Meta's reason", () => {
  assertEquals(containerFailureMessage("instagram", "ERROR: code 2207026"), "Instagram could not process the media (ERROR: code 2207026)");
});

function answers(...bodies: (Record<string, unknown> | Error)[]) {
  const calls: string[] = [];
  const fetcher = (url: string) => {
    calls.push(url);
    const next = bodies.shift() ?? { status: "IN_PROGRESS" };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(Response.json(next));
  };
  return { calls, fetcher };
}
const noSleep = () => Promise.resolve();

Deno.test("a Threads ERROR ends the wait at once with Meta's reason", async () => {
  const meta = answers({ status: "IN_PROGRESS" }, { status: "ERROR", error_message: "FAILED_DOWNLOADING_VIDEO" }, { status: "FINISHED" });
  const result = await pollContainer("threads", "https://graph.threads.net/c?fields=status,error_message", { maxAttempts: 15, intervalMs: 0, fetcher: meta.fetcher, sleep: noSleep });
  assertEquals(result, { state: "failed", reason: "ERROR: FAILED_DOWNLOADING_VIDEO" });
  assertEquals(meta.calls.length, 2);
});

Deno.test("a network failure is retried, then the container finishes", async () => {
  const meta = answers(new TypeError("connection reset"), { status: "FINISHED" });
  const result = await pollContainer("threads", "https://x", { maxAttempts: 3, intervalMs: 0, fetcher: meta.fetcher, sleep: noSleep });
  assertEquals(result, { state: "finished" });
});

Deno.test("running out of attempts reports waiting, never finished", async () => {
  const meta = answers();
  const result = await pollContainer("instagram", "https://x", { maxAttempts: 3, intervalMs: 0, fetcher: meta.fetcher, sleep: noSleep });
  assertEquals(result, { state: "waiting" });
  assertEquals(meta.calls.length, 3);
});
