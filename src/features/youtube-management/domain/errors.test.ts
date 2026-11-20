import { describe, expect, it } from "vitest";
import { isRetryableYouTubeError, toYouTubeResourceError, YouTubeResourceError } from "./errors";

describe("toYouTubeResourceError", () => {
  it("keeps the stable code and the retry hint the server sent", () => {
    const error = toYouTubeResourceError({ error: "rate_limited", request_id: "r", retry_after_seconds: 120 });
    expect(error).toBeInstanceOf(YouTubeResourceError);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(120);
  });

  it.each([null, "text", { error: "Quota exceeded for quota metric" }, { error: 42 }])(
    "treats an unknown payload as upstream_unavailable: %j",
    (payload) => {
      expect(toYouTubeResourceError(payload).code).toBe("upstream_unavailable");
    },
  );
});

describe("isRetryableYouTubeError", () => {
  it("retries only transient failures", () => {
    expect(isRetryableYouTubeError("upstream_unavailable")).toBe(true);
    expect(isRetryableYouTubeError("internal_error")).toBe(false);
    expect(isRetryableYouTubeError("quota_exceeded")).toBe(false);
    expect(isRetryableYouTubeError("rate_limited")).toBe(false);
    expect(isRetryableYouTubeError("not_found")).toBe(false);
    expect(isRetryableYouTubeError("reconnect_required")).toBe(false);
  });
});
