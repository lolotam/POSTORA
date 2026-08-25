import { describe, expect, it } from "vitest";
import {
  isSyntheticProviderId,
  revokeCapability,
  revokeDisabledLabel,
  voiceNoteCapability,
  voiceNoteDisabledLabel,
} from "./whatsappCapabilities";

describe("whatsappCapabilities", () => {
  it("treats null and sched_ ids as synthetic", () => {
    expect(isSyntheticProviderId(null)).toBe(true);
    expect(isSyntheticProviderId("")).toBe(true);
    expect(isSyntheticProviderId("sched_1")).toBe(true);
    expect(isSyntheticProviderId("3EB0ABC")).toBe(false);
  });

  it("enables delete-for-everyone only on evolution_qr outbound real ids", () => {
    expect(revokeCapability("evolution_qr", "outbound", "3EB0ABC")).toEqual({
      enabled: true,
      reason: null,
    });
    expect(revokeCapability("cloud_api", "outbound", "3EB0ABC").reason).toBe("unsupported_mode");
    expect(revokeCapability("coexistence", "outbound", "3EB0ABC").reason).toBe("unsupported_mode");
    expect(revokeCapability("evolution_qr", "inbound", "3EB0ABC").reason).toBe("inbound");
    expect(revokeCapability("evolution_qr", "outbound", "sched_1").reason).toBe("synthetic_id");
    expect(revokeCapability("evolution_qr", "outbound", null).reason).toBe("synthetic_id");
  });

  it("states a reason for every disabled case", () => {
    expect(revokeDisabledLabel("unsupported_mode")).toMatch(/Direct QR/i);
    expect(revokeDisabledLabel("inbound")).toMatch(/your own/i);
    expect(revokeDisabledLabel("synthetic_id")).toMatch(/provider id/i);
    expect(revokeDisabledLabel(null)).toBeNull();
  });

  it("offers the mic only on evolution_qr when the browser can record", () => {
    expect(voiceNoteCapability("evolution_qr", true)).toEqual({ enabled: true, reason: null });
    expect(voiceNoteCapability("evolution_qr", false).reason).toBe("unsupported_browser");
    expect(voiceNoteCapability("cloud_api", true).reason).toBe("unsupported_mode");
    expect(voiceNoteCapability("coexistence", true).reason).toBe("unsupported_mode");
    expect(voiceNoteCapability(null, true).reason).toBe("unsupported_mode");
    expect(voiceNoteDisabledLabel("unsupported_mode")).toMatch(/Direct QR/i);
    expect(voiceNoteDisabledLabel("unsupported_browser")).toMatch(/browser/i);
    expect(voiceNoteDisabledLabel(null)).toBeNull();
  });
});
