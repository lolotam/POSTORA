import { assertEquals, assertInstanceOf, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ContainerState } from "../_shared/metaContainerStatus.ts";
import { ContainerStillProcessing } from "./deferredPublish.ts";
import type { GraphResponse } from "./graphResponse.ts";
import { isRetryablePublishError, publishContainer, PUBLISHED_UNCONFIRMED_MESSAGE } from "./instagramPublish.ts";

/** Ports whose publish answers come from `replies` (an Error means the request went unanswered). */
function ports(replies: (GraphResponse | Error)[], containerStates: ContainerState[] = []) {
  const calls = { publish: 0, containerState: 0, sleeps: [] as number[] };
  return {
    calls,
    ports: {
      publish: () => {
        const reply = replies[Math.min(calls.publish++, replies.length - 1)];
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
      containerState: () => Promise.resolve(containerStates[Math.min(calls.containerState++, containerStates.length - 1)] ?? { state: "waiting" as const }),
      sleep: (ms: number) => {
        calls.sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}
const timedOut = new Error("Request timed out");

Deno.test("a publish that answers with an id returns it", async () => {
  const { ports: p, calls } = ports([{ id: "media-1" }]);
  assertEquals(await publishContainer(p, { creationId: "c1" }), { id: "media-1" });
  assertEquals(calls.containerState, 0);
});

Deno.test("an unanswered publish of a reel that went live is left for the reconciler, not failed", async () => {
  // The incident: media_publish took longer than the timeout while Instagram published the reel.
  const { ports: p, calls } = ports([timedOut], [{ state: "published" }]);
  const error = await assertRejects(() => publishContainer(p, { creationId: "c1", deferKind: "ig_reel" }));
  assertInstanceOf(error, ContainerStillProcessing);
  assertEquals((error as ContainerStillProcessing).containerId, "c1");
  assertEquals(calls.publish, 1); // never published a second time
});

Deno.test("an unanswered publish whose container never published is sent again (Meta publishes a container once)", async () => {
  const { ports: p, calls } = ports([timedOut, { id: "media-2" }], [{ state: "finished" }]);
  assertEquals(await publishContainer(p, { creationId: "c1", deferKind: "ig_reel" }), { id: "media-2" });
  assertEquals(calls.publish, 2);
});

Deno.test("an unanswered publish that cannot be confirmed goes to the reconciler when it can, else keeps its error", async () => {
  const deferrable = ports([timedOut], [{ state: "waiting" }]);
  assertInstanceOf(await assertRejects(() => publishContainer(deferrable.ports, { creationId: "c1", deferKind: "ig_business_reel" })), ContainerStillProcessing);

  const plain = ports([timedOut], [{ state: "waiting" }]);
  await assertRejects(() => publishContainer(plain.ports, { creationId: "c1" }), Error, "Request timed out");
});

Deno.test("without a reconciler, a live post is reported as possibly live, never as a plain failure", async () => {
  const { ports: p } = ports([timedOut], [{ state: "published" }]);
  await assertRejects(() => publishContainer(p, { creationId: "c1" }), Error, PUBLISHED_UNCONFIRMED_MESSAGE);
});

Deno.test("a container Meta failed reports Meta's reason", async () => {
  const { ports: p } = ports([timedOut], [{ state: "failed", reason: "ERROR: code 2207026" }]);
  await assertRejects(() => publishContainer(p, { creationId: "c1", deferKind: "ig_reel" }), Error, "ERROR: code 2207026");
});

Deno.test("Meta's transient errors are retried with backoff; others fail at once", async () => {
  const transient = ports([{ error: { code: 9007, message: "Media ID is not available" } }, { id: "media-3" }]);
  assertEquals(await publishContainer(transient.ports, { creationId: "c1", initialDelayMs: 100 }), { id: "media-3" });
  assertEquals(transient.calls.sleeps, [100]);

  const fatal = ports([{ error: { code: 190, message: "Invalid OAuth access token" } }]);
  await assertRejects(() => publishContainer(fatal.ports, { creationId: "c1" }), Error, "Invalid OAuth access token");
  assertEquals(fatal.calls.publish, 1);

  assertEquals(isRetryablePublishError({ code: 2 }), true);
  assertEquals(isRetryablePublishError({ message: "Please retry your request later" }), true);
  assertEquals(isRetryablePublishError({ code: 100, message: "Invalid parameter" }), false);
});
