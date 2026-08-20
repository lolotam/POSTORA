/**
 * Higgsfield job-payload reader tests.
 *
 * The fixtures below are captured verbatim from the live `job_status` tool for
 * job 1777eba3 (nano_banana_2_lite). Reading only the top level of these
 * payloads is what made every async generation appear to run forever, so the
 * real nesting is pinned here rather than described.
 *
 * @module lib/higgsfieldJobPayload.test
 */

import { describe, it, expect } from "vitest";
import {
  extractToolPayload,
  findJobId,
  findOutputUrl,
  readJobSnapshot,
} from "./higgsfieldJobPayload";

const RAW_PNG =
  "https://d8j0ntlcm91z4.cloudfront.net/user_3EdClEC844P74nTtlNxhy5SFk3k/hf_20260817_222311_1777eba3-2789-4906-82ad-7782f86370f9.png";
const MIN_WEBP =
  "https://d8j0ntlcm91z4.cloudfront.net/user_3EdClEC844P74nTtlNxhy5SFk3k/hf_20260817_222311_1777eba3-2789-4906-82ad-7782f86370f9_min.webp";

/** Exactly what job_status returns by default. */
const COMPLETED = {
  generation: {
    id: "1777eba3-2789-4906-82ad-7782f86370f9",
    type: "image",
    status: "completed",
    model: "nano_banana_2_lite",
    params: { prompt: "a category tile", aspect_ratio: "1:1", width: 1024, height: 1024 },
    results: { rawUrl: RAW_PNG, minUrl: MIN_WEBP },
    createdAt: 1787005391.089612,
  },
};

/** Exactly what job_status returns with raw_data: true. */
const COMPLETED_RAW = {
  raw_data: {
    id: "1777eba3-2789-4906-82ad-7782f86370f9",
    status: "completed",
    job_set_type: "nano_banana_2_lite",
    result_url: RAW_PNG,
    min_result_url: MIN_WEBP,
    h264_url: null,
    thumbnail_url: null,
    result_json: null,
    created_at: 1787005391.089612,
  },
};

describe("readJobSnapshot", () => {
  it("should report success for the real completed payload", () => {
    // The regression: status lives at generation.status, so reading only the
    // top level left every finished job stuck reporting "running".
    const snapshot = readJobSnapshot(COMPLETED);
    expect(snapshot.state).toBe("succeeded");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.outputUrl).toBe(RAW_PNG);
    expect(snapshot.error).toBeNull();
  });

  it("should report success for the raw_data form", () => {
    const snapshot = readJobSnapshot(COMPLETED_RAW);
    expect(snapshot.state).toBe("succeeded");
    expect(snapshot.outputUrl).toBe(RAW_PNG);
  });

  it("should still read a status at the top level", () => {
    expect(readJobSnapshot({ status: "succeeded", url: RAW_PNG }).state).toBe("succeeded");
    expect(readJobSnapshot({ state: "done", url: RAW_PNG }).state).toBe("succeeded");
  });

  it("should treat a job with no terminal status as still running", () => {
    expect(readJobSnapshot({ generation: { status: "queued" } }).state).toBe("running");
    expect(readJobSnapshot({ generation: { status: "in_progress" } }).state).toBe("running");
    expect(readJobSnapshot({}).state).toBe("running");
    expect(readJobSnapshot(null).state).toBe("running");
  });

  it("should not call a job finished just because a URL is present", () => {
    // A rendering job can already expose a preview; treating that as success
    // would archive a partial asset.
    const snapshot = readJobSnapshot({ generation: { status: "processing", results: { rawUrl: RAW_PNG } } });
    expect(snapshot.state).toBe("running");
    expect(snapshot.outputUrl).toBeNull();
  });

  it("should report failure for a nested failed status", () => {
    const snapshot = readJobSnapshot({ generation: { status: "failed", error: "content policy" } });
    expect(snapshot.state).toBe("failed");
    expect(snapshot.error).toBe("content policy");
  });

  it("should treat an nsfw rejection as a failure rather than an endless run", () => {
    expect(readJobSnapshot({ generation: { status: "nsfw" } }).state).toBe("failed");
  });

  it("should fail a success that carries no usable URL rather than hang", () => {
    const snapshot = readJobSnapshot({ generation: { status: "completed", results: {} } });
    expect(snapshot.state).toBe("failed");
    expect(snapshot.error).toMatch(/no output URL/i);
  });

  it("should honour a nested poll_after_seconds and clamp it", () => {
    expect(readJobSnapshot({ generation: { status: "queued", poll_after_seconds: 12 } }).pollAfterSeconds).toBe(12);
    expect(readJobSnapshot({ generation: { status: "queued", poll_after_seconds: 999 } }).pollAfterSeconds).toBe(30);
    expect(readJobSnapshot({ generation: { status: "queued" } }).pollAfterSeconds).toBe(5);
  });

  it("should be case-insensitive about the status", () => {
    expect(readJobSnapshot({ generation: { status: "COMPLETED", results: { rawUrl: RAW_PNG } } }).state).toBe(
      "succeeded",
    );
  });
});

