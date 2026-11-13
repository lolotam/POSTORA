import { describe, expect, it } from "vitest";
import { WHATSAPP_QR_SETUP_PATH, reconnectTargetFor } from "@/lib/reconnectTarget";

describe("reconnectTargetFor", () => {
  it("routes a WhatsApp QR account to the WhatsApp setup page", () => {
    expect(
      reconnectTargetFor({ platform: "whatsapp", connection_mode: "evolution_qr" }),
    ).toEqual({ kind: "link", path: WHATSAPP_QR_SETUP_PATH });
  });

  it("routes a Meta account through OAuth", () => {
    for (const platform of ["facebook", "instagram", "tiktok", "youtube", "linkedin"]) {
      expect(reconnectTargetFor({ platform, connection_mode: null })).toEqual({ kind: "oauth" });
    }
  });

  it("routes a Meta WhatsApp account to the WhatsApp reconnect flow", () => {
    // The OAuth flow has no WhatsApp branch, so a Meta WhatsApp account must not be sent
    // there: the button would spin and reconnect nothing.
    for (const connection_mode of ["cloud_api", "coexistence", null]) {
      expect(reconnectTargetFor({ platform: "whatsapp", connection_mode })).toEqual({
        kind: "whatsapp_meta",
      });
    }
  });
});
