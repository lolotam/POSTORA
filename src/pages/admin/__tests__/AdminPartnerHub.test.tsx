import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import AdminPartnerHub from "../AdminPartnerHub";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

describe("AdminPartnerHub", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_hub_overview") return Promise.resolve({ data: [{ active_keys: 1, revoked_keys: 0, month_billable: 5, month_posts: 0, requests_30d: 10, success_30d: 10, deliveries_30d: 0, delivered_30d: 0, exhausted_30d: 0, pending_deliveries: 0 }], error: null });
      if (fn === "admin_partner_keys") return Promise.resolve({ data: [{
        id: "k1", name: "Danat backend", environment: "production", key_prefix: "pk_live_a1b2", workspace_id: "ws", workspace_name: "Danat",
        social_account_id: "a", account_platform: "whatsapp", account_username: "danat", scopes: ["messages:send"], rate_limit_per_min: 60,
        monthly_quota: 100, usage_charged: 5, usage_reserved: 0, usage_confirmed: 5, usage_indeterminate: 0, period_start: "2026-09-01T00:00:00Z",
        status: "active", created_at: "2026-09-01T00:00:00Z", last_used_at: null, expires_at: null, revoked_at: null, revoked_reason: null, superseded_by_key_id: null,
      }], error: null });
      return Promise.resolve({ data: [], error: null });
    });
  });

  it("renders the KPIs and the keys table, and opens the generate dialog", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><AdminPartnerHub /></QueryClientProvider>);
    expect(await screen.findByText("Danat backend")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument(); // API health 10/10
    fireEvent.click(screen.getByRole("button", { name: /generate partner key/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