describe("findOutputUrl", () => {
  it("should prefer the full-size asset over the downscaled preview", () => {
    // minUrl is a thumbnail; attaching it to a product instead of the PNG
    // would be a silent quality regression.
    expect(findOutputUrl(COMPLETED)).toBe(RAW_PNG);
    expect(findOutputUrl(COMPLETED_RAW)).toBe(RAW_PNG);
  });

  it("should prefer the full-size key regardless of property order", () => {
    const reordered = { generation: { results: { minUrl: MIN_WEBP, rawUrl: RAW_PNG } } };
    expect(findOutputUrl(reordered)).toBe(RAW_PNG);
  });

  it("should not fall back to a preview when the full-size asset is missing", () => {
    expect(findOutputUrl({ generation: { results: { minUrl: MIN_WEBP } } })).toBeNull();
    expect(findOutputUrl({ raw_data: { thumbnail_url: MIN_WEBP } })).toBeNull();
  });

  it("should ignore unrelated links that are not media", () => {
    expect(findOutputUrl({ generation: { docs: "https://higgsfield.ai/terms" } })).toBeNull();
  });

  it("should accept a media-looking URL found outside the known keys", () => {
    expect(findOutputUrl({ generation: { outputs: [RAW_PNG] } })).toBe(RAW_PNG);
  });

  it("should ignore non-https URLs", () => {
    expect(findOutputUrl({ url: "http://insecure.example/a.png" })).toBeNull();
  });

  it("should tolerate a circular payload", () => {
    const node: Record<string, unknown> = { generation: { status: "completed" } };
    node.self = node;
    expect(() => findOutputUrl(node)).not.toThrow();
  });
});

describe("findJobId", () => {
  it("should find the id in the real completed payload", () => {
    expect(findJobId(COMPLETED)).toBe("1777eba3-2789-4906-82ad-7782f86370f9");
    expect(findJobId(COMPLETED_RAW)).toBe("1777eba3-2789-4906-82ad-7782f86370f9");
  });

  it("should ignore non-uuid ids", () => {
    expect(findJobId({ id: "not-a-uuid" })).toBeNull();
  });
});

describe("extractToolPayload", () => {
  it("should prefer structuredContent", () => {
    expect(extractToolPayload({ structuredContent: COMPLETED, content: [] })).toEqual(COMPLETED);
  });

  it("should parse a JSON text block when there is no structuredContent", () => {
    const result = { content: [{ type: "text", text: JSON.stringify(COMPLETED) }] };
    expect(extractToolPayload(result)).toEqual(COMPLETED);
  });

  it("should fall back to joined text", () => {
    const result = { content: [{ type: "text", text: "Job 1777eba3 â€” completed" }] };
    expect(extractToolPayload(result)).toBe("Job 1777eba3 â€” completed");
  });

  it("should tolerate null", () => {
    expect(extractToolPayload(null)).toBeNull();
  });
});


