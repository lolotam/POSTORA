import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { MessageCursor } from "../domain/messageCursor";
import type {
  GetMessagesPageRequest,
  GetMessagesPageResponse,
  WhatsAppInboxApi,
  WhatsAppMessage,
} from "./ports";
import { WhatsAppInboxApiProvider } from "../ui/WhatsAppInboxApiProvider";
import { useWhatsAppMessages } from "./useWhatsAppMessages";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function waMessage(
  id: string,
  createdTime: string,
  extra: Partial<WhatsAppMessage> = {},
): WhatsAppMessage {
  return {
    id,
    message: extra.message ?? id,
    from: { name: "Ada", id: "1" },
    to: [{ name: "", id: "2" }],
    created_time: createdTime,
    attachments: [],
    conversation_id: extra.conversation_id ?? "conv",
    ...extra,
  };
}

function stamp(index: number): string {
  const minute = String(Math.floor(index / 60)).padStart(2, "0");
  const second = String(index % 60).padStart(2, "0");
  return `2026-08-25T12:${minute}:${second}.000Z`;
}

function newestFirst(messages: WhatsAppMessage[]): WhatsAppMessage[] {
  return [...messages].sort((left, right) => {
    const byTime = new Date(right.created_time).getTime() - new Date(left.created_time).getTime();
    if (byTime !== 0) return byTime;
    return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
  });
}

function keysetBefore(messages: WhatsAppMessage[], before: MessageCursor): WhatsAppMessage[] {
  const beforeTime = new Date(before.timestamp).getTime();
  return messages.filter((message) => {
    const time = new Date(message.created_time).getTime();
    if (time < beforeTime) return true;
    if (time > beforeTime) return false;
    return message.id < before.id;
  });
}

class FakeMessageServer {
  private readonly byConversation = new Map<string, WhatsAppMessage[]>();
  private readonly delayed = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  nextIndex = 0;

  seed(count: number, conversationId = "conv"): WhatsAppMessage[] {
    const rows = Array.from({ length: count }, () => this.pushNewest({ conversation_id: conversationId }));
    return rows;
  }

  pushNewest(extra: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
    const conversationId = extra.conversation_id ?? "conv";
    const index = this.nextIndex;
    this.nextIndex += 1;
    const row = waMessage(`m${String(index).padStart(3, "0")}`, stamp(index), extra);
    const list = this.byConversation.get(conversationId) ?? [];
    list.push(row);
    this.byConversation.set(conversationId, list);
    return row;
  }

  delayNext(conversationId: string): void {
    let resolve = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.delayed.set(conversationId, { promise, resolve });
  }

  flush(conversationId: string): void {
    const pending = this.delayed.get(conversationId);
    this.delayed.delete(conversationId);
    pending?.resolve();
  }

  api(): WhatsAppInboxApi {
    return {
      getMessagesPage: (input) => this.getMessagesPage(input),
      getMedia: async () => ({ media: [] }),
      sendMedia: async () => ({}),
      sendInteractive: async () => ({}),
      getConversationState: async () => ({ flags: [], pinned: [], mutable: [] }),
      setMessageFlag: async ({ message_row_id }) => ({
        flag: { message_row_id, pinned_at: null, hidden_at: null },
      }),
      revokeMessage: async () => ({ success: true, revoked_at: "2026-08-25T12:00:00.000Z" }),
      sendVoice: async () => ({ success: true, message_id: "3EB0" }),
    };
  }

  private async getMessagesPage(input: GetMessagesPageRequest): Promise<GetMessagesPageResponse> {
    const pending = this.delayed.get(input.conversation_id);
    if (pending) await pending.promise;
    const pool = newestFirst(this.byConversation.get(input.conversation_id) ?? []);
    const paginated = input.limit != null || input.before != null;
    if (!paginated) {
      return { messages: pool.slice(0, 100) };
    }
    const limited = input.before ? keysetBefore(pool, input.before) : pool;
    const limit = input.limit ?? 40;
    const hasMore = limited.length > limit;
    const page = limited.slice(0, limit);
    const oldest = page[page.length - 1];
    return {
      messages: page,
      page_info: {
        has_more: hasMore,
        next_before: hasMore && oldest
          ? { timestamp: oldest.created_time, id: oldest.id }
          : null,
      },
    };
  }
}

function renderMessages(
  api: WhatsAppInboxApi,
  socialAccountId: string,
  conversationId: string | null,
  queryClient = createQueryClient(),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return renderHook(
    ({ account, conversation }: { account: string; conversation: string | null }) =>
      useWhatsAppMessages(account, conversation),
    { wrapper, initialProps: { account: socialAccountId, conversation: conversationId } },
  );
}

