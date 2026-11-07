import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppBroadcasts, type WhatsAppBroadcast } from "./useWhatsAppBroadcasts";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  getUser: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  fetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  topics: [] as string[],
  handlers: [] as Array<(payload: unknown) => void>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    channel: mocks.channel,
    removeChannel: mocks.removeChannel,
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

function broadcast(overrides: Partial<WhatsAppBroadcast> = {}): WhatsAppBroadcast {
  const now = new Date().toISOString();
  return {
    id: "b1",
    user_id: "u1",
    name: "Promo",
    template_name: "hello",
    template_components: null,
    status: "pending",
    recipient_count: 3,
    sent_count: 0,
    delivered_count: 0,
    failed_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function mockList(getRows: () => WhatsAppBroadcast[]) {
  const order = vi.fn().mockImplementation(async () => ({ data: getRows(), error: null }));
  const select = vi.fn().mockReturnValue({ order });
  mocks.from.mockReturnValue({ select });
}

function mockDeferredList() {
  let release: (rows: WhatsAppBroadcast[]) => void = () => {};
  const order = vi.fn().mockImplementation(
    () => new Promise((resolve) => {
      release = (rows) => resolve({ data: rows, error: null });
    }),
  );
  const select = vi.fn().mockReturnValue({ order });
  mocks.from.mockReturnValue({ select });
  return {
    release: (rows: WhatsAppBroadcast[]) => act(() => release(rows)),
  };
}

function installChannel() {
  mocks.channel.mockImplementation((topic: string) => {
    mocks.topics.push(topic);
    const channel = {
      on: vi.fn((_type: string, _filter: unknown, handler: (payload: unknown) => void) => {
        mocks.handlers.push(handler);
        return channel;
      }),
      subscribe: vi.fn(() => channel),
    };
    return channel;
  });
}

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("useWhatsAppBroadcasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.topics.length = 0;
    mocks.handlers.length = 0;
    installChannel();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "token" } } });
    mocks.refreshSession.mockResolvedValue({ data: { session: { access_token: "token" } } });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a 202 send toasts submitted, not complete", async () => {
    mockList(() => []);
    mocks.fetch.mockResolvedValue(
      jsonResponse(202, { accepted: true, jobId: "job-1", broadcast_id: "b1", status: "sending" }),
    );
    const { wrapper } = createHarness();

    const { result } = renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await act(async () => {
      await result.current.sendBroadcast.mutateAsync("b1");
    });

    expect(mocks.toastSuccess).toHaveBeenCalledWith("Broadcast submitted — sending in the background");
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining("Broadcast complete"));
  });

  it("a 409 send toasts the server error", async () => {
    mockList(() => []);
    mocks.fetch.mockResolvedValue(jsonResponse(409, { error: "Broadcast already started" }));
    const { wrapper } = createHarness();

    const { result } = renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await act(async () => {
      await result.current.sendBroadcast.mutateAsync("b1").catch(() => undefined);
    });

    expect(mocks.toastError).toHaveBeenCalledWith("Broadcast failed: Broadcast already started");
  });

  it("polls while a broadcast is sending and stops when none is", async () => {
    vi.useFakeTimers();
    let rows = [broadcast({ status: "sending" })];
    mockList(() => rows);
    const { queryClient, wrapper } = createHarness();

    renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterFirst = mocks.from.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mocks.from.mock.calls.length).toBeGreaterThan(afterFirst);

    rows = [broadcast({ status: "completed" })];
    act(() => {
      queryClient.setQueryData(["whatsapp-broadcasts"], rows);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    const afterStop = mocks.from.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(mocks.from.mock.calls.length).toBe(afterStop);
  });

  it("a tracked broadcast that turns completed toasts its counts once", async () => {
    const rows = [broadcast({ status: "sending" })];
    mockList(() => rows);
    const { queryClient, wrapper } = createHarness();

    const { result } = renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await waitFor(() => expect(result.current.broadcasts.length).toBe(1));

    act(() => {
      queryClient.setQueryData(
        ["whatsapp-broadcasts"],
        [broadcast({ status: "completed", sent_count: 2, failed_count: 1 })],
      );
    });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Broadcast complete: 2 sent, 1 failed")
    );

    await act(async () => {
      queryClient.setQueryData(
        ["whatsapp-broadcasts"],
        [broadcast({ status: "completed", sent_count: 3, failed_count: 1 })],
      );
    });
    await waitFor(() => expect(result.current.broadcasts[0]?.sent_count).toBe(3));
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("a broadcast that finishes before the first refetch still toasts its result", async () => {
    const list = mockDeferredList();
    mocks.fetch.mockResolvedValue(
      jsonResponse(202, { accepted: true, jobId: "job-1", broadcast_id: "b1", status: "sending" }),
    );
    const { wrapper } = createHarness();

    const { result } = renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await act(async () => {
      await result.current.sendBroadcast.mutateAsync("b1");
    });

    list.release([broadcast({ status: "completed", sent_count: 3, failed_count: 0 })]);

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Broadcast complete: 3 sent, 0 failed")
    );
    const finals = mocks.toastSuccess.mock.calls.filter(([message]) =>
      String(message).startsWith("Broadcast complete")
    );
    expect(finals).toHaveLength(1);
  });

  it("a realtime update on the user's broadcasts refetches the list and the recipients", async () => {
    mockList(() => []);
    const { queryClient, wrapper } = createHarness();

    renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await waitFor(() => expect(mocks.channel).toHaveBeenCalled());

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => {
      mocks.handlers.forEach((handler) => handler({ new: { id: "b1" } }));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-broadcast-recipients", "b1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-broadcasts"] });
  });

  it("two hook instances subscribe on distinct topics", async () => {
    mockList(() => []);
    const { wrapper } = createHarness();

    renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    renderHook(() => useWhatsAppBroadcasts(), { wrapper });

    await waitFor(() => expect(mocks.topics.length).toBe(2));
    expect(new Set(mocks.topics).size).toBe(2);
  });

  it("an open broadcast's recipient list refreshes while it sends and once at the end", async () => {
    const rows = [broadcast({ status: "sending" })];
    mockList(() => rows);
    const { queryClient, wrapper } = createHarness();

    const { result } = renderHook(() => useWhatsAppBroadcasts(), { wrapper });
    await waitFor(() => expect(result.current.broadcasts.length).toBe(1));

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    invalidate.mockClear();

    await act(async () => {
      queryClient.setQueryData(
        ["whatsapp-broadcasts"],
        [broadcast({ status: "sending", sent_count: 1 })],
      );
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-broadcast-recipients", "b1"] })
    );

    invalidate.mockClear();
    await act(async () => {
      queryClient.setQueryData(
        ["whatsapp-broadcasts"],
        [broadcast({ status: "completed", sent_count: 3 })],
      );
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-broadcast-recipients", "b1"] })
    );
  });
});
