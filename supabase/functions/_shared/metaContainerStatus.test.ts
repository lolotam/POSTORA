import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CHECK_ONCE_DEADLINE, classifyContainerStatus, containerFailureMessage, pollContainer } from "./metaContainerStatus.ts";

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

// ---- Deadlines: a slow Meta must not run the worker out of time -------------------------

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A Meta that takes `latencyMs` to answer, always IN_PROGRESS, recording each request's timeout. */
function slowMeta(clock: ReturnType<typeof fakeClock>, latencyMs: number, answer: Record<string, unknown> = { status_code: "IN_PROGRESS" }) {
  const timeouts: number[] = [];
  const fetcher = (_url: string, timeoutMs: number) => {
    timeouts.push(timeoutMs);
    clock.advance(Math.min(latencyMs, timeoutMs));
    return latencyMs > timeoutMs ? Promise.reject(new DOMException("timed out", "TimeoutError")) : Promise.resolve(Response.json(answer));
  };
  return { timeouts, fetcher };
}

Deno.test("the whole wait ends by the deadline however slow Meta answers", async () => {
  const clock = fakeClock();
  const deadlineMs = clock.now() + 35_000;
  const meta = slowMeta(clock, 12_000);
  const result = await pollContainer("instagram", "https://x", {
    maxAttempts: 60, intervalMs: 2000, deadlineMs, checkFirst: true, fetcher: meta.fetcher, sleep: clock.sleep, now: clock.now,
  });
  assertEquals(result, { state: "waiting" });
  assertEquals(clock.now() <= deadlineMs, true, `ended at +${clock.now() - (deadlineMs - 35_000)} ms`);
  assertEquals(meta.timeouts.length < 60, true);
});

Deno.test("each request's timeout is cut to the time left", async () => {
  const clock = fakeClock();
  const meta = slowMeta(clock, 0);
  await pollContainer("instagram", "https://x", {
    maxAttempts: 3, intervalMs: 0, deadlineMs: clock.now() + 5000, checkFirst: true, fetcher: meta.fetcher, sleep: clock.sleep, now: clock.now,
  });
  assertEquals(meta.timeouts[0], 5000);
});

Deno.test("with the deadline gone no request is made at all", async () => {
  const clock = fakeClock();
  const meta = slowMeta(clock, 0);
  const result = await pollContainer("threads", "https://x", {
    maxAttempts: 15, intervalMs: 2000, deadlineMs: clock.now() - 1, fetcher: meta.fetcher, sleep: clock.sleep, now: clock.now,
  });
  assertEquals(result, { state: "waiting" });
  assertEquals(meta.timeouts, []);
});

Deno.test("less than a second left is not worth a request", async () => {
  const clock = fakeClock();
  const meta = slowMeta(clock, 0);
  const result = await pollContainer("instagram", "https://x", {
    maxAttempts: 5, intervalMs: 0, deadlineMs: clock.now() + 500, checkFirst: true, fetcher: meta.fetcher, sleep: clock.sleep, now: clock.now,
  });
  assertEquals(result, { state: "waiting" });
  assertEquals(meta.timeouts, []);
});

Deno.test("a sleep that would carry past the deadline is not started", async () => {
  const clock = fakeClock();
  const slept: number[] = [];
  const meta = slowMeta(clock, 0);
  await pollContainer("threads", "https://x", {
    maxAttempts: 15, intervalMs: 2000, deadlineMs: clock.now() + 3500, fetcher: meta.fetcher, now: clock.now,
    sleep: (ms) => { slept.push(ms); return clock.sleep(ms); },
  });
  // One 2 s sleep and one check fit; the next sleep (2 s) plus a check would pass the deadline.
  assertEquals(slept, [2000]);
  assertEquals(meta.timeouts.length, 1);
});

Deno.test("a resumed run (deadline 0) checks exactly once with the full timeout and no sleep", async () => {
  const clock = fakeClock();
  const meta = slowMeta(clock, 0);
  let slept = 0;
  const result = await pollContainer("threads", "https://x", {
    maxAttempts: 15, intervalMs: 2000, deadlineMs: CHECK_ONCE_DEADLINE, fetcher: meta.fetcher, now: clock.now,
    sleep: () => { slept++; return Promise.resolve(); },
  });
  assertEquals(result, { state: "waiting" });
  assertEquals(meta.timeouts, [15_000]);
  assertEquals(slept, 0);
});

