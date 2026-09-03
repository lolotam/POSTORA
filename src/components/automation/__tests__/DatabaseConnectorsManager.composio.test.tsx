import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AiAgentTool } from "@/hooks/useAiAgentTools";

// Composio-backed connectors reach both mounts of the manager: the read-only
// Settings overview owns the connection, the agent Tools tab owns the
// exposure. The tool form for a Composio type has no credentials to collect —
// it picks a connection instead, and refuses to save without one.

const upsertTool = { mutate: vi.fn(), isPending: false };
const deleteTool = { mutate: vi.fn(), isPending: false };
let tools: AiAgentTool[] = [];

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools, isLoading: false, upsertTool, deleteTool }),
  useAiToolAccountLinks: () => ({ links: [], linksReady: true, linksError: null, setToolAccounts: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/lib/messagingApi", () => ({ callEdgeApi: vi.fn() }));

const ACCOUNTS = [
  { id: "wa-1", platform: "whatsapp", platform_username: "Xsellpoint", platform_user_id: null, is_active: true },
];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: ACCOUNTS, isSuccess: true, error: null }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: { user: { id: "u1" } }, profile: { id: "u1", api_key: "pk" } }),
}));

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null }) },
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } } }),
      refreshSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

const CONNECTION = {
  id: "conn-sheets",
  workspace_id: "ws-1",
  connector_type: "google_sheets",
  toolkit: "googlesheets",
  status: "active",
  external_account_label: "ops@postora.cloud",
  failure_code: null,
  created_at: "2026-09-01T00:00:00Z",
};

/** One PostgREST builder that answers every table this surface reads. */
function tableStub(table: string) {
  const chain: Record<string, unknown> = {};
  const rows = table === "connector_connections" ? [CONNECTION] : [];
  const single = table === "social_accounts"
    ? { workspace_id: "ws-1" }
    : table === "workspaces"
    ? { id: "ws-personal" }
    : null;
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: single, error: null }),
  });
  return chain;
}

const tool = (overrides: Partial<AiAgentTool> & { id: string }): AiAgentTool => ({
  name: "woocommerce_store",
  description: "Looks up products and orders",
  tool_type: "n8n_webhook",
  url: "https://shop.example.com/wp-json/wc/v3/products",
  has_secret: false,
  is_enabled: true,
  admin_only: false,
  connector_type: "woocommerce",
  permissions: { search_products: true, check_stock: false, lookup_orders: false },
  read_only_mode: true,
  enable_cache: true,
  social_account_id: "wa-1",
  scope: "account",
  platform: "whatsapp",
  settings: {},
  configured_secret_fields: [],
  last_test_at: null,
  last_test_ok: null,
  last_test_error: null,
  created_at: "2026-08-01T00:00:00Z",
  ...overrides,
});

function renderManager(props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DatabaseConnectorsManager platform="whatsapp" accountId="wa-1" {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  tools = [];
  upsertTool.mutate.mockReset();
  deleteTool.mutate.mockReset();
  rpc.mockReset().mockResolvedValue({ data: [], error: null });
  from.mockReset().mockImplementation((table: string) => tableStub(table));
});

afterEach(cleanup);

describe("category tabs", () => {
  it("offers every registry category from the shared tab list", async () => {
    renderManager();
    const tabs = within(await screen.findByTestId("connector-category-tabs"));
    for (const label of ["E-Commerce & Payments", "Productivity & Apps", "Databases", "Automation"]) {
      expect(tabs.getByText(label).tagName).toBe("BUTTON");
    }
  });
});

describe("Composio connection cards", () => {
  it("offers the Composio apps on the agent Tools tab", async () => {
    renderManager();
    expect(await screen.findByTestId("composio-card-google_sheets")).toBeInTheDocument();
    expect(screen.getByTestId("composio-card-slack")).toBeInTheDocument();
  });

  it("still offers the connection controls on the read-only Settings mount", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <DatabaseConnectorsManager readOnly />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("composio-card-google_sheets");
    expect(await within(card).findByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    // The readOnly prop hides the tool form, not the connection controls.
    expect(within(card).queryByRole("button", { name: /add agent tool/i })).not.toBeInTheDocument();
  });

  it("hides the Composio apps when another category is selected", async () => {
    renderManager();
    await screen.findByTestId("composio-card-google_sheets");
    fireEvent.click(within(screen.getByTestId("connector-category-tabs")).getByText("Databases"));
    expect(screen.queryByTestId("composio-card-google_sheets")).not.toBeInTheDocument();
  });
});

describe("the tool form for a Composio connector", () => {
  const openComposioForm = async () => {
    renderManager();
    const card = await screen.findByTestId("composio-card-google_sheets");
    fireEvent.click(await within(card).findByRole("button", { name: /add agent tool/i }));
  };

  it("asks for a connection instead of credentials", async () => {
    await openComposioForm();
    expect(await screen.findByLabelText("Connection")).toBeInTheDocument();
    expect(screen.queryByLabelText(/API Endpoint \/ Webhook URL/i)).not.toBeInTheDocument();
  });

  it("submits the chosen connection with the tool", async () => {
    await openComposioForm();
    await screen.findByRole("option", { name: /ops@postora.cloud/ });
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "conn-sheets" } });
    fireEvent.change(screen.getByLabelText(/tool name/i), { target: { value: "sheets_lookup" } });
    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));
    await waitFor(() => expect(upsertTool.mutate).toHaveBeenCalled());
    const payload = upsertTool.mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.connector_type).toBe("google_sheets");
    expect(payload.connection_id).toBe("conn-sheets");
  });

  it("refuses to save a Composio tool with no connection chosen", async () => {
    await openComposioForm();
    await screen.findByLabelText("Connection");
    fireEvent.change(screen.getByLabelText(/tool name/i), { target: { value: "sheets_lookup" } });
    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));
    expect(await screen.findByText(/choose a connected .* account before saving/i)).toBeInTheDocument();
    expect(upsertTool.mutate).not.toHaveBeenCalled();
  });
});

describe("usage on configured tool cards", () => {
  it("shows the tool's call count from workspace_connector_usage", async () => {
    tools = [tool({ id: "woo-1", name: "woo_store" })];
    rpc.mockResolvedValue({
      data: [{ tool_id: "woo-1", connector_type: "woocommerce", calls: 142, failures: 0, refused: 0, p50_latency_ms: 640, last_used_at: "2026-09-02T00:00:00Z" }],
      error: null,
    });
    renderManager();
    expect(await screen.findByText("142 calls · 30 d · p50 640 ms")).toBeInTheDocument();
  });
});
