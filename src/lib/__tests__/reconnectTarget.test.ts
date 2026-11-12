import { describe, expect, it } from "vitest";
import { WHATSAPP_QR_SETUP_PATH, reconnectTargetFor } from "@/lib/reconnectTarget";

describe("reconnectTargetFor", () => {
  it("routes a WhatsApp QR account to the WhatsApp setup page", () => {
    expect(
      reconnectTargetFor({ platform: "whatsapp", connection_mode: "evolution_qr" }),
    ).toEqual({ kind: "link", path: "/messaging/whatsapp/setup" });
    expect(WHATSAPP_QR_SETUP_PATH).toBe("/messaging/whatsapp/setup");
  });

  it("routes a Meta account through OAuth", () => {
    for (const platform of ["facebook", "instagram", "tiktok", "youtube", "linkedin"]) {
      expect(reconnectTargetFor({ platform, connection_mode: null })).toEqual({ kind: "oauth" });
    }
  });

  it("routes a WhatsApp account that is not a QR account through OAuth", () => {
    // The Meta WhatsApp modes do reconnect through OAuth; only the Evolution QR session
    // needs a new QR code.
    expect(reconnectTargetFor({ platform: "whatsapp", connection_mode: "cloud_api" })).toEqual({
      kind: "oauth",
    });
    expect(reconnectTargetFor({ platform: "whatsapp", connection_mode: null })).toEqual({
      kind: "oauth",
    });
  });
});
