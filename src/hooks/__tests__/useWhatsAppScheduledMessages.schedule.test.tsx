import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { SCHEDULED_OWN_ACCOUNT_ONLY, useWhatsAppScheduledMessages } from "@/hooks/useWhatsAppScheduledMessages";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { user: { id: "user-1" } } }) }));

const inserts: Record<string, unknown>[] = [];
const selectArgs: string[] = [];
let singled = false;
let insertError: { code?: string; message: string } | null = null;

function table() {
  let inserting = false;
  const api = {
    select: (columns?: string) => {
      if (inserting) selectArgs.push(columns ?? "");
      return api;
    },
    eq: () => api,
    order: () => Promise.resolve({ data: [], error: null }),
    insert: (row: Record<string, unknown>) => {
      inserting = true;
      inserts.push(row);
      return api;
    },
    single: () => {
      singled = true;
      return Promise.resolve(insertError ? { data: null, error: insertError } : { data: { id: "sched-1" }, error: null });
    },
  };
  return api;
}

function renderSchedule() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWhatsAppScheduledMessages(), { wrapper });
}

describe("useWhatsAppScheduledMessages schedule", () => {
  beforeEach(() => {
    inserts.length = 0;
    selectArgs.length = 0;
    singled = false;
    insertError = null;
    vi.mocked(supabase.from).mockImplementation(() => table() as never);
  });

  it("inserts digits-only pending rows and reads the new id back", async () => {
    const { result } = renderSchedule();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await result.current.schedule.mutateAsync({
      socialAccountId: "acc-1",
      recipientPhone: "+965 5000 1111",
      recipientName: "Noura",
      messageText: "hello",
      scheduledAt: "2026-12-01T12:30:00.000Z",
    });
    expect(inserts).toEqual([{
      user_id: "user-1",
      social_account_id: "acc-1",
      recipient_phone: "96550001111",
      recipient_name: "Noura",
      message_text: "hello",
      media_url: null,
      media_type: null,
      scheduled_at: "2026-12-01T12:30:00.000Z",
      status: "pending",
    }]);
    expect(selectArgs).toEqual(["id"]);
    expect(singled).toBe(true);
    expect(inserts[0]).not.toHaveProperty("claimed_at");
    expect(inserts[0]).not.toHaveProperty("claim_token");
    expect(inserts[0]).not.toHaveProperty("attempts");
    expect(inserts[0]).not.toHaveProperty("sent_at");
  });

  it("maps a 42501 error to the own-account message and surfaces other failures", async () => {
    const { result } = renderSchedule();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    insertError = { code: "42501", message: "new row violates row-level security policy" };
    await expect(result.current.schedule.mutateAsync({
      socialAccountId: "acc-other",
      recipientPhone: "96550001111",
      messageText: "hello",
      scheduledAt: "2026-12-01T12:30:00.000Z",
    })).rejects.toThrow(SCHEDULED_OWN_ACCOUNT_ONLY);

    insertError = { message: "database down" };
    await expect(result.current.schedule.mutateAsync({
      socialAccountId: "acc-1",
      recipientPhone: "96550001111",
      messageText: "hello",
      scheduledAt: "2026-12-01T12:30:00.000Z",
    })).rejects.toThrow("database down");
  });
});
