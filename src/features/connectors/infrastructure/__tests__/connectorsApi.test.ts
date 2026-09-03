import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpc = vi.fn();
const from = vi.fn();
const getSession = vi.fn();
const refreshSession = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
    auth: {
      getSession: () => getSession(),
      refreshSession: () => refreshSession(),
    },
  },
}));

import {
  fetchConnections,
  fetchPersonalWorkspaceId,
  fetchWorkspaceUsage,
  fetchAccountWorkspaceId,
  initiateConnection,
  refreshConnectionSchema,
  revokeConnection,
} from "../connectorsApi";

/** A PostgREST builder that records its filters and resolves to one result. */
function builder(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown]> = [];
  const chain = {
    calls,
    select: (columns: string) => {
      calls.push(["select", columns]);
      return chain;
    },
    eq: (column: string, value: unknown) => {
      calls.push(["eq", `${column}=${String(value)}`]);
      return chain;
    },
    order: (column: string) => {
      calls.push(["order", column]);
      return Promise.resolve(result);
    },
    maybeSingle: () => Promise.resolve(result),
  };
  return chain;
}

describe("connectorsApi reads", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it("reads a workspace's connections through RLS, newest first", async () => {
    const chain = builder({ data: [{ id: "c1" }], error: null });
    from.mockReturnValue(chain);
    const rows = await fetchConnections("ws-1");
    expect(from).toHaveBeenCalledWith("connector_connections");
    expect(chain.calls).toContainEqual(["eq", "workspace_id=ws-1"]);
    expect(rows).toEqual([{ id: "c1" }]);
  });

  it("throws when the connections read fails instead of reporting no connections", async () => {
    from.mockReturnValue(builder({ data: null, error: { message: "permission denied" } }));
    await expect(fetchConnections("ws-1")).rejects.toMatchObject({ message: "permission denied" });
  });

  it("asks workspace_connector_usage for the requested window", async () => {
    rpc.mockResolvedValue({ data: [{ tool_id: "t1", calls: 3 }], error: null });
    const rows = await fetchWorkspaceUsage("ws-1", 7);
    expect(rpc).toHaveBeenCalledWith("workspace_connector_usage", { p_workspace_id: "ws-1", p_days: 7 });
    expect(rows).toHaveLength(1);
  });

  it("defaults the usage window to 30 days", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await fetchWorkspaceUsage("ws-1");
    expect(rpc).toHaveBeenCalledWith("workspace_connector_usage", { p_workspace_id: "ws-1", p_days: 30 });
  });

  it("throws when the usage RPC fails instead of reporting no usage", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "not a workspace member" } });
    await expect(fetchWorkspaceUsage("ws-1")).rejects.toMatchObject({ message: "not a workspace member" });
  });

  it("reports null when the account row carries no workspace", async () => {
    from.mockReturnValue(builder({ data: { workspace_id: null }, error: null }));
    await expect(fetchAccountWorkspaceId("acct-1")).resolves.toBeNull();
  });

  it("reads the account's workspace id", async () => {
    const chain = builder({ data: { workspace_id: "ws-9" }, error: null });
    from.mockReturnValue(chain);
    await expect(fetchAccountWorkspaceId("acct-1")).resolves.toBe("ws-9");
    expect(from).toHaveBeenCalledWith("social_accounts");
    expect(chain.calls).toContainEqual(["eq", "id=acct-1"]);
  });

  it("finds the owner's personal workspace", async () => {
    const chain = builder({ data: { id: "ws-personal" }, error: null });
    from.mockReturnValue(chain);
    await expect(fetchPersonalWorkspaceId("user-1")).resolves.toBe("ws-personal");
    expect(from).toHaveBeenCalledWith("workspaces");
    expect(chain.calls).toContainEqual(["eq", "owner_id=user-1"]);
    expect(chain.calls).toContainEqual(["eq", "is_personal=true"]);
  });
});

describe("connectorsApi edge calls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    getSession.mockResolvedValue({ data: { session: { access_token: "jwt-1" } } });
    refreshSession.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("posts the connector type and workspace to composio-connect/initiate with the session JWT", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ connection_id: "c1", redirect_url: "https://composio.example/auth", expires_at: "2026-09-03T10:00:00Z" }),
    });
    const result = await initiateConnection({ connector_type: "google_sheets", workspace_id: "ws-1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/functions\/v1\/composio-connect\/initiate$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({ connector_type: "google_sheets", workspace_id: "ws-1" });
    expect(result.redirect_url).toBe("https://composio.example/auth");
  });

  it("raises the edge function's error code rather than a bare status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", json: () => Promise.resolve({ error: "connector_unavailable" }) });
    await expect(initiateConnection({ connector_type: "slack", workspace_id: "ws-1" })).rejects.toThrow("connector_unavailable");
  });

  it("refuses to call the edge function without a session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    refreshSession.mockResolvedValue({ data: { session: null } });
    await expect(revokeConnection("c1")).rejects.toThrow(/not authenticated/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the connection id to /revoke", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await revokeConnection("c1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/composio-connect\/revoke$/);
    expect(JSON.parse(init.body as string)).toEqual({ connection_id: "c1" });
  });

  it("posts the connection id to /refresh-schema", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await refreshConnectionSchema("c1");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/composio-connect\/refresh-schema$/);
  });
});
