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

  // The `reconnect` action re-subscribes the app to the WABA with the STORED access
  // token. It never refreshes that token and never clears needs_reauth, so sending a
  // FLAGGED account there leaves the owner in the same state forever: the banner
  // keeps asking for a reconnect that cannot happen. A flagged account needs a new
  // credential, which only Embedded Signup can issue.
  it("routes a flagged Meta WhatsApp account to a full credential renewal", () => {
    expect(
      reconnectTargetFor({
        platform: "whatsapp",
        connection_mode: "cloud_api",
        needs_reauth: true,
      }),
    ).toEqual({ kind: "whatsapp_meta_connect", mode: "cloud_api" });

    expect(
      reconnectTargetFor({
        platform: "whatsapp",
        connection_mode: "coexistence",
        needs_reauth: true,
      }),
    ).toEqual({ kind: "whatsapp_meta_connect", mode: "coexistence" });
  });

  it("renews a flagged Meta account in Cloud API mode when the row records no mode", () => {
    expect(
      reconnectTargetFor({ platform: "whatsapp", connection_mode: null, needs_reauth: true }),
    ).toEqual({ kind: "whatsapp_meta_connect", mode: "cloud_api" });
  });

  it("keeps the QR account on the setup page even when it is flagged", () => {
    expect(
      reconnectTargetFor({
        platform: "whatsapp",
        connection_mode: "evolution_qr",
        needs_reauth: true,
      }),
    ).toEqual({ kind: "link", path: WHATSAPP_QR_SETUP_PATH });
  });
});
