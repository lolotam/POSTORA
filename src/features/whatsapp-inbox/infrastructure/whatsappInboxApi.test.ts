import { beforeEach, describe, expect, it, vi } from "vitest";

const callMessagingApi = vi.fn();

vi.mock("./messagingApiClient", () => ({
  callMessagingApi: (...args: unknown[]) => callMessagingApi(...args),
}));

import { createWhatsAppInboxApi } from "./whatsappInboxApi";

describe("createWhatsAppInboxApi", () => {
  beforeEach(() => {
    callMessagingApi.mockReset();
    callMessagingApi.mockResolvedValue({ media: [] });
  });

  it("sends whatsapp_get_media through the shared retrying caller", async () => {
    const api = createWhatsAppInboxApi();
    await api.getMedia({ social_account_id: "acct", message_row_ids: ["row-1", "row-2"] });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_get_media", {
      social_account_id: "acct",
      message_row_ids: ["row-1", "row-2"],
    });
  });

  it("sends media_path on whatsapp_send_media", async () => {
    const api = createWhatsAppInboxApi();
    await api.sendMedia({
      social_account_id: "acct",
      recipient_phone: "96550000000",
      media_path: "user/whatsapp/outbound/file.jpg",
      media_type: "image",
      caption: "hi",
    });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_send_media", {
      social_account_id: "acct",
      recipient_phone: "96550000000",
      media_path: "user/whatsapp/outbound/file.jpg",
      media_type: "image",
      caption: "hi",
    });
  });

  it("sends interactive payloads through the same caller", async () => {
    const api = createWhatsAppInboxApi();
    await api.sendInteractive({
      social_account_id: "acct",
      recipient_phone: "96550000000",
      interactive: { type: "button" },
    });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_send_interactive", {
      social_account_id: "acct",
      recipient_phone: "96550000000",
      interactive: { type: "button" },
    });
  });
});
