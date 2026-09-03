import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: "jwt-1" } } }),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}));

import { ComposioConnectCard } from "../ComposioConnectCard";

type Connection = Record<string, unknown>;

function connectionsChain(rows: Connection[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain;
}

const BASE: Connection = {
  id: "conn-1",
  workspace_id: "ws-1",
  connector_type: "google_sheets",
  toolkit: "googlesheets",
  status: "active",
  external_account_label: "ops@postora.cloud",
  failure_code: null,
  created_at: "2026-09-01T00:00:00Z",
};

const fetchMock = vi.fn();
const assign = vi.fn();

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ComposioConnectCard", () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: [], error: null });
    from.mockReset().mockReturnValue(connectionsChain([]));
    fetchMock.mockReset();
    assign.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers Connect for an app that has never been connected", async () => {
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByText("Google Sheets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeEnabled();
  });

  it("sends the browser to the authorisation page the edge function returns", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ connection_id: "conn-9", redirect_url: "https://composio.example/oauth", expires_at: "" }),
    });
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://composio.example/oauth"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/composio-connect\/initiate$/);
    expect(JSON.parse(init.body as string)).toEqual({ connector_type: "google_sheets", workspace_id: "ws-1" });
  });

  it("cannot be connected while the surface has no workspace", async () => {
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId={null} />);
    expect(await screen.findByText(/no workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeDisabled();
  });

  it("waits visibly while an authorisation is outstanding", async () => {
    from.mockReturnValue(connectionsChain([{ ...BASE, status: "initiated", external_account_label: null }]));
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByText(/waiting for authorisation/i)).toBeInTheDocument();
  });

  it("shows the external account, a Connected badge and the usage line once active", async () => {
    from.mockReturnValue(connectionsChain([BASE]));
    rpc.mockResolvedValue({
      data: [{ tool_id: "t1", connector_type: "google_sheets", calls: 142, failures: 0, refused: 0, p50_latency_ms: 640, last_used_at: "2026-09-02T00:00:00Z" }],
      error: null,
    });
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByText("ops@postora.cloud")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(await screen.findByText("142 calls · 30 d · p50 640 ms")).toBeInTheDocument();
  });

  it("revokes only after the disconnect is confirmed", async () => {
    from.mockReturnValue(connectionsChain([BASE]));
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^disconnect google sheets$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/composio-connect\/revoke$/);
    expect(JSON.parse(init.body as string)).toEqual({ connection_id: "conn-1" });
  });

  it("names the failure and offers a reconnect after a failed authorisation", async () => {
    from.mockReturnValue(connectionsChain([{ ...BASE, status: "failed", failure_code: "expired", external_account_label: null }]));
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByText(/expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
  });

  it("offers a reconnect after the connection was revoked", async () => {
    from.mockReturnValue(connectionsChain([{ ...BASE, status: "revoked", external_account_label: null }]));
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByRole("button", { name: /reconnect/i })).toBeInTheDocument();
  });

  it("offers the agent tool form only where the tool form exists", async () => {
    from.mockReturnValue(connectionsChain([BASE]));
    const onConfigureTool = vi.fn();
    const { unmount } = wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" onConfigureTool={onConfigureTool} />);
    fireEvent.click(await screen.findByRole("button", { name: /add agent tool/i }));
    expect(onConfigureTool).toHaveBeenCalledWith("google_sheets");
    unmount();

    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    await screen.findByText("ops@postora.cloud");
    expect(screen.queryByRole("button", { name: /add agent tool/i })).not.toBeInTheDocument();
  });
});
