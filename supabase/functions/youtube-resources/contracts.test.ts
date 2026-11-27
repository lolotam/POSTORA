import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isYouTubeResourceErrorCode,
  YOUTUBE_RESOURCE_ERROR_STATUS,
  YOUTUBE_RESOURCE_QUOTA_POLICY,
  YOUTUBE_SCOPE,
} from "./contracts.ts";

Deno.test("each error code keeps its documented HTTP status", () => {
  assertEquals(YOUTUBE_RESOURCE_ERROR_STATUS, {
    invalid_request: 400,
    invalid_cursor: 400,
    unauthorized: 401,
    missing_scope: 403,
    write_not_enabled: 403,
    edit_conflict: 409,
    outcome_unknown: 502,
    not_found: 404,
    method_not_allowed: 405,
    provider_unsupported: 409,
    reconnect_required: 409,
    rate_limited: 429,
    quota_exceeded: 429,
    internal_error: 500,
    upstream_unavailable: 502,
  });
});

Deno.test("isYouTubeResourceErrorCode accepts known codes and rejects everything else", () => {
  assertEquals(isYouTubeResourceErrorCode("quota_exceeded"), true);
  assertEquals(isYouTubeResourceErrorCode("Quota exceeded for quota metric"), false);
  assertEquals(isYouTubeResourceErrorCode(429), false);
  assertEquals(isYouTubeResourceErrorCode(null), false);
});

Deno.test("the quota policy is the one the specification publishes", () => {
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.per_user_burst, { limit: 30, window_seconds: 600 });
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.per_user_daily, { limit: 300, window_seconds: 86400 });
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.unit_costs, {
    channel: 1,
    videos_page: 2,
    video: 1,
    playlists_page: 1,
  });
});

Deno.test("scope constants are the full Google scope URLs", () => {
  assertEquals(YOUTUBE_SCOPE.readonly, "https://www.googleapis.com/auth/youtube.readonly");
  assertEquals(YOUTUBE_SCOPE.upload, "https://www.googleapis.com/auth/youtube.upload");
  assertEquals(YOUTUBE_SCOPE.force_ssl, "https://www.googleapis.com/auth/youtube.force-ssl");
});
