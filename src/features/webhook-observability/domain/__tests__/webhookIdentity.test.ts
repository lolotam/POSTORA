import { describe, expect, it } from "vitest";
import { isMessagingPlatform, resolveWebhookIdentity } from "../webhookIdentity";

describe("resolveWebhookIdentity", () => {
  it("prefers ig_igid for a direct-login Instagram account", () => {
    // The exact shape from the 2026-08-24 incident: platform_user_id is the app-scoped id
    // Meta never puts in entry.id, while ig_igid is the one it actually addresses.
    // Showing the former would print a real id that no webhook ever carries.
    const identity = resolveWebhookIdentity({
      platform: "instagram",
      platform_user_id: "28328915980060259",
      account_metadata: {
        ig_igid: "17841414837379313",
        ig_user_id: "28328915980060259",
      },
    });

    expect(identity).toBe("17841414837379313");
  });

  it("falls back to platform_user_id when no IGID was stored", () => {
    const identity = resolveWebhookIdentity({
      platform: "instagram",
      platform_user_id: "17841471165234191",
      account_metadata: {},
    });

    expect(identity).toBe("17841471165234191");
  });

  it("falls back to ig_user_id for rows predating ig_igid", () => {
    const identity = resolveWebhookIdentity({
      platform: "instagram",
      platform_user_id: null,
      account_metadata: { ig_user_id: "17841473625070640" },
    });

    expect(identity).toBe("17841473625070640");
  });

  it("uses platform_user_id for Facebook pages and ignores Instagram metadata keys", () => {
    const identity = resolveWebhookIdentity({
      platform: "facebook",
      platform_user_id: "1214265425109740",
      // A Facebook row should never be resolved through an Instagram key even if one is
      // somehow present, since the webhook resolver only consults them for instagram.
      account_metadata: { ig_igid: "17841414837379313" },
    });

    expect(identity).toBe("1214265425109740");
  });

  it("returns null when the account carries no usable identifier", () => {
    expect(
      resolveWebhookIdentity({ platform: "instagram", platform_user_id: null, account_metadata: null }),
    ).toBeNull();
    expect(
      resolveWebhookIdentity({ platform: "pinterest", platform_user_id: null }),
    ).toBeNull();
  });

  it("ignores non-string and empty metadata values", () => {
    const identity = resolveWebhookIdentity({
      platform: "instagram",
      platform_user_id: "fallback-id",
      account_metadata: { ig_igid: "", ig_user_id: 12345 },
    });

    expect(identity).toBe("fallback-id");
  });
});

describe("isMessagingPlatform", () => {
  it("covers the platforms that deliver inbound events", () => {
    expect(isMessagingPlatform("instagram")).toBe(true);
    expect(isMessagingPlatform("facebook")).toBe(true);
    expect(isMessagingPlatform("whatsapp")).toBe(true);
    expect(isMessagingPlatform("threads")).toBe(true);
  });

  it("excludes publish-only platforms, which have no inbound events to miss", () => {
    expect(isMessagingPlatform("pinterest")).toBe(false);
    expect(isMessagingPlatform("youtube")).toBe(false);
    expect(isMessagingPlatform("tiktok")).toBe(false);
  });
});
