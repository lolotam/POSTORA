import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { ConnectorUsageTables } from "../ConnectorUsageTables";

const BY_TYPE = [
  { connector_type: "google_sheets", auth_strategy: "composio_oauth", calls: 120, failures: 4, p50_latency_ms: 640, p95_latency_ms: 1800 },
  { connector_type: "unknown", auth_strategy: "unknown", calls: 7, failures: 0, p50_latency_ms: null, p95_latency_ms: null },
];
const BY_KEY = [
  { partner_key_id: "k1", key_name: "Danat backend", key_prefix: "pk_live_abc", workspace_id: "ws1", workspace_name: "Danat", calls: 30, failures: 1, p95_latency_ms: 900 },
];

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ConnectorUsageTables", () => {
  beforeEach(() => {
    rpc.mockReset().mockImplementation((fn: string) => {
      if (fn === "admin_connector_usage_by_type") return Promise.resolve({ data: BY_TYPE, error: null });
      if (fn === "admin_connector_usage_by_key") return Promise.resolve({ data: BY_KEY, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("shows connector traffic by type and by partner key over the default 30-day window", async () => {
    wrap(<ConnectorUsageTables />);
    expect(await screen.findByText("google_sheets")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(await screen.findByText("Danat backend")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_type", { p_days: 30 });
    expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_key", { p_days: 30 });
  });

  it("names the pre-resolution refusal bucket rather than showing a raw 'unknown' type", async () => {
    wrap(<ConnectorUsageTables />);
    expect(await screen.findByText("Unresolved requests")).toBeInTheDocument();
  });

  it("shows a dash where a window produced no latency percentile", async () => {
    wrap(<ConnectorUsageTables />);
    await screen.findByText("Unresolved requests");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("re-reads both tables for the window the admin selects", async () => {
    wrap(<ConnectorUsageTables />);
    await screen.findByText("google_sheets");
    fireEvent.change(screen.getByLabelText(/window/i), { target: { value: "90" } });
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_type", { p_days: 90 });
      expect(rpc).toHaveBeenCalledWith("admin_connector_usage_by_key", { p_days: 90 });
    });
  });

  it("surfaces a refused read instead of an empty table", async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: "platform admin only" } }));
    wrap(<ConnectorUsageTables />);
    const shown = await screen.findAllByText(
      (_content, element) => element?.textContent === "Could not load connector usage: platform admin only",
    );
    expect(shown.length).toBeGreaterThanOrEqual(1);
  });
});
