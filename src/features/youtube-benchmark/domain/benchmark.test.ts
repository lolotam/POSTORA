import { describe, expect, it } from "vitest";
import {
  computeRecentVideoAverages,
  isBenchmarkInputFailure,
  isSettledBenchmarkChannel,
  isValidBenchmarkChannelInput,
  normalizeBenchmarkChannelInput,
  parseBenchmarkInputs,
} from "./benchmark";
import type { YouTubeBenchmarkChannel, YouTubeBenchmarkRecentVideo } from "./types";

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

function channel(overrides: Partial<YouTubeBenchmarkChannel> = {}): YouTubeBenchmarkChannel {
  return {
    input: "@someone",
    status: "found",
    channel_id: CHANNEL_ID,
    title: "Someone",
    thumbnail_url: null,
    subscriber_count: 10,
    subscriber_count_hidden: false,
    view_count: 100,
    video_count: 5,
    recent_videos: [],
    ...overrides,
  };
}

function video(overrides: Partial<YouTubeBenchmarkRecentVideo> = {}): YouTubeBenchmarkRecentVideo {
  return {
    id: "v1",
    title: "A video",
    published_at: null,
    view_count: 100,
    like_count: 10,
    comment_count: 2,
    ...overrides,
  };
}

describe("normalizeBenchmarkChannelInput", () => {
  it("trims the input and lowercases a handle, because a handle is case-insensitive", () => {
    expect(normalizeBenchmarkChannelInput("  @GoogleDevelopers  ")).toBe("@googledevelopers");
  });

  it("preserves the exact case of a channel id", () => {
    expect(normalizeBenchmarkChannelInput(` ${CHANNEL_ID} `)).toBe(CHANNEL_ID);
  });

  it("leaves an unusable input as it is, so it still fails the pattern", () => {
    expect(normalizeBenchmarkChannelInput("  not-a-handle ")).toBe("not-a-handle");
  });
});

describe("isValidBenchmarkChannelInput", () => {
  it("accepts a handle or a channel id of the documented shape", () => {
    expect(isValidBenchmarkChannelInput("@abc")).toBe(true);
    expect(isValidBenchmarkChannelInput(`@${"a".repeat(30)}`)).toBe(true);
    expect(isValidBenchmarkChannelInput(`  ${CHANNEL_ID}  `)).toBe(true);
  });

  it("refuses a handle or a channel id outside it", () => {
    expect(isValidBenchmarkChannelInput("@ab")).toBe(false);
    expect(isValidBenchmarkChannelInput(`@${"a".repeat(31)}`)).toBe(false);
    expect(isValidBenchmarkChannelInput("@bad handle")).toBe(false);
    expect(isValidBenchmarkChannelInput("@bad/handle")).toBe(false);
    expect(isValidBenchmarkChannelInput("UCtooshort")).toBe(false);
    expect(isValidBenchmarkChannelInput(`UC${"a".repeat(23)}`)).toBe(false);
  });
});

describe("parseBenchmarkInputs", () => {
  it("refuses an empty comparison", () => {
    const result = parseBenchmarkInputs(["", "   "]);
    expect(isBenchmarkInputFailure(result)).toBe(true);
    if (isBenchmarkInputFailure(result)) expect(result.reason).toBe("empty");
  });

  it("refuses more than three channels", () => {
    const result = parseBenchmarkInputs(["@a1", "@b2", "@c3", "@d4"]);
    expect(isBenchmarkInputFailure(result)).toBe(true);
    if (isBenchmarkInputFailure(result)) expect(result.reason).toBe("too_many");
  });

  it("refuses an unusable input and names it", () => {
    const result = parseBenchmarkInputs(["@okay", "nope"]);
    expect(isBenchmarkInputFailure(result)).toBe(true);
    if (isBenchmarkInputFailure(result)) {
      expect(result.reason).toBe("invalid_input");
      expect(result.invalidValue).toBe("nope");
    }
  });

  it("refuses the same channel twice, however it was typed", () => {
    const result = parseBenchmarkInputs(["@Someone", "@someone"]);
    expect(isBenchmarkInputFailure(result)).toBe(true);
    if (isBenchmarkInputFailure(result)) expect(result.reason).toBe("duplicate_input");
  });

  it("drops the blank inputs and normalises the rest", () => {
    const result = parseBenchmarkInputs(["@Someone", "  ", CHANNEL_ID]);
    expect(isBenchmarkInputFailure(result)).toBe(false);
    if (!isBenchmarkInputFailure(result)) {
      expect(result.inputs).toEqual(["@someone", CHANNEL_ID]);
    }
  });
});

describe("computeRecentVideoAverages", () => {
  it("averages the recent videos of one channel", () => {
    const averages = computeRecentVideoAverages([
      video({ view_count: 100, like_count: 10, comment_count: 0 }),
      video({ id: "v2", view_count: 300, like_count: 30, comment_count: 4 }),
    ]);
    expect(averages.sampleCount).toBe(2);
    expect(averages.averageViews).toBe(200);
    expect(averages.averageLikes).toBe(20);
    expect(averages.averageComments).toBe(2);
  });

  it("skips the counters a video does not expose", () => {
    const averages = computeRecentVideoAverages([
      video({ view_count: 100, like_count: null, comment_count: null }),
      video({ id: "v2", view_count: 200, like_count: null, comment_count: null }),
    ]);
    expect(averages.averageViews).toBe(150);
    expect(averages.averageLikes).toBeNull();
    expect(averages.averageComments).toBeNull();
  });

  it("reports no average for an empty sample", () => {
    const averages = computeRecentVideoAverages([]);
    expect(averages.sampleCount).toBe(0);
    expect(averages.averageViews).toBeNull();
    expect(averages.averageLikes).toBeNull();
    expect(averages.averageComments).toBeNull();
  });
});

describe("isSettledBenchmarkChannel", () => {
  it("settles a channel that was read and a channel the provider does not have", () => {
    expect(isSettledBenchmarkChannel(channel())).toBe(true);
    expect(isSettledBenchmarkChannel(channel({ status: "not_found" }))).toBe(true);
  });

  it("never settles a channel that could not be read completely", () => {
    expect(
      isSettledBenchmarkChannel(channel({ status: "unavailable", error: "quota_exceeded" })),
    ).toBe(false);
    expect(isSettledBenchmarkChannel(channel({ error: "upstream_unavailable" }))).toBe(false);
  });
});
