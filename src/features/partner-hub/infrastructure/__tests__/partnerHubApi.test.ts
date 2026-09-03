import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import {
  createPartnerKey,
  fetchConnectorConnections,
  fetchConnectorOverview,
  fetchConnectorUsageByKey,
  fetchConnectorUsageByType,
  fetchKeyConnectorActivity,
  fetchKeys,
  fetchOverview,
  revokeConnection,
  revokePartnerKey,
} from "../partnerHubApi";

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

describe("partnerHubApi connector readers", () => {
  beforeEach(() => rpc.mockReset());

  it("fetchConnectorOverview unwraps the single admin row", async () => {
    rpc.mockResolvedValue({ data: [{ calls_30d: 42, failures_30d: 3 }], error: null });
    const row = await fetchConnectorOverview();
    expect(rpc).toHaveBeenCalledWith("admin_connector_overview");
    expect(row.calls_30d).toBe(42);
  });

  it("fetchConnectorOverview throws rather than inventing an empty overview", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(fetchConnectorOverview()).rejects.toThrow(/no row/i);
  });

  it("fetchConnectorUsageByType asks for the chosen window", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchConnectorUsageByType(90);
    expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_type", { p_days: 90 });
  });

  it("fetchConnectorUsageByKey asks for the chosen window", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchConnectorUsageByKey(7);
    expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_key", { p_days: 7 });
  });

  it("fetchConnectorUsageByType throws on a refused read instead of returning no rows", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "platform admin only" } });
    await expect(fetchConnectorUsageByType(30)).rejects.toMatchObject({ message: "platform admin only" });
  });

  it("fetchConnectorConnections asks for every workspace when none is named", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchConnectorConnections();
    expect(rpc).toHaveBeenCalledWith("admin_connector_connections", { p_workspace_id: null });
  });

  it("fetchConnectorConnections scopes to one workspace when named", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchConnectorConnections("ws-1");
    expect(rpc).toHaveBeenCalledWith("admin_connector_connections", { p_workspace_id: "ws-1" });
  });

  it("fetchKeyConnectorActivity passes the key and the row limit", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchKeyConnectorActivity("k1", 25);
    expect(rpc).toHaveBeenCalledWith("admin_partner_key_connector_activity", { p_key_id: "k1", p_limit: 25 });
  });

  it("revokeConnection revokes through the RPC under the admin's own JWT", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await revokeConnection("conn-1");
    expect(rpc).toHaveBeenCalledWith("revoke_connector_connection", { p_connection_id: "conn-1" });
  });

  it("revokeConnection reports a refused revocation", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "platform admin only" } });
    await expect(revokeConnection("conn-1")).rejects.toMatchObject({ message: "platform admin only" });
  });
});
