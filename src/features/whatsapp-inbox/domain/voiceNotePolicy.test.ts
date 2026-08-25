import { describe, expect, it } from "vitest";
import { canRecordForMode, pickRecordingMimeType } from "./voiceNotePolicy";

const oggCapable = (type: string) => type.startsWith("audio/ogg") || type.startsWith("audio/webm");
const webmOnly = (type: string) => type.startsWith("audio/webm");
const oggOnly = (type: string) => type.startsWith("audio/ogg");
const none = () => false;

describe("pickRecordingMimeType", () => {
  // WhatsApp voice notes are Ogg/Opus. Chromium only records WebM/Opus; the Evolution
  // container has ffmpeg 8.1.2 and transcodes under encoding: true, so no client-side
  // transcoder.
  it("prefers ogg/opus", () => {
    expect(pickRecordingMimeType((type) => type.startsWith("audio/ogg"))).toBe("audio/ogg;codecs=opus");
  });

  it("falls back to webm/opus", () => {
    expect(pickRecordingMimeType((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
  });

  it("falls back to bare webm when codecs=opus is not listed", () => {
    expect(pickRecordingMimeType((type) => type === "audio/webm")).toBe("audio/webm");
  });

  it("returns null when nothing is supported", () => {
    expect(pickRecordingMimeType(none)).toBeNull();
  });
});

describe("canRecordForMode", () => {
  // Cloud API voice notes are out of scope: Meta needs a media upload plus audio.voice: true,
  // which nothing here verifies. Sending a plain audio message and calling it a voice note
  // would look like success and not be one. The ogg exception exists so a browser that
  // already records ogg/opus is not treated as "would send WebM".
  it.each([
    { mode: "evolution_qr" as const, browser: "ogg-capable", supported: oggCapable, expected: true },
    { mode: "evolution_qr" as const, browser: "webm-only", supported: webmOnly, expected: true },
    { mode: "evolution_qr" as const, browser: "ogg-only", supported: oggOnly, expected: true },
    { mode: "cloud_api" as const, browser: "ogg-capable", supported: oggCapable, expected: true },
    { mode: "cloud_api" as const, browser: "webm-only", supported: webmOnly, expected: false },
    { mode: "coexistence" as const, browser: "ogg-capable", supported: oggCapable, expected: true },
    { mode: "coexistence" as const, browser: "webm-only", supported: webmOnly, expected: false },
    { mode: "cloud_api" as const, browser: "none", supported: none, expected: false },
    { mode: "evolution_qr" as const, browser: "none", supported: none, expected: false },
    { mode: null, browser: "ogg-capable", supported: oggCapable, expected: false },
  ])("$mode × $browser → $expected", ({ mode, supported, expected }) => {
    expect(canRecordForMode(mode, supported)).toBe(expected);
  });
});
