import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { createPartnerKey, fetchOverview, fetchKeys, revokePartnerKey } from "../partnerHubApi";

describe("partnerHubApi", () => {
  beforeEach(() => rpc.mockReset());

  it("fetchOverview unwraps the single row", async () => {
    rpc.mockResolvedValue({ data: [{ active_keys: 2 }], error: null });
    const row = await fetchOverview();
    expect(rpc).toHaveBeenCalledWith("admin_partner_hub_overview");
    expect(row.active_keys).toBe(2);
  });

  it("fetchKeys throws on a PostgREST error instead of returning an empty list", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "platform admin only" } });
    await expect(fetchKeys()).rejects.toMatchObject({ message: "platform admin only" });
  });

  it("createPartnerKey sends only the prefix and a 64-hex hash, never the plaintext", async () => {
    rpc.mockResolvedValue({ data: "key-id", error: null });
    const result = await createPartnerKey({
      name: "Danat", workspaceId: "ws", socialAccountId: "acct", environment: "staging",
      scopes: ["messages:send"], monthlyQuota: 100, rateLimitPerMin: 60,
    });
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("create_partner_key");
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_key_prefix).toBe(result.key.slice(0, 12));
    expect(args.p_environment).toBe("staging");
    expect(JSON.stringify(args)).not.toContain(result.key);
    expect(result.id).toBe("key-id");
  });

  it("revokePartnerKey reports a refused revocation as an error", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(revokePartnerKey("k", "leaked")).rejects.toThrow(/not revoked/i);
  });
});
