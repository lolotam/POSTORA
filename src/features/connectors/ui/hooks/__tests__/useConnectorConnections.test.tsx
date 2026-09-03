import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const fetchConnections = vi.fn();
const fetchWorkspaceUsage = vi.fn();
const initiateConnection = vi.fn();
const revokeConnection = vi.fn();
const fetchAccountWorkspaceId = vi.fn();
const fetchPersonalWorkspaceId = vi.fn();

vi.mock("../../../infrastructure/connectorsApi", () => ({
  fetchConnections: (...a: unknown[]) => fetchConnections(...a),
  fetchWorkspaceUsage: (...a: unknown[]) => fetchWorkspaceUsage(...a),
  initiateConnection: (...a: unknown[]) => initiateConnection(...a),
  revokeConnection: (...a: unknown[]) => revokeConnection(...a),
  refreshConnectionSchema: vi.fn(),
  fetchAccountWorkspaceId: (...a: unknown[]) => fetchAccountWorkspaceId(...a),
  fetchPersonalWorkspaceId: (...a: unknown[]) => fetchPersonalWorkspaceId(...a),
}));

const useAuth = vi.fn();
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => useAuth() }));

import { connectorKeys, useConnectorConnections, useInitiateConnection, useRevokeConnection } from "../useConnectorConnections";
import { useConnectorUsage } from "../useConnectorUsage";
import { useConnectorWorkspace } from "../useConnectorWorkspace";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("connector connection hooks", () => {
  beforeEach(() => {
    fetchConnections.mockReset().mockResolvedValue([{ id: "c1", status: "active" }]);
    fetchWorkspaceUsage.mockReset().mockResolvedValue([]);
    initiateConnection.mockReset().mockResolvedValue({ connection_id: "c1", redirect_url: "https://x", expires_at: "" });
    revokeConnection.mockReset().mockResolvedValue(undefined);
    fetchAccountWorkspaceId.mockReset();
    fetchPersonalWorkspaceId.mockReset();
    useAuth.mockReturnValue({ user: { id: "user-1" } });
  });

  it("does not read connections until a workspace is known", () => {
    const client = newClient();
    renderHook(() => useConnectorConnections(null), { wrapper: wrapper(client) });
    expect(fetchConnections).not.toHaveBeenCalled();
  });

  it("reads the workspace's connections", async () => {
    const client = newClient();
    const { result } = renderHook(() => useConnectorConnections("ws-1"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(fetchConnections).toHaveBeenCalledWith("ws-1");
  });

  it("reads usage for the requested window", async () => {
    const client = newClient();
    renderHook(() => useConnectorUsage("ws-1", 7), { wrapper: wrapper(client) });
    await waitFor(() => expect(fetchWorkspaceUsage).toHaveBeenCalledWith("ws-1", 7));
  });

  it("refreshes connections and usage after a connection is initiated", async () => {
    const client = newClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useInitiateConnection(), { wrapper: wrapper(client) });
    await result.current.mutateAsync({ connector_type: "slack", workspace_id: "ws-1" });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.connections() });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.usage() });
    });
  });

  it("refreshes connections and usage after a connection is revoked", async () => {
    const client = newClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRevokeConnection(), { wrapper: wrapper(client) });
    await result.current.mutateAsync("c1");
    expect(revokeConnection).toHaveBeenCalledWith("c1");
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.connections() });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: connectorKeys.usage() });
    });
  });
});

describe("useConnectorWorkspace", () => {
  beforeEach(() => {
    fetchAccountWorkspaceId.mockReset();
    fetchPersonalWorkspaceId.mockReset();
    useAuth.mockReturnValue({ user: { id: "user-1" } });
  });

  it("uses the selected account's workspace when the surface has an account", async () => {
    fetchAccountWorkspaceId.mockResolvedValue("ws-account");
    const client = newClient();
    const { result } = renderHook(() => useConnectorWorkspace("acct-1"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.workspaceId).toBe("ws-account"));
    expect(fetchPersonalWorkspaceId).not.toHaveBeenCalled();
  });

  it("falls back to the user's personal workspace when the surface has no account", async () => {
    fetchPersonalWorkspaceId.mockResolvedValue("ws-personal");
    const client = newClient();
    const { result } = renderHook(() => useConnectorWorkspace(null), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.workspaceId).toBe("ws-personal"));
    expect(fetchAccountWorkspaceId).not.toHaveBeenCalled();
  });

  it("reports an account that belongs to no workspace, rather than borrowing the personal one", async () => {
    fetchAccountWorkspaceId.mockResolvedValue(null);
    const client = newClient();
    const { result } = renderHook(() => useConnectorWorkspace("acct-1"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.workspaceId).toBeNull();
    expect(fetchPersonalWorkspaceId).not.toHaveBeenCalled();
  });

  it("stays idle when nobody is signed in", () => {
    useAuth.mockReturnValue({ user: null });
    const client = newClient();
    const { result } = renderHook(() => useConnectorWorkspace(null), { wrapper: wrapper(client) });
    expect(fetchPersonalWorkspaceId).not.toHaveBeenCalled();
    expect(result.current.workspaceId).toBeNull();
  });
});
