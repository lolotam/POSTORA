import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkConversationRead, type Conversation } from "@/hooks/useMessaging";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } } }),
      refreshSession: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

function conversation(id: string, unread: number): Conversation {
  return { id, unread_count: unread } as Conversation;
}

describe("useMarkConversationRead", () => {
  let client: QueryClient;
  let resolveRequest: (value: Response) => void;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      })),
    );
  });

  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the optimistic zero when an older list response arrives before mark-read settles", async () => {
    const listKey = ["messaging-conversations", "acct-1", "WHATSAPP", ""];
    client.setQueryData(listKey, [conversation("c-1", 3)]);
    let releaseList: (rows: Conversation[]) => void;
    const heldList = new Promise<Conversation[]>((resolve) => { releaseList = resolve; });
    const fetchList = vi.fn()
      .mockImplementationOnce(() => heldList)
      .mockResolvedValue([conversation("c-1", 0)]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => ({
      list: useQuery({ queryKey: listKey, queryFn: fetchList }),
      markRead: useMarkConversationRead(),
    }), { wrapper });
    await waitFor(() => expect(fetchList).toHaveBeenCalledTimes(1));

    act(() => result.current.markRead.mutate({ socialAccountId: "acct-1", conversationId: "c-1" }));
    await waitFor(() => expect(client.getQueryData<Conversation[]>(listKey)?.[0].unread_count).toBe(0));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      releaseList([conversation("c-1", 3)]);
      await heldList;
    });
    expect(result.current.markRead.isPending).toBe(true);
    expect(client.getQueryData<Conversation[]>(listKey)?.[0].unread_count).toBe(0);

    resolveRequest(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await waitFor(() => expect(result.current.markRead.isSuccess).toBe(true));
    await waitFor(() => expect(fetchList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.list.isFetching).toBe(false));
    expect(result.current.list.data?.[0].unread_count).toBe(0);
  });

  // The badge lives in the conversation list query, not in the thread that was opened. It has
  // to clear the moment a chat is selected, not one server round-trip later.
  it("clears the unread badge in the list cache before the server answers", async () => {
    const listKey = ["messaging-conversations", "acct-1", "WHATSAPP"];
    client.setQueryData(listKey, [conversation("c-1", 3), conversation("c-2", 1)]);
    const otherAccountKey = ["messaging-conversations", "acct-2", "WHATSAPP"];
    client.setQueryData(otherAccountKey, [conversation("c-1", 5)]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMarkConversationRead(), { wrapper });

    act(() => {
      result.current.mutate({ socialAccountId: "acct-1", conversationId: "c-1" });
    });

    await waitFor(() => {
      expect(client.getQueryData<Conversation[]>(listKey)?.map((c) => c.unread_count)).toEqual([0, 1]);
    });
    // Same conversation id under another account is a different chat; it is left alone.
    expect(client.getQueryData<Conversation[]>(otherAccountKey)?.[0].unread_count).toBe(5);

    resolveRequest(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
