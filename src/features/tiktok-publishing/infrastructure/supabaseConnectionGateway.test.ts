import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) }, from: (...args: unknown[]) => from(...args) },
}));

import { createSupabaseConnectionGateway } from "./supabaseConnectionGateway";

describe("supabaseConnectionGateway.disconnect", () => {
  beforeEach(() => {
    invoke.mockReset();
    from.mockReset();
  });

  it("asks the backend to disconnect, which also revokes Postora in TikTok, instead of only flagging the row", async () => {
    invoke.mockResolvedValue({ data: { success: true, revoked: true }, error: null });
    await createSupabaseConnectionGateway().disconnect("acc-1");
    expect(invoke).toHaveBeenCalledWith("tiktok-oauth", {
      body: { action: "disconnect", social_account_id: "acc-1" },
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("surfaces a backend failure so the account is not shown as disconnected", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Account not found" } });
    await expect(createSupabaseConnectionGateway().disconnect("acc-1")).rejects.toThrow("Account not found");
  });
});
