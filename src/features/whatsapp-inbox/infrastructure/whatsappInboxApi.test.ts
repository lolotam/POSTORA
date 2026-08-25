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

  it("omits pagination fields on a legacy latest-window call", async () => {
    callMessagingApi.mockResolvedValue({ messages: [] });
    const api = createWhatsAppInboxApi();
    await api.getMessagesPage({ social_account_id: "acct", conversation_id: "conv" });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_get_messages", {
      social_account_id: "acct",
      conversation_id: "conv",
    });
  });

  it("sends limit and before for a history page", async () => {
    callMessagingApi.mockResolvedValue({
      messages: [],
      page_info: { next_before: null, has_more: false },
    });
    const api = createWhatsAppInboxApi();
    const before = { timestamp: "2026-08-25T12:00:00.000Z", id: "row-1" };
    await api.getMessagesPage({
      social_account_id: "acct",
      conversation_id: "conv",
      limit: 40,
      before,
    });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_get_messages", {
      social_account_id: "acct",
      conversation_id: "conv",
      limit: 40,
      before,
    });
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