Deno.test("a resumed run still sees a finished container, and a failed request is not retried in the same run", async () => {
  const clock = fakeClock();
  const done = answers({ status: "FINISHED" });
  assertEquals(
    await pollContainer("threads", "https://x", { maxAttempts: 15, intervalMs: 2000, deadlineMs: CHECK_ONCE_DEADLINE, fetcher: done.fetcher, sleep: clock.sleep, now: clock.now }),
    { state: "finished" },
  );
  const down = answers(new TypeError("reset"), { status: "FINISHED" });
  assertEquals(
    await pollContainer("threads", "https://x", { maxAttempts: 15, intervalMs: 2000, deadlineMs: CHECK_ONCE_DEADLINE, fetcher: down.fetcher, sleep: clock.sleep, now: clock.now }),
    { state: "waiting" },
  );
  assertEquals(down.calls.length, 1);
});

Deno.test("an infinite deadline leaves only the attempts to bound the wait", async () => {
  const clock = fakeClock();
  const meta = slowMeta(clock, 0);
  await pollContainer("instagram", "https://x", {
    maxAttempts: 4, intervalMs: 2000, deadlineMs: Number.POSITIVE_INFINITY, fetcher: meta.fetcher, sleep: clock.sleep, now: clock.now,
  });
  assertEquals(meta.timeouts, [15_000, 15_000, 15_000, 15_000]);
});

Deno.test("checkFirst asks before sleeping, the default sleeps first", async () => {
  for (const [checkFirst, expectedSleeps] of [[true, 0], [false, 1]] as const) {
    const meta = answers({ status_code: "FINISHED" });
    let slept = 0;
    await pollContainer("instagram", "https://x", {
      maxAttempts: 3, intervalMs: 2000, checkFirst, fetcher: meta.fetcher, sleep: () => { slept++; return Promise.resolve(); },
    });
    assertEquals(slept, expectedSleeps);
  }
});

// ---- Meta API errors are failures, not "still waiting" ----------------------------------

function respond(status: number, body: unknown) {
  return () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

Deno.test("an expired token fails with Meta's message instead of waiting", async () => {
  let calls = 0;
  const result = await pollContainer("instagram", "https://x", {
    maxAttempts: 10, intervalMs: 0, sleep: noSleep,
    fetcher: () => { calls++; return respond(400, { error: { message: "Error validating access token: Session has expired", code: 190 } })(); },
  });
  assertEquals(result, { state: "failed", reason: "Meta API error (code 190): Error validating access token: Session has expired" });
  assertEquals(calls, 1);
});

Deno.test("a Meta error object on a 200 answer fails too", async () => {
  const result = await pollContainer("threads", "https://x", {
    maxAttempts: 10, intervalMs: 0, sleep: noSleep,
    fetcher: respond(200, { error: { message: "Unsupported get request", code: 100 } }),
  });
  assertEquals(result, { state: "failed", reason: "Meta API error (code 100): Unsupported get request" });
});

Deno.test("a client error with no readable body still fails, naming the status", async () => {
  const result = await pollContainer("instagram", "https://x", { maxAttempts: 10, intervalMs: 0, sleep: noSleep, fetcher: respond(401, "<html>denied</html>") });
  assertEquals(result, { state: "failed", reason: "Meta API error (HTTP 401)" });
});

Deno.test("server errors, rate limits and Meta's transient errors are retried", async () => {
  const flaky: (() => Promise<Response>)[] = [
    respond(503, { error: { message: "Service unavailable" } }),
    respond(429, {}),
    respond(400, { error: { message: "Please retry", code: 2 } }),
    respond(400, { error: { message: "Try later", code: 100, is_transient: true } }),
    respond(200, { status_code: "FINISHED" }),
  ];
  let calls = 0;
  const result = await pollContainer("instagram", "https://x", {
    maxAttempts: 10, intervalMs: 0, sleep: noSleep, fetcher: () => { calls++; return flaky.shift()!(); },
  });
  assertEquals(result, { state: "finished" });
  assertEquals(calls, 5);
});

Deno.test("an unreadable 200 answer keeps waiting rather than failing", async () => {
  const result = await pollContainer("instagram", "https://x", { maxAttempts: 2, intervalMs: 0, sleep: noSleep, fetcher: respond(200, "not json") });
  assertEquals(result, { state: "waiting" });
});
