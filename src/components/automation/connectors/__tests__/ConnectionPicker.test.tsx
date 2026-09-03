import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...a: unknown[]) => from(...a) },
}));

import { ConnectionPicker } from "../ConnectionPicker";

function connectionsChain(rows: Record<string, unknown>[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain;
}

const ACTIVE_SHEETS = {
  id: "conn-sheets",
  workspace_id: "ws-1",
  connector_type: "google_sheets",
  status: "active",
  external_account_label: "ops@postora.cloud",
  created_at: "2026-09-01T00:00:00Z",
};

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ConnectionPicker", () => {
  beforeEach(() => from.mockReset());

  it("offers only the active connections of the chosen connector type", async () => {
    from.mockReturnValue(connectionsChain([
      ACTIVE_SHEETS,
      { ...ACTIVE_SHEETS, id: "conn-revoked", status: "revoked", external_account_label: "old@postora.cloud" },
      { ...ACTIVE_SHEETS, id: "conn-slack", connector_type: "slack", external_account_label: "postora-slack" },
    ]));
    wrap(<ConnectionPicker connectorType="google_sheets" workspaceId="ws-1" value={null} onChange={() => {}} />);
    expect(await screen.findByRole("option", { name: /ops@postora.cloud/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /old@postora.cloud/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /postora-slack/ })).not.toBeInTheDocument();
  });

  it("reports the chosen connection id", async () => {
    from.mockReturnValue(connectionsChain([ACTIVE_SHEETS]));
    const onChange = vi.fn();
    wrap(<ConnectionPicker connectorType="google_sheets" workspaceId="ws-1" value={null} onChange={onChange} />);
    await screen.findByRole("option", { name: /ops@postora.cloud/ });
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "conn-sheets" } });
    expect(onChange).toHaveBeenCalledWith("conn-sheets");
  });

  it("tells the user to connect the account to a workspace first when it has none", () => {
    wrap(<ConnectionPicker connectorType="google_sheets" workspaceId={null} value={null} onChange={() => {}} />);
    expect(
      screen.getByText("This account has no workspace; connect it from Profiles first"),
    ).toBeInTheDocument();
    expect(from).not.toHaveBeenCalled();
  });

  it("says nothing about a missing workspace while the workspace is still being resolved", () => {
    wrap(<ConnectionPicker connectorType="google_sheets" workspaceId={null} isWorkspaceLoading value={null} onChange={() => {}} />);
    expect(screen.queryByText(/no workspace/i)).not.toBeInTheDocument();
  });

  it("points the user at Settings when the workspace has no active connection yet", async () => {
    from.mockReturnValue(connectionsChain([]));
    wrap(<ConnectionPicker connectorType="google_sheets" workspaceId="ws-1" value={null} onChange={() => {}} />);
    expect(await screen.findByText(/Settings → Integrations/)).toBeInTheDocument();
  });
});
