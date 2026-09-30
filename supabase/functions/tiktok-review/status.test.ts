import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mapPublishStatus,
  type MapPublishStatusInput,
  type PlatformPostSnapshot,
  type PostSnapshot,
  type SubmissionSnapshot,
} from "./status.ts";

const baseTimestamp = "2026-10-02T12:00:00.000Z";
const nowMs = Date.parse(baseTimestamp);

const defaultPost: PostSnapshot = {
  status: "pending",
  createdAt: baseTimestamp,
  postedAt: null,
  scheduledAt: null,
};

const defaultSubmission: SubmissionSnapshot = {
  dispatchState: "dispatched",
  updatedAt: baseTimestamp,
};

Deno.test("platform row success maps to published with postUrl and newest timestamp", () => {
  const platformPost: PlatformPostSnapshot = {
    status: "success",
    platformPostUrl: "https://www.tiktok.com/@postora/video/1234567890",
    errorMessage: null,
    createdAt: baseTimestamp,
    postedAt: "2026-10-02T12:01:00.000Z",
  };

  const status = mapPublishStatus({
    platformPost,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(status.state, "published");
  assertEquals(status.postUrl, "https://www.tiktok.com/@postora/video/1234567890");
  assertEquals(status.reason, null);
  assertEquals(status.updatedAt, "2026-10-02T12:01:00.000Z");
});

Deno.test("platform row failed errorMessage mapping (table-driven)", () => {
  const cases = [
    {
      name: "safe error pattern is preserved",
      errorMessage: "TikTok publish failed: validation failed",
      expectedState: "failed",
      expectedReason: "TikTok publish failed: validation failed",
    },
    {
      name: "generic error is sanitized",
      errorMessage: "Internal database query syntax error at line 42",
      expectedState: "failed",
      expectedReason: "An error occurred. Please try again or contact support if the problem persists.",
    },
    {
      name: "known policy code",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED",
      expectedState: "needs_attention",
      expectedReason: "This privacy setting isn't available for this account.",
    },
    {
      name: "multiple codes picks first policy code",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED,DURATION_EXCEEDED",
      expectedState: "needs_attention",
      expectedReason: "This privacy setting isn't available for this account.",
    },
    {
      name: "transient CREATOR_INFO_UNAVAILABLE",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:CREATOR_INFO_UNAVAILABLE",
      expectedState: "needs_attention",
      expectedReason: "TikTok or Postora was temporarily unavailable when publishing. Submit the post again from review.",
    },
    {
      name: "transient SUBMISSION_READ_FAILED",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_READ_FAILED",
      expectedState: "needs_attention",
      expectedReason: "TikTok or Postora was temporarily unavailable when publishing. Submit the post again from review.",
    },
    {
      name: "transient SUBMISSION_NOT_FOUND",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:SUBMISSION_NOT_FOUND",
      expectedState: "needs_attention",
      expectedReason: "TikTok or Postora was temporarily unavailable when publishing. Submit the post again from review.",
    },
    {
      name: "transient MEDIA_READ_FAILED",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:MEDIA_READ_FAILED",
      expectedState: "needs_attention",
      expectedReason: "TikTok or Postora was temporarily unavailable when publishing. Submit the post again from review.",
    },
    {
      name: "ALREADY_DISPATCHED",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:ALREADY_DISPATCHED",
      expectedState: "needs_attention",
      expectedReason: "This post was already sent to TikTok. Check TikTok before trying again.",
    },
    {
      name: "SNAPSHOT_MISMATCH",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:SNAPSHOT_MISMATCH",
      expectedState: "needs_attention",
      expectedReason: "This post changed after it was approved. Review it again before publishing.",
    },
    {
      name: "unknown attention code",
      errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:NEW_UNMAPPED_CODE",
      expectedState: "needs_attention",
      expectedReason: "These settings are no longer allowed. Review them before trying again.",
    },
  ];

  for (const c of cases) {
    const status = mapPublishStatus({
      platformPost: {
        status: "failed",
        platformPostUrl: null,
        errorMessage: c.errorMessage,
        createdAt: baseTimestamp,
        postedAt: null,
      },
      post: defaultPost,
      submission: defaultSubmission,
      nowMs,
    });
    assertEquals(status.state, c.expectedState, `State mismatch for: ${c.name}`);
    assertEquals(status.reason, c.expectedReason, `Reason mismatch for: ${c.name}`);
  }
});

Deno.test("platform row pending maps to processing state", () => {
  const platformPost: PlatformPostSnapshot = {
    status: "pending",
    platformPostUrl: null,
    errorMessage: null,
    createdAt: baseTimestamp,
    postedAt: null,
  };

  const status = mapPublishStatus({
    platformPost,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(status.state, "processing");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, null);
});

Deno.test("no platform row status mapping (table-driven)", () => {
  const exactly5MinAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const past5MinAgo = new Date(nowMs - (5 * 60 * 1000 + 1000)).toISOString();
  const fresh1MinAgo = new Date(nowMs - 60 * 1000).toISOString();

  const cases = [
    {
      name: "post scheduled",
      input: {
        platformPost: null,
        post: { ...defaultPost, status: "scheduled", scheduledAt: "2026-10-03T09:00:00.000Z" },
        submission: { dispatchState: "scheduled", updatedAt: baseTimestamp },
        nowMs,
      },
      expectedState: "scheduled",
      expectedReason: null,
    },
    {
      name: "post failed",
      input: {
        platformPost: null,
        post: { ...defaultPost, status: "failed" },
        submission: defaultSubmission,
        nowMs,
      },
      expectedState: "failed",
      expectedReason: "Publishing could not start.",
    },
    {
      name: "dispatchState needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "needs_attention", updatedAt: baseTimestamp },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "This post needs attention before it can go out.",
    },
    {
      name: "dispatchState publishing",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "publishing", updatedAt: baseTimestamp },
        nowMs,
      },
      expectedState: "processing",
      expectedReason: null,
    },
    {
      name: "dispatchState dispatched",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "dispatched", updatedAt: baseTimestamp },
        nowMs,
      },
      expectedState: "queued",
      expectedReason: null,
    },
    {
      name: "fresh unknown (< 5m)",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "unknown", updatedAt: fresh1MinAgo },
        nowMs,
      },
      expectedState: "processing",
      expectedReason: null,
    },
    {
      name: "fresh dispatching (< 5m)",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "dispatching", updatedAt: fresh1MinAgo },
        nowMs,
      },
      expectedState: "processing",
      expectedReason: null,
    },
    {
      name: "fresh pending_dispatch (< 5m)",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "pending_dispatch", updatedAt: fresh1MinAgo },
        nowMs,
      },
      expectedState: "queued",
      expectedReason: null,
    },
    {
      name: "exactly 5:00 boundary unknown -> processing",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "unknown", updatedAt: exactly5MinAgo },
        nowMs,
      },
      expectedState: "processing",
      expectedReason: null,
    },
    {
      name: "exactly 5:00 boundary dispatching -> processing",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "dispatching", updatedAt: exactly5MinAgo },
        nowMs,
      },
      expectedState: "processing",
      expectedReason: null,
    },
    {
      name: "exactly 5:00 boundary pending_dispatch -> queued",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "pending_dispatch", updatedAt: exactly5MinAgo },
        nowMs,
      },
      expectedState: "queued",
      expectedReason: null,
    },
    {
      name: "stale unknown (> 5m) -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "unknown", updatedAt: past5MinAgo },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
    {
      name: "stale dispatching (> 5m) -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "dispatching", updatedAt: past5MinAgo },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
    {
      name: "stale pending_dispatch (> 5m) -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "pending_dispatch", updatedAt: past5MinAgo },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
    {
      name: "unparseable updatedAt with unknown -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "unknown", updatedAt: "invalid-date-string" },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
    {
      name: "unparseable updatedAt with dispatching -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "dispatching", updatedAt: "invalid-date-string" },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
    {
      name: "unparseable updatedAt with pending_dispatch -> needs_attention",
      input: {
        platformPost: null,
        post: defaultPost,
        submission: { dispatchState: "pending_dispatch", updatedAt: "invalid-date-string" },
        nowMs,
      },
      expectedState: "needs_attention",
      expectedReason: "Publishing did not confirm it started.",
    },
  ];

  for (const c of cases) {
    const status = mapPublishStatus(c.input);
    assertEquals(status.state, c.expectedState, `State mismatch for: ${c.name}`);
    assertEquals(status.reason, c.expectedReason, `Reason mismatch for: ${c.name}`);
  }
});
