/**
 * What an upload hands to the outer loop when it cannot settle its row.
 *
 * The upload already wrote to the provider, so the only honest answer to a
 * settlement that was refused -- or whose answer was lost -- is that the row
 * is STILL OPEN. The row exists, it belongs to this attempt, and the upload
 * recovery owns it.
 *
 * The answer must not be a failure. A failure rolls the parent up: the post
 * becomes "failed" and the customer is told that the publication is over,
 * while the row under it is still open and could still be offered as a retry
 * that publishes a second video.
 *
 * A pending destination keeps the parent PROCESSING, and these are the checks
 * that say so.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  pendingDestinationResult,
  settleYoutubeUpload,
  youtubeUploadHandoff,
  type YoutubeUploadSettlementPort,
} from "./youtubeUploadHandoff.ts";
import { parentStatusForDestinations } from "./postSettlement.ts";
import type { YoutubeUploadRefusal } from "./youtubeResumableUpload.ts";

/** A store whose settlement the database refused. */
function refusedStore(reason: YoutubeUploadRefusal = "lease_stale"): YoutubeUploadSettlementPort {
  return { settle: () => Promise.resolve({ settled: false, refused: reason }) };
}

/** A store that lost the answer of the settlement. */
function lostStore(): YoutubeUploadSettlementPort {
  return { settle: () => Promise.reject(new Error("the connection was reset")) };
}

/** A store that recorded the outcome. */
function confirmedStore(): YoutubeUploadSettlementPort {
  return { settle: () => Promise.resolve({ settled: true, refused: null }) };
}

Deno.test("a settlement the database refused leaves the destination pending, and the post stays processing", async () => {
  const settlement = await settleYoutubeUpload(refusedStore(), "session-1", "lease-1", {
    status: "success",
    videoId: "yt-video-1",
  });
  assertEquals(settlement.confirmed, false);
  assertEquals(settlement.reason, "lease_stale");

  const handoff = youtubeUploadHandoff(settlement, "row-1");
  assertEquals(handoff.kind, "pending");
  assertEquals(handoff.kind === "pending" && handoff.pendingContinuation, true);
  assertEquals(handoff.kind === "pending" && handoff.pendingPlatformPostId, "row-1");

  // A failure would roll the parent up to a terminal state while the row is
  // still open, so the handoff carries no failure at all.
  assertEquals(Object.hasOwn(handoff, "selfWroteRows"), false);
  assertEquals(Object.hasOwn(handoff, "error"), false);

  // THE OUTER LOOP: the destination is pending, so the post is not over.
  const results = [pendingDestinationResult("youtube")];
  assertEquals(results[0].status, "pending");
  assertEquals(parentStatusForDestinations(results), "processing");
});

Deno.test("a settlement whose answer was lost leaves the destination pending too", async () => {
  const settlement = await settleYoutubeUpload(lostStore(), "session-1", "lease-1", {
    status: "success",
    videoId: "yt-video-1",
  });
  assertEquals(settlement.confirmed, false);
  assertEquals(settlement.reason, "answer_lost");

  const handoff = youtubeUploadHandoff(settlement, "row-1");
  assertEquals(handoff.kind, "pending");
  assertEquals(parentStatusForDestinations([pendingDestinationResult("youtube")]), "processing");
});

Deno.test("a recorded settlement lets the post roll up", async () => {
  const settlement = await settleYoutubeUpload(confirmedStore(), "session-1", "lease-1", {
    status: "success",
    videoId: "yt-video-1",
  });
  assertEquals(settlement.confirmed, true);
  assertEquals(settlement.reason, null);

  const handoff = youtubeUploadHandoff(settlement, "row-1");
  assertEquals(handoff.kind, "settled");
});

Deno.test("a destination that is settled does not keep the post waiting", () => {
  assertEquals(parentStatusForDestinations([{ platform: "youtube", status: "success" }]), "completed");
  assertEquals(parentStatusForDestinations([{ platform: "youtube", status: "failed" }]), "failed");
});

Deno.test("the settlement is fenced: the lease and the session travel with it", async () => {
  let seen: { sessionId: string; leaseToken: string; status: string; videoId: string | null } | null = null;
  const store: YoutubeUploadSettlementPort = {
    settle: (input) => {
      seen = {
        sessionId: input.sessionId,
        leaseToken: input.leaseToken,
        status: input.status,
        videoId: input.videoId ?? null,
      };
      return Promise.resolve({ settled: true, refused: null });
    },
  };

  await settleYoutubeUpload(store, "session-1", "lease-1", { status: "success", videoId: "yt-video-1" });

  assertEquals(seen, {
    sessionId: "session-1",
    leaseToken: "lease-1",
    status: "success",
    videoId: "yt-video-1",
  });
});
