import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const from = vi.fn();
const update = vi.fn();
const eq = vi.fn();
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
    expect(from).not.toHaveBeenCalled();
  });

  it("falls back to deactivating the account when the deployed function predates the disconnect action", async () => {
    const oldFunctionReply = new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 });
    invoke.mockResolvedValue({ data: null, error: { message: "non-2xx", context: oldFunctionReply } });
    eq.mockImplementationOnce(() => ({ eq: () => Promise.resolve({ error: null }) }));
    update.mockReturnValue({ eq });
    from.mockReturnValue({ update });

    await createSupabaseConnectionGateway().disconnect("acc-1");

    expect(from).toHaveBeenCalledWith("social_accounts");
    expect(update).toHaveBeenCalledWith({ is_active: false });
    expect(eq).toHaveBeenCalledWith("id", "acc-1");
  });
});

describe("supabaseConnectionGateway.authorizeUrl", () => {
  beforeEach(() => invoke.mockReset());

  it("always asks TikTok to show its permission screen, even if the function's link lacks the flag", async () => {
    invoke.mockResolvedValue({
      data: { url: "https://www.tiktok.com/v2/auth/authorize/?client_key=abc&state=s%2B1" },
      error: null,
    });
    const url = new URL(await createSupabaseConnectionGateway().authorizeUrl());
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
    expect(url.searchParams.get("client_key")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("s+1");
  });

  it("does not duplicate the flag when the function already added it", async () => {
    invoke.mockResolvedValue({
      data: { url: "https://www.tiktok.com/v2/auth/authorize/?client_key=abc&disable_auto_auth=1" },
      error: null,
    });
    const url = new URL(await createSupabaseConnectionGateway().authorizeUrl());
    expect(url.searchParams.getAll("disable_auto_auth")).toEqual(["1"]);
  });
});