describe("useWhatsAppMessages", () => {
  // The bug this whole design exists to prevent: after several history pages, a bounded
  // infinite-query cache evicts the newest page and new messages stop arriving forever.
  it("still shows a new message after four history pages are loaded", async () => {
    const server = new FakeMessageServer();
    server.seed(280);
    const queryClient = createQueryClient();
    const { result } = renderMessages(server.api(), "acct", "conv", queryClient);

    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    for (let i = 0; i < 4; i += 1) {
      const loaded = result.current.messages.length;
      act(() => result.current.fetchOlder());
      await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(loaded));
    }

    const newest = server.pushNewest();
    await queryClient.invalidateQueries({ queryKey: ["wa-latest", "acct", "conv"] });
    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe(newest.id));
    expect(result.current.hasOlder).toBe(true);
  });

  // The second, subtler loss: the latest window MOVES. Rows that fall out of it must survive
  // in the store, or ten new arrivals silently delete the ten oldest visible messages.
  it("keeps messages that roll out of the moving latest window", async () => {
    const server = new FakeMessageServer();
    server.seed(100);
    const queryClient = createQueryClient();
    const { result } = renderMessages(server.api(), "acct", "conv", queryClient);

    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    const rolledOut = result.current.messages[0].id;
    for (let i = 0; i < 10; i += 1) server.pushNewest();
    await queryClient.invalidateQueries({ queryKey: ["wa-latest", "acct", "conv"] });

    await waitFor(() => expect(result.current.messages).toHaveLength(110));
    expect(result.current.messages.map((message) => message.id)).toContain(rolledOut);
  });

  it("resolves a duplicate id to the freshest representation", async () => {
    const latest = [
      waMessage("x", stamp(100), { revoked_at: "2026-08-25T10:00:00Z" }),
      ...Array.from({ length: 99 }, (_, index) => waMessage(`n${index}`, stamp(index + 1))),
    ];
    const api: WhatsAppInboxApi = {
      getMessagesPage: async (input) => {
        if (input.limit != null || input.before != null) {
          return {
            messages: [
              waMessage("x", stamp(100), { revoked_at: null }),
              waMessage("older", stamp(0)),
            ],
            page_info: { next_before: null, has_more: false },
          };
        }
        return { messages: latest };
      },
      getMedia: async () => ({ media: [] }),
      sendMedia: async () => ({}),
      sendInteractive: async () => ({}),
      getConversationState: async () => ({
        flags: [],
        pinned: [],
        mutable: [waMessage("x", stamp(100), { revoked_at: "2026-08-25T10:00:00Z" })].map((row) => ({
          message_row_id: row.id,
          revoked_at: row.revoked_at ?? null,
          revoked_by: row.revoked_by ?? null,
          status: row.status ?? null,
          media_understanding: row.media_understanding ?? null,
        })),
      }),
      setMessageFlag: async ({ message_row_id }) => ({
        flag: { message_row_id, pinned_at: null, hidden_at: null },
      }),
      revokeMessage: async () => ({ success: true }),
      sendVoice: async () => ({ success: true, message_id: "3EB0" }),
    };
    const { result } = renderMessages(api, "acct", "conv");
    await waitFor(() => expect(result.current.messages.find((row) => row.id === "x")?.revoked_at).toBeTruthy());
    act(() => result.current.fetchOlder());
    await waitFor(() => expect(result.current.messages.some((row) => row.id === "older")).toBe(true));
    expect(result.current.messages.find((row) => row.id === "x")?.revoked_at).toBeTruthy();
  });

  it("does not dead-end the older path when the first history page overlaps the latest window", async () => {
    const server = new FakeMessageServer();
    server.seed(140);
    const { result } = renderMessages(server.api(), "acct", "conv");

    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    act(() => result.current.fetchOlder());
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(100));
  });

  it("discards a late response from a conversation the user already left", async () => {
    const server = new FakeMessageServer();
    server.seed(3, "conv-a");
    server.seed(3, "conv-b");
    server.delayNext("conv-a");
    const { result, rerender } = renderMessages(server.api(), "acct", "conv-a");

    rerender({ account: "acct", conversation: "conv-b" });
    server.flush("conv-a");

    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
    expect(result.current.messages.every((message) => message.conversation_id === "conv-b")).toBe(true);
  });

  it("does not corrupt the store when a poll lands mid-fetchOlder", async () => {
    const server = new FakeMessageServer();
    server.seed(140);
    const queryClient = createQueryClient();
    const { result } = renderMessages(server.api(), "acct", "conv", queryClient);
    await waitFor(() => expect(result.current.messages).toHaveLength(100));

    server.delayNext("conv");
    act(() => result.current.fetchOlder());
    const newest = server.pushNewest();
    const latestRefetch = queryClient.invalidateQueries({ queryKey: ["wa-latest", "acct", "conv"] });
    server.flush("conv");
    await latestRefetch;

    await waitFor(() => expect(result.current.messages.map((row) => row.id)).toContain(newest.id));
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(100));
    const ids = result.current.messages.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lets the conversation-state overlay win for the fields it carries", async () => {
    const api: WhatsAppInboxApi = {
      getMessagesPage: async () => ({
        messages: [waMessage("x", stamp(1), { status: "sent", revoked_at: null, message: "hello" })],
      }),
      getMedia: async () => ({ media: [] }),
      sendMedia: async () => ({}),
      sendInteractive: async () => ({}),
      getConversationState: async () => ({
        flags: [{ message_row_id: "x", pinned_at: "2026-08-25T12:01:00.000Z", hidden_at: null }],
        pinned: [{ message_row_id: "x", preview: "hello", timestamp: stamp(1) }],
        mutable: [{
          message_row_id: "x",
          revoked_at: "2026-08-25T13:00:00.000Z",
          revoked_by: "teammate",
          status: "delivered",
          media_understanding: "a cat",
        }],
      }),
      setMessageFlag: async ({ message_row_id }) => ({
        flag: { message_row_id, pinned_at: null, hidden_at: null },
      }),
      revokeMessage: async () => ({ success: true }),
      sendVoice: async () => ({ success: true, message_id: "3EB0" }),
    };
    const { result } = renderMessages(api, "acct", "conv");
    await waitFor(() => expect(result.current.messages[0]?.revoked_at).toBe("2026-08-25T13:00:00.000Z"));
    expect(result.current.messages[0]?.message).toBe("hello");
    expect(result.current.messages[0]?.status).toBe("delivered");
    expect(result.current.messages[0]?.media_understanding).toBe("a cat");
    expect(result.current.messages[0]?.pinned_at).toBe("2026-08-25T12:01:00.000Z");
    expect(result.current.pinned).toHaveLength(1);
  });
});
