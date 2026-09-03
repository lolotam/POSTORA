import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import { ConnectorUsageLine } from "../ConnectorUsageLine";

const USAGE = [
  { tool_id: "tool-1", connector_type: "woocommerce", calls: 142, failures: 2, refused: 0, p50_latency_ms: 640, last_used_at: "2026-09-02T09:00:00Z" },
  { tool_id: "tool-2", connector_type: "google_sheets", calls: 5, failures: 0, refused: 0, p50_latency_ms: 120, last_used_at: "2026-09-01T09:00:00Z" },
];

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ConnectorUsageLine", () => {
  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: USAGE, error: null });
  });

  it("shows a configured tool's calls, window and median latency", async () => {
    wrap(<ConnectorUsageLine workspaceId="ws-1" toolId="tool-1" />);
    expect(await screen.findByText("142 calls · 30 d · p50 640 ms")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("workspace_connector_usage", { p_workspace_id: "ws-1", p_days: 30 });
  });

  it("shows a tool with no calls in the window as such", async () => {
    wrap(<ConnectorUsageLine workspaceId="ws-1" toolId="tool-unused" />);
    expect(await screen.findByText("No calls in 30 d")).toBeInTheDocument();
  });

  it("sums a connection's calls across every tool of its connector type", async () => {
    rpc.mockResolvedValue({
      data: [
        { tool_id: "a", connector_type: "google_sheets", calls: 4, failures: 0, refused: 0, p50_latency_ms: 100, last_used_at: "2026-09-01T00:00:00Z" },
        { tool_id: "b", connector_type: "google_sheets", calls: 6, failures: 0, refused: 0, p50_latency_ms: 900, last_used_at: "2026-09-02T00:00:00Z" },
      ],
      error: null,
    });
    wrap(<ConnectorUsageLine workspaceId="ws-1" connectorType="google_sheets" />);
    expect(await screen.findByText("10 calls · 30 d")).toBeInTheDocument();
  });

  it("says nothing at all until a workspace is known", () => {
    wrap(<ConnectorUsageLine workspaceId={null} toolId="tool-1" />);
    expect(screen.queryByText(/calls/)).not.toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });
});
