import { describe, expect, it } from "vitest";
import { CAPTION_CONTENT_MAX_BYTES } from "../../../../supabase/functions/youtube-resources/captionFile";
import {
  CAPTION_CONTENT_MAX_BYTES as FRONTEND_CAPTION_CONTENT_MAX_BYTES,
  captionOutcomeFromErrorCode,
  inferCaptionFormatFromFileName,
  measureCaptionUtf8Bytes,
} from "./captions";

describe("caption byte limit", () => {
  it("is the same ceiling the edge function enforces", () => {
    // The browser refuses an oversize file before it leaves the page, so the
    // two limits have to be one number: a drifted copy would send a file the
    // server refuses, and would refuse one the server accepts.
    expect(FRONTEND_CAPTION_CONTENT_MAX_BYTES).toBe(CAPTION_CONTENT_MAX_BYTES);
    expect(FRONTEND_CAPTION_CONTENT_MAX_BYTES).toBe(524_288);
  });
});

describe("measureCaptionUtf8Bytes", () => {
  it("counts bytes, not characters", () => {
    expect(measureCaptionUtf8Bytes("")).toBe(0);
    expect(measureCaptionUtf8Bytes("abc")).toBe(3);
    // Arabic letters are two UTF-8 bytes each, so a file that fits by
    // character count can still be twice the size on the wire.
    expect(measureCaptionUtf8Bytes("مرحبا")).toBe(10);
  });

  it("measures the byte boundary the server measures", () => {
    expect(measureCaptionUtf8Bytes("a".repeat(524_288))).toBe(524_288);
    expect(measureCaptionUtf8Bytes("a".repeat(524_289))).toBe(524_289);
    expect(measureCaptionUtf8Bytes("م".repeat(262_144))).toBe(524_288);
  });
});

describe("inferCaptionFormatFromFileName", () => {
  it("reads the format from the name, whatever the case", () => {
    expect(inferCaptionFormatFromFileName("captions.srt")).toBe("srt");
    expect(inferCaptionFormatFromFileName("captions.SRT")).toBe("srt");
    expect(inferCaptionFormatFromFileName("captions.vtt")).toBe("vtt");
    expect(inferCaptionFormatFromFileName("captions.VTT")).toBe("vtt");
  });

  it("refuses anything that is not a caption file", () => {
    expect(inferCaptionFormatFromFileName("captions.txt")).toBeNull();
    expect(inferCaptionFormatFromFileName("captions.srt.bak")).toBeNull();
    expect(inferCaptionFormatFromFileName("srt")).toBeNull();
    expect(inferCaptionFormatFromFileName("")).toBeNull();
  });
});

describe("captionOutcomeFromErrorCode", () => {
  it("names the two caption refusals", () => {
    expect(captionOutcomeFromErrorCode("caption_conflict")).toBe("caption_conflict");
    expect(captionOutcomeFromErrorCode("caption_invalid")).toBe("caption_invalid");
  });

  it("keeps the limit refusals apart", () => {
    expect(captionOutcomeFromErrorCode("rate_limited")).toBe("rate_limited");
    expect(captionOutcomeFromErrorCode("quota_exceeded")).toBe("quota_exceeded");
  });

  it("reports a definite refusal as refused, so nothing is retried", () => {
    for (const code of [
      "reconnect_required",
      "not_found",
      "unauthorized",
      "upstream_unavailable",
      "missing_scope",
      "provider_unsupported",
      "write_not_enabled",
      "invalid_request",
      "internal_error",
    ]) {
      expect(captionOutcomeFromErrorCode(code)).toBe("refused");
    }
  });

  it("reports a lost or unknown answer as unknown, so the creator refreshes", () => {
    expect(captionOutcomeFromErrorCode("outcome_unknown")).toBe("outcome_unknown");
    expect(captionOutcomeFromErrorCode("something_new")).toBe("outcome_unknown");
    expect(captionOutcomeFromErrorCode(null)).toBe("outcome_unknown");
    expect(captionOutcomeFromErrorCode(undefined)).toBe("outcome_unknown");
  });
});
