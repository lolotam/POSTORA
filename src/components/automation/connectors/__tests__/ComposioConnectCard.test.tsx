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
const openTab = vi.fn();

/** fetch answers by route: initiate → the link; finalize → the given sequence. */
function routeFetch(finalizeReplies: Array<Record<string, unknown>>) {
  const replies = [...finalizeReplies];
  fetchMock.mockImplementation((url: string) => {
    const body = url.endsWith("/initiate")
      ? { connection_id: "conn-9", redirect_url: "https://composio.example/oauth", expires_at: "" }
      : replies.length > 1 ? replies.shift() : replies[0];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

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
    openTab.mockReset().mockReturnValue(null);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("open", openTab);
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

  it("falls back to navigating this tab to the authorisation page when a popup is blocked", async () => {
    routeFetch([{ status: "pending" }]);
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

  it("loads the authorisation page in a fresh tab and completes the connection by polling", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    openTab.mockReturnValue(tab);
    routeFetch([{ status: "pending" }, { status: "active" }]);
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(tab.location.href).toBe("https://composio.example/oauth"));
    expect(assign).not.toHaveBeenCalled();
    expect(await screen.findByText(/waiting for authorisation/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/finalize"))).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/finalize")) as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ connection_id: "conn-9" });
  });

  it("resumes polling for a row left initiated by an earlier attempt, and Cancel stops it", async () => {
    from.mockReturnValue(connectionsChain([{ ...BASE, status: "initiated", external_account_label: null }]));
    routeFetch([{ status: "pending" }]);
    wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
    expect(await screen.findByText(/waiting for authorisation/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/composio-connect\/finalize$/);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ connection_id: "conn-1" });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByRole("button", { name: /^connect$/i })).toBeEnabled();
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
    expect(await screen.findByText(/not completed in time/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
  });

  // 2026-09-03: a row left "initiated" by an abandoned click was re-adopted
  // every time its poll gave up — eight minutes of failing requests.
  it("does not re-adopt a waiting row once its poll has given up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      from.mockReturnValue(connectionsChain([{ ...BASE, status: "initiated", external_account_label: null }]));
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: "internal_error" }) });
      wrap(<ComposioConnectCard connectorType="google_sheets" workspaceId="ws-1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // Five failures in a row, one poll interval apart, end the poll.
      for (let attempt = 1; attempt < 5; attempt++) await vi.advanceTimersByTimeAsync(3_000);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
      expect(await screen.findByRole("button", { name: /^connect$/i })).toBeEnabled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
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
