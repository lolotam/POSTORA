import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { WHATSAPP_RANGE_LIMIT } from "../domain/whatsAppSchedule";
import { fetchWhatsAppScheduleBoard } from "./fetchWhatsAppScheduleBoard";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

function failingMessages() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => Promise.resolve({ data: null, error: { message: "statement timeout" } }),
  };
  return builder;
}

describe("fetchWhatsAppScheduleBoard", () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "whatsapp_scheduled_messages") return failingMessages() as never;
      throw new Error(`unexpected table ${table}`);
    });
  });

  it("rejects a failed read instead of looking like an empty list", async () => {
    await expect(fetchWhatsAppScheduleBoard("user-1", { kind: "active" })).rejects.toEqual({ message: "statement timeout" });
  });

  it("returns a full page without calling it truncated, and drops the extra probe row", async () => {
    const limits: number[] = [];
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "social_accounts") return accountLabels() as never;
      return rangeMessages(WHATSAPP_RANGE_LIMIT, limits) as never;
    });

    const exact = await fetchWhatsAppScheduleBoard("user-1", {
      kind: "range",
      rangeStart: "2026-09-01T00:00:00.000Z",
      rangeEnd: "2026-10-01T00:00:00.000Z",
    });
    expect(exact.truncated).toBe(false);
    expect(exact.messages).toHaveLength(WHATSAPP_RANGE_LIMIT);
    expect(limits).toEqual([WHATSAPP_RANGE_LIMIT + 1]);

    limits.length = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "social_accounts") return accountLabels() as never;
      return rangeMessages(WHATSAPP_RANGE_LIMIT + 1, limits) as never;
    });
    const over = await fetchWhatsAppScheduleBoard("user-1", {
      kind: "range",
      rangeStart: "2026-09-01T00:00:00.000Z",
      rangeEnd: "2026-10-01T00:00:00.000Z",
    });
    expect(over.truncated).toBe(true);
    expect(over.messages).toHaveLength(WHATSAPP_RANGE_LIMIT);
    expect(limits).toEqual([WHATSAPP_RANGE_LIMIT + 1]);
  });
});

function accountLabels() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => Promise.resolve({ data: [], error: null }),
  };
  return builder;
}

function rangeMessages(count: number, limits: number[]) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    social_account_id: "acc-1",
    recipient_phone: "100",
    recipient_name: null,
    message_text: "hi",
    media_url: null,
    media_type: null,
    scheduled_at: "2026-09-15T00:00:00.000Z",
    status: "pending",
  }));
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: (size: number) => {
      limits.push(size);
      return Promise.resolve({ data: rows.slice(0, size), error: null });
    },
  };
  return builder;
}
