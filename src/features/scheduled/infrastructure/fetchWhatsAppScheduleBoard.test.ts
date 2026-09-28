import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
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
});
