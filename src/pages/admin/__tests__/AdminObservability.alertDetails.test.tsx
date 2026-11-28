import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import AdminObservability from "../AdminObservability";

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/features/webhook-observability", () => ({
  UnmatchedObservationsPanel: () => <div data-testid="unmatched-observations-panel" />,
}));

const ALERT_HISTORY_ROWS = [
  {
    id: "alert-1",
    alert_config_id: "cfg-1",
    alert_name: "Store Webhook Silent",
    trigger_type: "store_webhook_silence",
    triggered_value: 2,
    threshold_value: 0,
    metric_type: null,
    metric_name: null,
    details: {
      operator: "gt",
      time_window_minutes: 1440,
      silent_connections: [
        {
          connector_id: "conn-111",
          social_account_id: "acc-222",
          binding_id: "bind-333",
          last_delivery_at: "2026-10-01T10:00:00Z",
        },
        {
          connector_id: "conn-444",
          social_account_id: "acc-555",
          binding_id: null,
          last_delivery_at: "2026-10-01T08:30:00Z",
        },
      ],
    },
    notification_sent: true,
    notification_channel: "email",
    severity: "critical",
    is_resolved: false,
    resolved_at: null,
    created_at: "2026-10-02T10:00:00Z",
  },
];

function createQueryChain(table: string) {
  const rows = table === "observability_alert_history" ? ALERT_HISTORY_ROWS : [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.gte = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.single = () => Promise.resolve({ data: null, error: { code: "PGRST116" } });
  chain.then = (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => createQueryChain(table),
  },
}));

describe("AdminObservability store_webhook_silence details (#213)", () => {
  it("renders connector, account, binding (or deleted), and last delivery timestamp for silent store connections", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminObservability />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Store Webhook Silent")).toBeInTheDocument();
    expect(screen.getByText("Connector: conn-111")).toBeInTheDocument();
    expect(screen.getByText("Last delivery account: acc-222")).toBeInTheDocument();
    expect(screen.getByText("Binding at alert time: bind-333")).toBeInTheDocument();
    expect(screen.getByText("Last delivery: 2026-10-01T10:00:00Z")).toBeInTheDocument();

    expect(screen.getByText("Connector: conn-444")).toBeInTheDocument();
    expect(screen.getByText("Last delivery account: acc-555")).toBeInTheDocument();
    expect(screen.getByText("Binding at alert time: deleted")).toBeInTheDocument();
    expect(screen.getByText("Last delivery: 2026-10-01T08:30:00Z")).toBeInTheDocument();
  });
});
