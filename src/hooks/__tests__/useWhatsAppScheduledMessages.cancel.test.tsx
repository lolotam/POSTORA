import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { SCHEDULED_CANCEL_BLOCKED, useWhatsAppScheduledMessages } from "@/hooks/useWhatsAppScheduledMessages";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { user: { id: "user-1" } } }) }));

const writes: { patch: Record<string, unknown>; eqs: [string, unknown][] }[] = [];
let cancelRows: { id: string }[] = [];

function scheduledTable() {
  let writing = false;
  let pending: { patch: Record<string, unknown>; eqs: [string, unknown][] } | null = null;
  const builder = {
    select: () => (writing ? Promise.resolve({ data: cancelRows, error: null }) : builder),
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

function renderCancel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWhatsAppScheduledMessages(), { wrapper });
}

describe("useWhatsAppScheduledMessages cancel", () => {
  beforeEach(() => {
    writes.length = 0;
    cancelRows = [];
    vi.mocked(supabase.from).mockImplementation(() => scheduledTable() as never);
  });

  it("cancels only a pending row", async () => {
    cancelRows = [{ id: "msg-1" }];
    const { result } = renderCancel();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await result.current.cancel.mutateAsync("msg-1");
    expect(writes).toEqual([{ patch: { status: "cancelled" }, eqs: [["id", "msg-1"], ["status", "pending"]] }]);
  });

  it("rejects when the pending compare-and-set matches nothing", async () => {
    const { result } = renderCancel();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.cancel.mutateAsync("msg-1")).rejects.toThrow(SCHEDULED_CANCEL_BLOCKED);
    expect(writes[0]?.eqs).toEqual([["id", "msg-1"], ["status", "pending"]]);
  });
});
