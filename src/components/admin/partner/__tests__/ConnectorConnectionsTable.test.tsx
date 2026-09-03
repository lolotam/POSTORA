import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { ConnectorConnectionsTable } from "../ConnectorConnectionsTable";

const CONNECTIONS = [
  {
    id: "conn-1", workspace_id: "ws1", workspace_name: "Danat", connector_type: "google_sheets",
    toolkit: "googlesheets", external_account_label: "ops@postora.cloud", status: "active",
    failure_code: null, dependent_tools: 2, connected_at: "2026-09-01T10:00:00Z",
    last_used_at: "2026-09-02T10:00:00Z", revoked_at: null,
  },
  {
    id: "conn-2", workspace_id: "ws2", workspace_name: "Xsellpoint", connector_type: "slack",
    toolkit: "slack", external_account_label: null, status: "failed",
    failure_code: "expired", dependent_tools: 0, connected_at: null,
    last_used_at: null, revoked_at: null,
  },
];

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ConnectorConnectionsTable", () => {
  beforeEach(() => {
    rpc.mockReset().mockImplementation((fn: string) => {
      if (fn === "admin_connector_connections") return Promise.resolve({ data: CONNECTIONS, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("lists every workspace's connections with status, label and dependent tools", async () => {
    wrap(<ConnectorConnectionsTable />);
    expect(await screen.findByText("Danat")).toBeInTheDocument();
    expect(screen.getByText("ops@postora.cloud")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("admin_connector_connections", { p_workspace_id: null });
  });

  it("revokes a connection only after the admin confirms", async () => {
    wrap(<ConnectorConnectionsTable />);
    const row = (await screen.findByText("ops@postora.cloud")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /revoke/i }));
    expect(rpc).not.toHaveBeenCalledWith("revoke_connector_connection", expect.anything());
    fireEvent.click(await screen.findByRole("button", { name: /revoke connection/i }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("revoke_connector_connection", { p_connection_id: "conn-1" }),
    );
  });

  it("offers no revoke for a connection that is already gone", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "admin_connector_connections"
        ? Promise.resolve({ data: [{ ...CONNECTIONS[0], id: "conn-3", status: "revoked", revoked_at: "2026-09-02T11:00:00Z" }], error: null })
        : Promise.resolve({ data: null, error: null }));
    wrap(<ConnectorConnectionsTable />);
    await screen.findByText("revoked");
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("surfaces a refused read instead of an empty table", async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: "platform admin only" } }));
    wrap(<ConnectorConnectionsTable />);
    expect(await screen.findByText(/platform admin only/)).toBeInTheDocument();
  });
});
