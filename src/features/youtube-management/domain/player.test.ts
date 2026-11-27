import { describe, expect, it } from "vitest";
import {
  PLAYER_MESSAGE_MAX_BYTES,
  YOUTUBE_EMBED_ORIGIN,
  YOUTUBE_PLAYBACK_RATES,
  YOUTUBE_VIDEO_ID_PATTERN,
  buildYouTubeEmbedUrl,
  buildYouTubeListeningMessage,
  buildYouTubeWatchUrl,
  parsePlayerMessage,
  playerCommand,
} from "./player";

const VIDEO_ID = "AbcD1234eFg";
const ORIGIN = "https://postora.cloud";

describe("the video id pattern", () => {
  it("accepts eleven URL-safe characters", () => {
    expect(YOUTUBE_VIDEO_ID_PATTERN.test(VIDEO_ID)).toBe(true);
    expect(YOUTUBE_VIDEO_ID_PATTERN.test("a_-bC123456")).toBe(true);
  });

  it.each([
    ["ten characters", "AbcD1234eF"],
    ["twelve characters", "AbcD1234eFgH"],
    ["a slash", "AbcD1234eF/g"],
    ["a query string", "AbcD1234eF?v=1"],
    ["an empty value", ""],
  ])("refuses %s", (_scenario, value) => {
    expect(YOUTUBE_VIDEO_ID_PATTERN.test(value)).toBe(false);
  });
});

describe("buildYouTubeEmbedUrl", () => {
  it("builds the privacy-enhanced embed URL with the page origin", () => {
    expect(buildYouTubeEmbedUrl(VIDEO_ID, ORIGIN)).toBe(
      "https://www.youtube-nocookie.com/embed/AbcD1234eFg"
      + "?enablejsapi=1&playsinline=1&rel=0&autoplay=1"
      + "&origin=https%3A%2F%2Fpostora.cloud",
    );
  });

  it("never builds an URL from an id that is not a video id", () => {
    expect(buildYouTubeEmbedUrl("short-id", ORIGIN)).toBeNull();
    expect(buildYouTubeEmbedUrl("", ORIGIN)).toBeNull();
  });

  it.each([
    ["an empty origin", ""],
    ["a relative path", "/youtube"],
    ["a page URL", "https://postora.cloud/youtube"],
    ["a non-HTTP scheme", "javascript:alert(1)"],
  ])("refuses %s", (_scenario, origin) => {
    expect(buildYouTubeEmbedUrl(VIDEO_ID, origin)).toBeNull();
  });
});

describe("buildYouTubeWatchUrl", () => {
  it("builds the watch URL of a proven video id", () => {
    expect(buildYouTubeWatchUrl(VIDEO_ID)).toBe("https://www.youtube.com/watch?v=AbcD1234eFg");
  });

  it("refuses an id that is not a video id", () => {
    expect(buildYouTubeWatchUrl("short")).toBeNull();
  });
});

describe("the handshake and the commands", () => {
  it("asks the embed to start reporting", () => {
    expect(buildYouTubeListeningMessage()).toBe(
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
    );
  });

  it("sends a command with its arguments", () => {
    expect(playerCommand("setVolume", [40])).toBe(
      JSON.stringify({ event: "command", func: "setVolume", args: [40], id: 1, channel: "widget" }),
    );
  });

  it("sends a command without arguments", () => {
    expect(playerCommand("playVideo")).toBe(
      JSON.stringify({ event: "command", func: "playVideo", args: [], id: 1, channel: "widget" }),
    );
  });
});

describe("parsePlayerMessage", () => {
  it("reads the fields the embed reports", () => {
    expect(parsePlayerMessage({
      event: "infoDelivery",
      info: {
        playerState: 1,
        volume: 55,
        muted: false,
        playbackRate: 1.5,
        availablePlaybackRates: [0.5, 1, 1.5, 2],
        playbackQuality: "hd720",
      },
    })).toEqual({
      playerState: 1,
      volume: 55,
      muted: false,
      playbackRate: 1.5,
      availablePlaybackRates: [0.5, 1, 1.5, 2],
      playbackQuality: "hd720",
    });
  });

  it("reads the same report when it arrives as a JSON string", () => {
    expect(parsePlayerMessage(JSON.stringify({ event: "onReady", info: { playerState: 5 } })))
      .toEqual({ playerState: 5 });
  });

  it("refuses a message that is not JSON", () => {
    expect(parsePlayerMessage("not json at all")).toBeNull();
  });

  it("refuses a message with an unexpected shape", () => {
    expect(parsePlayerMessage(null)).toBeNull();
    expect(parsePlayerMessage("[]")).toBeNull();
    expect(parsePlayerMessage({ event: "somethingElse", info: { playerState: 1 } })).toBeNull();
    expect(parsePlayerMessage({ event: "infoDelivery" })).toBeNull();
    expect(parsePlayerMessage({ event: "infoDelivery", info: {} })).toBeNull();
  });

  it("refuses an oversized message before parsing it", () => {
    const oversized = JSON.stringify({ event: "infoDelivery", info: { playerState: 1 } })
      + "x".repeat(PLAYER_MESSAGE_MAX_BYTES);
    expect(parsePlayerMessage(oversized)).toBeNull();
  });

  it("drops the fields that are out of range instead of passing them on", () => {
    expect(parsePlayerMessage({
      event: "infoDelivery",
      info: {
        playerState: Number.NaN,
        volume: 240,
        muted: "yes",
        playbackRate: 3,
        availablePlaybackRates: [0.1, 5, 1],
        playbackQuality: "hd 720 <script>",
      },
    })).toEqual({ availablePlaybackRates: [1] });
  });

  it("refuses a playback rate the control does not offer", () => {
    expect(YOUTUBE_PLAYBACK_RATES).not.toContain(1.1);
    expect(parsePlayerMessage({ event: "infoDelivery", info: { playbackRate: 1.1 } })).toBeNull();
  });
});
