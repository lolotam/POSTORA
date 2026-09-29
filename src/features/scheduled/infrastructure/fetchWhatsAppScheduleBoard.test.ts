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

  it("keeps a message whose account was cleared and does not look that id up", async () => {
    let lookedUp: string[] | null = null;
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "social_accounts") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          in: (_column: string, ids: string[]) => {
            lookedUp = ids;
            return Promise.resolve({
              data: [{ id: "acc-1", platform_username: "Shop", avatar_url: null }],
              error: null,
            });
          },
        };
        return builder as never;
      }
      const rows = [
        {
          id: "cleared",
          social_account_id: null,
          recipient_phone: "100",
          recipient_name: null,
          message_text: "in flight",
          media_url: null,
          media_type: null,
          scheduled_at: "2026-09-15T00:00:00.000Z",
          status: "sending",
        },
        {
          id: "live",
          social_account_id: "acc-1",
          recipient_phone: "200",
          recipient_name: null,
          message_text: "waiting",
          media_url: null,
          media_type: null,
          scheduled_at: "2026-09-16T00:00:00.000Z",
          status: "pending",
        },
      ];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => Promise.resolve({ data: rows, error: null }),
      };
      return builder as never;
    });

    const board = await fetchWhatsAppScheduleBoard("user-1", { kind: "active" });
    expect(lookedUp).toEqual(["acc-1"]);
    expect(board.messages.map((message) => [message.id, message.account_name])).toEqual([
      ["cleared", null],
      ["live", "Shop"],
    ]);
  });

  it("rejects a failed read instead of looking like an empty list", async () => {
    await expect(fetchWhatsAppScheduleBoard("user-1", { kind: "active" })).rejects.toEqual({ message: "statement timeout" });
  });

  it("uses the exact count, so a full page is not truncated and more rows are", async () => {
    const range = { kind: "range" as const, rangeStart: "2026-09-01T00:00:00.000Z", rangeEnd: "2026-10-01T00:00:00.000Z" };
    const cases: Array<[string, number, number, boolean]> = [
      ["exactly the limit", WHATSAPP_RANGE_LIMIT, WHATSAPP_RANGE_LIMIT, false],
      ["one more than the limit", WHATSAPP_RANGE_LIMIT + 1, WHATSAPP_RANGE_LIMIT, true],
      // A PostgREST db-max-rows cap returns at most the limit, but Content-Range still reports the total.
      ["server row cap with a larger total", 1500, WHATSAPP_RANGE_LIMIT, true],
    ];
    for (const [label, total, served, truncated] of cases) {
      const limits: number[] = [];
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "social_accounts") return accountLabels() as never;
        return rangeMessages(total, served, limits) as never;
      });
      const board = await fetchWhatsAppScheduleBoard("user-1", range);
      expect(board.truncated, label).toBe(truncated);
      expect(board.messages, label).toHaveLength(Math.min(total, WHATSAPP_RANGE_LIMIT));
      expect(limits, label).toEqual([WHATSAPP_RANGE_LIMIT]);
    }
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

function rangeMessages(total: number, served: number, limits: number[]) {
  const rows = Array.from({ length: Math.min(total, served) }, (_, index) => ({
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
      return Promise.resolve({ data: rows.slice(0, size), error: null, count: total });
    },
  };
  return builder;
}
