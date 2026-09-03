import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PartnerKeyActivitySheet } from "../PartnerKeyActivitySheet";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const KEY = { id: "k1", name: "Danat backend", workspace_name: "Danat" };

describe("PartnerKeyActivitySheet", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_activity") return Promise.resolve({ data: [
        { id: "u1", created_at: "2026-09-02T09:14:00Z", action: "send_template", http_status: 200, error_code: null, billable: true, request_id: "req-1", latency_ms: 321 },
        { id: "u2", created_at: "2026-09-02T09:15:00Z", action: "list_accounts", http_status: 403, error_code: "insufficient_scope", billable: false, request_id: null, latency_ms: null },
      ], error: null });
      if (fn === "admin_partner_key_webhook_deliveries") return Promise.resolve({ data: [
        { id: "d1", occurred_at: "2026-09-02T09:14:05Z", event_type: "message.delivered", status: "delivered", attempts: 1, next_attempt_at: "2026-09-02T09:14:05Z", last_status_code: 200, last_error: null, delivered_at: "2026-09-02T09:14:06Z", webhook_id: "w1", webhook_url: "https://partner.example/hook", webhook_is_active: true },
      ], error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("renders requests with endpoint, status, request id and latency, dashes for nulls", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PartnerKeyActivitySheet partnerKey={KEY} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText("POST /v1/messages")).toBeInTheDocument();
    expect(screen.getByText("req-1")).toBeInTheDocument();
    expect(screen.getByText("321 ms")).toBeInTheDocument();
    expect(screen.getByText("insufficient_scope")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the workspace's webhook deliveries", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PartnerKeyActivitySheet partnerKey={KEY} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText("message.delivered")).toBeInTheDocument();
    expect(screen.getByText(/Webhook deliveries — workspace Danat/)).toBeInTheDocument();
    expect(screen.getByText("https://partner.example/hook")).toBeInTheDocument();
  });
});

describe("PartnerKeyActivitySheet connector section", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_connector_activity") return Promise.resolve({ data: [
        { id: "c1", created_at: "2026-09-02T09:20:00Z", connector_type: "google_sheets", action_name: "GOOGLESHEETS_GET_ROWS", status: "success", error_code: null, latency_ms: 420, request_id: "req-9" },
        { id: "c2", created_at: "2026-09-02T09:21:00Z", connector_type: "slack", action_name: "SLACK_POST", status: "refused", error_code: "connector_unavailable", latency_ms: null, request_id: null },
      ], error: null });
      return Promise.resolve({ data: [], error: null });
    });
  });

  it("lists the key's connector calls with latency, request id and dashes for nulls", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PartnerKeyActivitySheet partnerKey={KEY} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText("Connector calls")).toBeInTheDocument();
    expect(await screen.findByText("GOOGLESHEETS_GET_ROWS")).toBeInTheDocument();
    expect(screen.getByText("420 ms")).toBeInTheDocument();
    expect(screen.getByText("req-9")).toBeInTheDocument();
    expect(screen.getByText("connector_unavailable")).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("admin_partner_key_connector_activity", { p_key_id: "k1", p_limit: 50 });
  });
});
