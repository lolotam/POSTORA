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

Deno.test("platform row failed with plain error maps to failed with sanitized reason", () => {
  // Error matching safe pattern is preserved
  const platformPostSafe: PlatformPostSnapshot = {
    status: "failed",
    platformPostUrl: null,
    errorMessage: "TikTok publish failed: validation failed",
    createdAt: baseTimestamp,
    postedAt: null,
  };

  const statusSafe = mapPublishStatus({
    platformPost: platformPostSafe,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(statusSafe.state, "failed");
  assertEquals(statusSafe.postUrl, null);
  assertEquals(statusSafe.reason, "TikTok publish failed: validation failed");

  // Error without safe pattern is sanitized to generic message
  const platformPostGeneric: PlatformPostSnapshot = {
    status: "failed",
    platformPostUrl: null,
    errorMessage: "Internal database query syntax error at line 42",
    createdAt: baseTimestamp,
    postedAt: null,
  };

  const statusGeneric = mapPublishStatus({
    platformPost: platformPostGeneric,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(statusGeneric.state, "failed");
  assertEquals(
    statusGeneric.reason,
    "An error occurred. Please try again or contact support if the problem persists.",
  );
});

Deno.test("platform row failed with TIKTOK_REVIEW_NEEDS_ATTENTION prefix maps to needs_attention with known sentence", () => {
  const platformPost: PlatformPostSnapshot = {
    status: "failed",
    platformPostUrl: null,
    errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:PRIVACY_NOT_OFFERED",
    createdAt: baseTimestamp,
    postedAt: null,
  };

  const status = mapPublishStatus({
    platformPost,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(status.state, "needs_attention");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, "This privacy setting isn't available for this account.");
});

Deno.test("platform row failed with TIKTOK_REVIEW_NEEDS_ATTENTION prefix maps unknown code to generic attention message", () => {
  const platformPost: PlatformPostSnapshot = {
    status: "failed",
    platformPostUrl: null,
    errorMessage: "TIKTOK_REVIEW_NEEDS_ATTENTION:NEW_UNMAPPED_CODE",
    createdAt: baseTimestamp,
    postedAt: null,
  };

  const status = mapPublishStatus({
    platformPost,
    post: defaultPost,
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(status.state, "needs_attention");
  assertEquals(
    status.reason,
    "These settings are no longer allowed. Review them before trying again.",
  );
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

Deno.test("no platform row with post status scheduled maps to scheduled state", () => {
  const status = mapPublishStatus({
    platformPost: null,
    post: {
      ...defaultPost,
      status: "scheduled",
      scheduledAt: "2026-10-03T09:00:00.000Z",
    },
    submission: {
      dispatchState: "scheduled",
      updatedAt: baseTimestamp,
    },
    nowMs,
  });

  assertEquals(status.state, "scheduled");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, null);
  assertEquals(status.updatedAt, "2026-10-03T09:00:00.000Z");
});

Deno.test("no platform row with post status failed maps to failed with Publishing could not start", () => {
  const status = mapPublishStatus({
    platformPost: null,
    post: { ...defaultPost, status: "failed" },
    submission: defaultSubmission,
    nowMs,
  });

  assertEquals(status.state, "failed");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, "Publishing could not start.");
});

Deno.test("no platform row with submission dispatch state unknown maps to needs_attention", () => {
  const status = mapPublishStatus({
    platformPost: null,
    post: defaultPost,
    submission: { dispatchState: "unknown", updatedAt: baseTimestamp },
    nowMs,
  });

  assertEquals(status.state, "needs_attention");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, "Publishing did not confirm it started.");
});

Deno.test("no platform row with submission dispatch state needs_attention maps to needs_attention", () => {
  const status = mapPublishStatus({
    platformPost: null,
    post: defaultPost,
    submission: { dispatchState: "needs_attention", updatedAt: baseTimestamp },
    nowMs,
  });

  assertEquals(status.state, "needs_attention");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, "This post needs attention before it can go out.");
});

Deno.test("no platform row with submission dispatching older than 5 minutes maps to needs_attention", () => {
  const staleTime = new Date(nowMs - (5 * 60 * 1000 + 1000)).toISOString(); // 5m 1s ago
  const status = mapPublishStatus({
    platformPost: null,
    post: defaultPost,
    submission: { dispatchState: "dispatching", updatedAt: staleTime },
    nowMs,
  });

  assertEquals(status.state, "needs_attention");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, "Publishing did not confirm it started.");
});

Deno.test("no platform row with submission dispatching fresh (<= 5 min) maps to queued", () => {
  const freshTime = new Date(nowMs - 60 * 1000).toISOString(); // 1m ago
  const status = mapPublishStatus({
    platformPost: null,
    post: defaultPost,
    submission: { dispatchState: "dispatching", updatedAt: freshTime },
    nowMs,
  });

  assertEquals(status.state, "queued");
  assertEquals(status.postUrl, null);
  assertEquals(status.reason, null);
});

Deno.test("no platform row with dispatch state pending_dispatch or dispatched maps to queued", () => {
  for (const state of ["pending_dispatch", "dispatched"]) {
    const status = mapPublishStatus({
      platformPost: null,
      post: defaultPost,
      submission: { dispatchState: state, updatedAt: baseTimestamp },
      nowMs,
    });

    assertEquals(status.state, "queued");
    assertEquals(status.postUrl, null);
    assertEquals(status.reason, null);
  }
});

Deno.test("without a platform post row, state is never reported as published", () => {
  // Even if post or dispatch state claims published or dispatched, without a platform row it cannot be published
  const states = ["dispatched", "pending_dispatch", "dispatching", "unknown", "needs_attention", "scheduled"];
  for (const dispatchState of states) {
    const status = mapPublishStatus({
      platformPost: null,
      post: defaultPost,
      submission: { dispatchState, updatedAt: baseTimestamp },
      nowMs,
    });
    assertEquals(status.state !== "published", true);
  }
});
