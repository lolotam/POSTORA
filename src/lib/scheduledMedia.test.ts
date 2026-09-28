import { describe, expect, it } from "vitest";
import {
  CLOUD_SIZE_LIMITS_MB,
  cloudAccount,
  exceedsCloudSizeLimit,
  scheduledMessageType,
} from "@/lib/scheduledMedia";

describe("scheduledMedia", () => {
  it("maps QR accounts to native types and turns everything else into a document", () => {
    for (const [extension, expected] of [
      ["jpg", "image"],
      ["jpeg", "image"],
      ["png", "image"],
      ["gif", "image"],
      ["webp", "image"],
      ["mp4", "video"],
      ["mp3", "audio"],
      ["ogg", "audio"],
      ["psd", "document"],
      ["wav", "document"],
      ["zip", "document"],
      ["heic", "document"],
      ["mov", "document"],
      ["", "document"],
    ] as const) {
      expect(scheduledMessageType(extension, false), extension).toBe(expected);
    }
  });

  it("on Cloud accounts only whatsappCloud extensions pass and archives become documents", () => {
    expect(scheduledMessageType("jpg", true)).toBe("image");
    expect(scheduledMessageType("mp4", true)).toBe("video");
    expect(scheduledMessageType("mp3", true)).toBe("audio");
    expect(scheduledMessageType("ogg", true)).toBe("audio");
    expect(scheduledMessageType("docx", true)).toBe("document");
    expect(scheduledMessageType("pdf", true)).toBe("document");
    expect(scheduledMessageType("zip", true)).toBeNull();
    expect(scheduledMessageType("webp", true)).toBeNull();
    expect(scheduledMessageType("gif", true)).toBeNull();
    expect(scheduledMessageType("psd", true)).toBeNull();
    expect(scheduledMessageType("", true)).toBeNull();
  });

  it("checks the Cloud image 5 MB boundary and ignores unknown sizes", () => {
    expect(exceedsCloudSizeLimit("image", CLOUD_SIZE_LIMITS_MB.image * 1024 * 1024)).toBe(false);
    expect(exceedsCloudSizeLimit("image", CLOUD_SIZE_LIMITS_MB.image * 1024 * 1024 + 1)).toBe(true);
    expect(exceedsCloudSizeLimit("document", 10 * 1024 * 1024)).toBe(false);
    expect(exceedsCloudSizeLimit("image", null)).toBe(false);
    expect(exceedsCloudSizeLimit("image", undefined)).toBe(false);
  });

  it("treats cloud_api and coexistence as Cloud accounts", () => {
    expect(cloudAccount("cloud_api")).toBe(true);
    expect(cloudAccount("coexistence")).toBe(true);
    expect(cloudAccount("evolution_qr")).toBe(false);
    expect(cloudAccount(null)).toBe(false);
    expect(cloudAccount(undefined)).toBe(false);
  });
});
