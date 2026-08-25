import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { GetConversationStateResponse, WhatsAppInboxApi, WhatsAppMessage } from "./ports";
import { WhatsAppInboxApiProvider } from "../ui/WhatsAppInboxApiProvider";
import { useWhatsAppMessageActions } from "./useWhatsAppMessageActions";
import { waConversationStateQueryKey, waHistoryQueryKey, waLatestQueryKey } from "./useWhatsAppMessages";

function message(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: "row-1",
    message: "hello",
    from: { name: "You", id: "1555" },
    to: [{ name: "", id: "1999" }],
    created_time: "2026-08-25T12:00:00.000Z",
    attachments: [],
    direction: "outbound",
    provider_message_id: "3EB0",
    pinned_at: null,
    hidden_at: null,
    ...overrides,
  };
}

function renderActions(api: WhatsAppInboxApi, queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return { ...renderHook(() => useWhatsAppMessageActions("acct", "conv"), { wrapper }), queryClient };
}

describe("useWhatsAppMessageActions", () => {
  it("hiding a pinned message also unpins it", async () => {
    const setMessageFlag = vi.fn(async (input: { message_row_id: string; pinned?: boolean; hidden?: boolean }) => ({
      flag: {
        message_row_id: input.message_row_id,
        pinned_at: input.pinned ? "t" : null,
        hidden_at: input.hidden ? "t" : null,
      },
    }));
    const api: WhatsAppInboxApi = {
      getMessagesPage: vi.fn(),
      getMedia: vi.fn(),
      sendMedia: vi.fn(),
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag,
      revokeMessage: vi.fn(),
    };
    const { result, queryClient } = renderActions(api);
    queryClient.setQueryData<GetConversationStateResponse>(waConversationStateQueryKey("acct", "conv"), {
      flags: [{ message_row_id: "row-1", pinned_at: "2026-08-25T12:00:00.000Z", hidden_at: null }],
      pinned: [{ message_row_id: "row-1", preview: "hello", timestamp: "2026-08-25T12:00:00.000Z" }],
      mutable: [],
    });

    act(() => result.current.hide(message({ pinned_at: "2026-08-25T12:00:00.000Z" })));

    await waitFor(() => expect(setMessageFlag).toHaveBeenCalled());
    expect(setMessageFlag).toHaveBeenCalledWith(expect.objectContaining({
      message_row_id: "row-1",
      hidden: true,
      pinned: false,
    }));
    const state = queryClient.getQueryData<GetConversationStateResponse>(
      waConversationStateQueryKey("acct", "conv"),
    );
    expect(state?.flags[0]?.pinned_at).toBeNull();
    expect(state?.flags[0]?.hidden_at).toBeTruthy();
    expect(state?.pinned).toEqual([]);
  });

  it("invalidates both latest and history caches after a successful revoke", async () => {
    const revokeMessage = vi.fn(async () => ({ success: true, revoked_at: "2026-08-25T13:00:00.000Z" }));
    const api: WhatsAppInboxApi = {
      getMessagesPage: vi.fn(),
      getMedia: vi.fn(),
      sendMedia: vi.fn(),
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag: vi.fn(),
      revokeMessage,
    };
    const { result, queryClient } = renderActions(api);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => result.current.revoke(message()));
    await waitFor(() => expect(revokeMessage).toHaveBeenCalled());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: waLatestQueryKey("acct", "conv") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: waHistoryQueryKey("acct", "conv") });
  });
});
