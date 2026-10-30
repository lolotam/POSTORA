import { assertEquals, assertInstanceOf, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ContainerState } from "../_shared/metaContainerStatus.ts";
import { ContainerStillProcessing } from "./deferredPublish.ts";
import type { GraphResponse } from "./graphResponse.ts";
import {
  CHECK_TIMEOUT_MS,
  isRetryablePublishError,
  matchPublishedMedia,
  MIN_REQUEST_MS,
  NOT_SENT_MESSAGE,
  publishContainer,
  PUBLISHED_UNCONFIRMED_MESSAGE,
} from "./instagramPublish.ts";

/**
 * Ports whose publish answers come from `replies` (an Error means the request went unanswered)
 * and whose container states come from `states`. The clock stays at 0.
 */
function ports(replies: (GraphResponse | Error)[], states: ContainerState[] = []) {
  const calls = { publishTimeouts: [] as number[], checks: 0, sleeps: [] as number[] };
  return {
    calls,
    ports: {
      publish: (timeoutMs: number) => {
        const reply = replies[Math.min(calls.publishTimeouts.length, replies.length - 1)];
        calls.publishTimeouts.push(timeoutMs);
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
      containerState: () => Promise.resolve(states[Math.min(calls.checks++, states.length - 1)] ?? { state: "waiting" as const }),
      now: () => 0,
      sleep: (ms: number) => {
        calls.sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}
const timedOut = new Error("Request timed out");
const reel = { creationId: "c1", deferKind: "ig_reel" as const, requestTimeoutMs: 20_000 };

Deno.test("a publish that answers with an id returns it, without asking the container", async () => {
  const { ports: p, calls } = ports([{ id: "media-1" }]);
  assertEquals(await publishContainer(p, reel), { id: "media-1" });
  assertEquals(calls.checks, 0);
});

Deno.test("the incident: an unanswered publish of a reel that went live is left for the reconciler, not failed", async () => {
  const { ports: p, calls } = ports([timedOut], [{ state: "published" }]);
  const error = await assertRejects(() => publishContainer(p, reel));
  assertInstanceOf(error, ContainerStillProcessing);
  assertEquals((error as ContainerStillProcessing).containerId, "c1");
  assertEquals(calls.publishTimeouts.length, 1); // never published a second time
});

Deno.test("an unanswered publish whose container never published is sent again (Meta publishes a container once)", async () => {
  const { ports: p, calls } = ports([timedOut, { id: "media-2" }], [{ state: "finished" }]);
  assertEquals(await publishContainer(p, reel), { id: "media-2" });
  assertEquals(calls.publishTimeouts.length, 2);
});

Deno.test("after an unanswered attempt, an error reply is checked against the container, never taken as failure", async () => {
  // The first publish was landing while the check still read FINISHED; the second is refused.
  const { ports: p } = ports(
    [timedOut, { error: { code: 100, message: "The media has already been published" } }],
    [{ state: "finished" }, { state: "published" }],
  );
  assertInstanceOf(await assertRejects(() => publishContainer(p, reel)), ContainerStillProcessing);
});

Deno.test("an unanswered last attempt is deferred, not reported as the plain timeout", async () => {
  const { ports: p } = ports([timedOut], [{ state: "finished" }]);
  assertInstanceOf(await assertRejects(() => publishContainer(p, { ...reel, maxRetries: 1 })), ContainerStillProcessing);
});

Deno.test("each publish is cut so the follow-up check still fits before the deadline", async () => {
  const { ports: p, calls } = ports([{ id: "media-1" }]);
  await publishContainer(p, { ...reel, deadlineMs: 12_000 });
  assertEquals(calls.publishTimeouts, [12_000 - CHECK_TIMEOUT_MS]);
});

Deno.test("with no time left to publish and learn the outcome, nothing is sent: a reel is deferred, another refused as safe to retry", async () => {
  const short = { deadlineMs: CHECK_TIMEOUT_MS + MIN_REQUEST_MS - 1 };
  const deferred = ports([{ id: "never" }]);
  assertInstanceOf(await assertRejects(() => publishContainer(deferred.ports, { ...reel, ...short })), ContainerStillProcessing);
  assertEquals(deferred.calls.publishTimeouts, []);

  const image = ports([{ id: "never" }]);
  await assertRejects(() => publishContainer(image.ports, { creationId: "c2", requestTimeoutMs: 20_000, ...short }), Error, NOT_SENT_MESSAGE);
  assertEquals(image.calls.publishTimeouts, []);
});

Deno.test("an unknown outcome defers a reel; a container Meta failed reports Meta's reason", async () => {
  const unknown = ports([timedOut], [{ state: "waiting" }]);
  assertInstanceOf(await assertRejects(() => publishContainer(unknown.ports, reel)), ContainerStillProcessing);

  const failed = ports([timedOut], [{ state: "failed", reason: "ERROR: code 2207026" }]);
  await assertRejects(() => publishContainer(failed.ports, reel), Error, "ERROR: code 2207026");
});

Deno.test("without a reconciler, a live post is reported as possibly live, and an unknown one keeps its error", async () => {
  const live = ports([timedOut], [{ state: "published" }]);
  await assertRejects(() => publishContainer(live.ports, { creationId: "c1", requestTimeoutMs: 20_000 }), Error, PUBLISHED_UNCONFIRMED_MESSAGE);

  const unknown = ports([timedOut], [{ state: "waiting" }]);
  await assertRejects(() => publishContainer(unknown.ports, { creationId: "c1", requestTimeoutMs: 20_000 }), Error, "Request timed out");
});

Deno.test("Meta's transient errors are retried with backoff; others fail at once", async () => {
  const transient = ports([{ error: { code: 9007, message: "Media ID is not available" } }, { id: "media-3" }]);
  assertEquals(await publishContainer(transient.ports, { ...reel, initialDelayMs: 100 }), { id: "media-3" });
  assertEquals(transient.calls.sleeps, [100]);

  const fatal = ports([{ error: { code: 190, message: "Invalid OAuth access token" } }]);
  await assertRejects(() => publishContainer(fatal.ports, reel), Error, "Invalid OAuth access token");
  assertEquals(fatal.calls.publishTimeouts.length, 1);

  assertEquals(isRetryablePublishError({ code: 2 }), true);
  assertEquals(isRetryablePublishError({ message: "Please retry your request later" }), true);
  assertEquals(isRetryablePublishError({ code: 100, message: "Invalid parameter" }), false);
});

Deno.test("a published container's media is the only recent one with the post's caption, or none", () => {
  const since = Date.parse("2026-10-30T15:00:00Z");
  const reelMedia = { id: "m1", caption: "Mirror reel 🪞", timestamp: "2026-10-30T15:03:26+0000", permalink: "https://www.instagram.com/reel/a/" };
  const older = { id: "m0", caption: "Mirror reel 🪞", timestamp: "2026-10-29T15:03:26+0000" };
  const other = { id: "m2", caption: "Another post", timestamp: "2026-10-30T15:04:00+0000" };

  assertEquals(matchPublishedMedia([other, reelMedia, older], " Mirror reel 🪞 ", since), reelMedia);
  // Two copies (the duplicate case) cannot be told apart: no answer rather than a wrong id.
  assertEquals(matchPublishedMedia([reelMedia, { ...reelMedia, id: "m3" }], "Mirror reel 🪞", since), null);
  assertEquals(matchPublishedMedia([reelMedia], "", since), null);
  assertEquals(matchPublishedMedia([older], "Mirror reel 🪞", since), null);
});
