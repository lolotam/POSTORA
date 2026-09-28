import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useScheduledPostCount } from "@/hooks/usePosts";
import { useWhatsAppScheduledMessages } from "@/hooks/useWhatsAppScheduledMessages";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: { user: { id: "user-1" } } }),
}));

const counts = new Map<string, { count: number | null; error: { message: string } | null }>();
const statusFilters: unknown[][] = [];

function countBuilder(table: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: (_column: string, values: unknown) => {
      statusFilters.push(values as unknown[]);
      return builder;
    },
    gt: () => builder,
    order: () => Promise.resolve({ data: [], error: null }),
    insert: () => builder,
    single: () => Promise.resolve({ data: { id: "sched-1" }, error: null }),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      const outcome = counts.get(table) ?? { count: 0, error: null };
      return Promise.resolve(outcome).then(resolve, reject);
    },
  };
  return builder;
}

function renderCount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => ({
    count: useScheduledPostCount(),
    messages: useWhatsAppScheduledMessages(),
  }), { wrapper }) };
}

describe("useScheduledPostCount", () => {
  beforeEach(() => {
    counts.clear();
    statusFilters.length = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => countBuilder(table) as never);
  });

  it("adds pending, claimed and sending WhatsApp rows to the future post count", async () => {
    counts.set("posts", { count: 2, error: null });
    counts.set("whatsapp_scheduled_messages", { count: 3, error: null });
    const { result } = renderCount();
    await waitFor(() => expect(result.current.count.data).toBe(5));
    expect(statusFilters).toContainEqual(["pending", "claimed", "sending"]);
  });

  it("throws when either count fails instead of returning a partial total", async () => {
    counts.set("posts", { count: 2, error: null });
    counts.set("whatsapp_scheduled_messages", { count: null, error: { message: "timeout" } });
    const { result } = renderCount();
    await waitFor(() => expect(result.current.count.isError).toBe(true));
    expect(result.current.count.data).toBeUndefined();
  });

  it("refetches after a WhatsApp schedule and after a post invalidation", async () => {
    counts.set("posts", { count: 1, error: null });
    counts.set("whatsapp_scheduled_messages", { count: 1, error: null });
    const { result, client } = renderCount();
    await waitFor(() => expect(result.current.count.data).toBe(2));
    const reads = vi.mocked(supabase.from).mock.calls.length;
    await result.current.messages.schedule.mutateAsync({
      socialAccountId: "acc-1",
      recipientPhone: "96550001111",
      messageText: "hello",
      scheduledAt: "2026-12-01T12:30:00.000Z",
    });
    await waitFor(() => expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(reads));
    const afterSchedule = vi.mocked(supabase.from).mock.calls.length;
    await client.invalidateQueries({ queryKey: ["posts"] });
    await waitFor(() => expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(afterSchedule));
  });
});
