import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  SCHEDULED_CHANGE_BLOCKED,
  SCHEDULED_RESCHEDULE_TOO_SOON,
  useWhatsAppScheduledMessages,
} from "@/hooks/useWhatsAppScheduledMessages";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { user: { id: "user-1" } } }) }));

const writes: { patch: Record<string, unknown>; eqs: [string, unknown][] }[] = [];
let rows: { id: string }[] = [];

function scheduledTable() {
  let writing = false;
  let pending: { patch: Record<string, unknown>; eqs: [string, unknown][] } | null = null;
  const builder = {
    select: () => (writing ? Promise.resolve({ data: rows, error: null }) : builder),
    eq: (column: string, value: unknown) => {
      pending?.eqs.push([column, value]);
      return builder;
    },
    order: () => Promise.resolve({ data: [], error: null }),
    update: (patch: Record<string, unknown>) => {
      writing = true;
      pending = { patch, eqs: [] };
      writes.push(pending);
      return builder;
    },
  };
  return builder;
}

function renderReschedule() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useWhatsAppScheduledMessages(), { wrapper }), invalidate };
}

describe("useWhatsAppScheduledMessages reschedule", () => {
  beforeEach(() => {
    writes.length = 0;
    rows = [];
    vi.mocked(supabase.from).mockImplementation(() => scheduledTable() as never);
  });

  it("updates only a pending row at least a minute ahead and refreshes both caches", async () => {
    rows = [{ id: "msg-1" }];
    const { result, invalidate } = renderReschedule();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const succeeded = vi.fn();
    await result.current.reschedule.mutateAsync(
      { id: "msg-1", scheduledAt: "2026-12-01T12:30:00.000Z" },
      { onSuccess: succeeded },
    );
    expect(writes).toEqual([{
      patch: { scheduled_at: "2026-12-01T12:30:00.000Z" },
      eqs: [["id", "msg-1"], ["status", "pending"]],
    }]);
    expect(succeeded).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-scheduled"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
  });

  it("shows the blocked error and no success when the pending row is gone", async () => {
    const { result, invalidate } = renderReschedule();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const succeeded = vi.fn();
    await expect(result.current.reschedule.mutateAsync(
      { id: "msg-1", scheduledAt: "2026-12-01T12:30:00.000Z" },
      { onSuccess: succeeded },
    )).rejects.toThrow(SCHEDULED_CHANGE_BLOCKED);
    expect(succeeded).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-scheduled"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
  });

  it("refuses a past time before writing", async () => {
    const { result, invalidate } = renderReschedule();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.reschedule.mutateAsync({
      id: "msg-1",
      scheduledAt: "2020-01-01T00:00:00.000Z",
    })).rejects.toThrow(SCHEDULED_RESCHEDULE_TOO_SOON);
    expect(writes).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
