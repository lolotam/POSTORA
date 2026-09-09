import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentTool } from "@/hooks/useAiAgentTools";

// Registry-driven credential fields and the Test connection button. The form
// renders whatever connectorDefinition(type).credentials declares (never a
// hardcoded type list), sends the structured `credentials` object the server
// already validates, keeps blank secrets meaning "keep existing", and derives
// the Test button from the registry's adapter capabilities.

const upsertTool = { mutate: vi.fn(), isPending: false };
const deleteTool = { mutate: vi.fn(), isPending: false };
let tools: AiAgentTool[] = [];
let links: Array<{ tool_id: string; social_account_id: string }> = [];
const setToolAccounts = { mutateAsync: vi.fn().mockResolvedValue({}) };
const { callEdgeApi } = vi.hoisted(() => ({ callEdgeApi: vi.fn() }));

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools, isLoading: false, upsertTool, deleteTool }),
  useAiToolAccountLinks: () => ({ links, linksReady: true, linksError: null, setToolAccounts }),
}));

vi.mock("@/lib/messagingApi", () => ({ callEdgeApi }));

const ACCOUNTS = [
  { id: "wa-1", platform: "whatsapp", platform_username: "Xsellpoint", platform_user_id: null, is_active: true },
];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: ACCOUNTS, isSuccess: true, error: null }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: { user: { id: "u1" } }, profile: { id: "u1", api_key: "pk" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn().mockResolvedValue({ data: null }) },
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

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
  settings: { store_url: "https://shop.example.com" },
  configured_secret_fields: ["consumer_key", "consumer_secret"],
  last_test_at: null,
  last_test_ok: null,
  last_test_error: null,
  created_at: "2026-08-01T00:00:00Z",
  ...overrides,
});

const WOO: AiAgentTool = tool({ id: "woo-1", name: "woo_store" });
const SUPA: AiAgentTool = tool({
  id: "supa-1",
  name: "supa_catalog",
  connector_type: "supabase",
  url: "https://project.example.com/rest/v1/products",
  settings: { project_url: "https://project.example.com", schema: "public", table_allow_list: ["products", "orders"] },
  configured_secret_fields: ["anon_key"],
});
const REST: AiAgentTool = tool({
  id: "rest-1",
  name: "hook_tool",
  connector_type: "custom_rest",
  url: "https://hooks.example.com/x",
  settings: { url: "https://hooks.example.com/x", header_name: "X-Webhook-Secret" },
  configured_secret_fields: ["secret"],
});

const toolCardElement = (name: string): HTMLElement => {
  const card = screen.getByText(name).closest('[data-testid^="tool-card-"]');
  if (!card) throw new Error(`no tool card for ${name}`);
  return card as HTMLElement;
};
const toolCard = (name: string) => within(toolCardElement(name));

function renderManager(props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DatabaseConnectorsManager platform="whatsapp" accountId="wa-1" {...props} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const openEdit = (name: string) => {
  fireEvent.click(toolCard(name).getByRole("button", { name: /edit/i }));
};

const saveTool = () => {
  fireEvent.click(screen.getByRole("button", { name: /save changes|save & connect/i }));
};

const lastPayload = () => upsertTool.mutate.mock.calls[0]?.[0] as Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const OK_RESULT = {
  ok: true,
  vendor: "woocommerce",
  action: "test_connection",
  capabilities: ["search_products", "check_stock", "lookup_orders"],
  read_only: true,
};
const FAIL_RESULT = {
  ok: false,
  vendor: "woocommerce",
  error: { code: "woocommerce_http_error", message: "WooCommerce rejected the request.", vendor_status: 401 },
};

describe("registry-driven credential fields", () => {
  beforeEach(() => {
    upsertTool.mutate.mockReset();
    deleteTool.mutate.mockReset();
    callEdgeApi.mockReset();
    callEdgeApi.mockResolvedValue(OK_RESULT);
    tools = [];
    links = [];
  });

  it("renders exactly the registry's three fields for woocommerce", () => {
    tools = [WOO];
    renderManager();
    openEdit("woo_store");
    for (const label of ["Store URL", "Consumer key", "Consumer secret"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // The registry url field replaces the generic endpoint input.
    expect(screen.queryByLabelText(/API Endpoint/i)).not.toBeInTheDocument();
  });

  it("renders every registry field for supabase, paging settings included", () => {
    tools = [SUPA];
    renderManager();
    openEdit("supa_catalog");
    for (
      const label of [
        "Project URL",
        "Anon key",
        "Schema",
        "Table allow-list",
        "Columns per table (optional)",
        "Order by column",
        "Maximum rows per answer",
        "Rows per request (optional)",
      ]
    ) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText(/API Endpoint/i)).not.toBeInTheDocument();
  });

  it("submits a sentinel for a cleared row ceiling instead of omitting it", () => {
    // A blank value is dropped before save and the server merges settings, so
    // omitting a cleared field leaves the old ceiling in place forever. "0"
    // and "{}" both resolve to the default on the adapter side.
    tools = [tool({
      id: "supa-2",
      name: "supa_catalog",
      connector_type: "supabase",
      settings: {
        project_url: "https://project.example.com",
        schema: "public",
        table_allow_list: "products",
        max_rows: "500",
        column_map: '{"products":["id"]}',
      },
      configured_secret_fields: ["anon_key"],
    })];
    renderManager();
    openEdit("supa_catalog");

    fireEvent.change(screen.getByLabelText("Maximum rows per answer"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Columns per table (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save|update/i }));

    const saved = upsertTool.mutate.mock.calls.at(-1)?.[0] as
      | { credentials?: Record<string, string> }
      | undefined;
    expect(saved?.credentials?.max_rows).toBe("0");
    expect(saved?.credentials?.column_map).toBe("{}");
  });

  it("keeps the generic endpoint input only for types without a url credential field", () => {
    tools = [tool({ id: "st-1", name: "stripe_billing", connector_type: "stripe", settings: {}, configured_secret_fields: ["restricted_api_key"] })];
    renderManager();
    openEdit("stripe_billing");
    expect(screen.getByLabelText(/API Endpoint/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Restricted API key")).toBeInTheDocument();
  });

  it("repopulates non-secret values from settings on edit and never renders a stored secret", () => {
    tools = [WOO];
    renderManager();
    openEdit("woo_store");
    expect(screen.getByLabelText("Store URL")).toHaveValue("https://shop.example.com");
    expect(screen.getByLabelText("Consumer key")).toHaveValue("");
    expect(screen.getByLabelText("Consumer secret")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    tools = [SUPA];
    // Second render in one test: drop the first tree so screens don't overlap.
    cleanup();
    renderManager();
    openEdit("supa_catalog");
    expect(screen.getByLabelText("Project URL")).toHaveValue("https://project.example.com");
    expect(screen.getByLabelText("Schema")).toHaveValue("public");
    expect(screen.getByLabelText("Table allow-list")).toHaveValue("products, orders");
    expect(screen.getByLabelText("Anon key")).toHaveValue("");
  });

  it("sends credentials keyed by registry field name on create — not a url/secret pair", () => {
    tools = [];
    renderManager();
    fireEvent.click(screen.getByText("WooCommerce Store"));
    fireEvent.change(screen.getByLabelText("Store URL"), { target: { value: "https://shop.example.com" } });
    fireEvent.change(screen.getByLabelText("Consumer key"), { target: { value: "ck_123" } });
    fireEvent.change(screen.getByLabelText("Consumer secret"), { target: { value: "cs_456" } });
    saveTool();

    const payload = lastPayload();
    expect(payload.credentials).toEqual({
      store_url: "https://shop.example.com",
      consumer_key: "ck_123",
      consumer_secret: "cs_456",
    });
    expect("secret" in payload).toBe(false);
  });

  it("keeps an existing secret when its field is left blank on edit, sends a filled one", () => {
    tools = [WOO];
    renderManager();
    openEdit("woo_store");
    // consumer_secret is configured and left blank: keep-existing.
    fireEvent.change(screen.getByLabelText("Consumer key"), { target: { value: "ck_new" } });
    saveTool();

    const credentials = lastPayload().credentials as Record<string, string>;
    expect(credentials.consumer_key).toBe("ck_new");
    expect("consumer_secret" in credentials).toBe(false);
    // A required secret that is already configured must not block the save.
    expect(upsertTool.mutate).toHaveBeenCalledTimes(1);
  });

  it("renders custom_rest's own registry fields and saves through credentials", () => {
    tools = [REST];
    renderManager();
    openEdit("hook_tool");
    for (const label of ["URL", "Header name", "Secret"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("URL")).toHaveValue("https://hooks.example.com/x");
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "whsec_9" } });
    saveTool();

    const payload = lastPayload();
    expect(payload.credentials).toEqual({
      url: "https://hooks.example.com/x",
      header_name: "X-Webhook-Secret",
      secret: "whsec_9",
    });
    expect("secret" in payload).toBe(false);
  });

  it("blocks save with an inline message when a required field is blank", () => {
    tools = [WOO];
    renderManager();
    openEdit("woo_store");
    fireEvent.change(screen.getByLabelText("Store URL"), { target: { value: "" } });
    saveTool();

    expect(screen.getByText("Store URL is required.")).toBeInTheDocument();
    expect(upsertTool.mutate).not.toHaveBeenCalled();
  });
});

describe("Test connection", () => {
  beforeEach(() => {
    upsertTool.mutate.mockReset();
    deleteTool.mutate.mockReset();
    callEdgeApi.mockReset();
    callEdgeApi.mockResolvedValue(OK_RESULT);
    tools = [];
    links = [];
  });

  it("shows an enabled Test button for adapter types and only an indicator for the rest", () => {
    tools = [WOO, REST];
    renderManager();

    const wooButton = toolCard("woo_store").getByRole("button", { name: /test connection/i });
    expect(wooButton).toBeEnabled();

    const restCard = toolCard("hook_tool");
    expect(restCard.queryByRole("button", { name: /test connection/i })).not.toBeInTheDocument();
    expect(restCard.getByText(/no adapter yet/i)).toBeInTheDocument();
  });

  it("posts exactly { tool_id, action: 'test_connection' } to ai-agent-adapters", async () => {
    tools = [WOO];
    renderManager();

    fireEvent.click(toolCard("woo_store").getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(callEdgeApi).toHaveBeenCalledTimes(1);
    });
    expect(callEdgeApi).toHaveBeenCalledWith("ai-agent-adapters", "test_connection", { tool_id: "woo-1" });
  });

  it("disables only the in-flight connector's button — another card stays enabled", async () => {
    tools = [WOO, SUPA];
    const gate = deferred<unknown>();
    callEdgeApi.mockReturnValue(gate.promise);
    renderManager();

    const wooButton = toolCard("woo_store").getByRole("button", { name: /test connection/i });
    const supaButton = toolCard("supa_catalog").getByRole("button", { name: /test connection/i });
    fireEvent.click(wooButton);

    expect(wooButton).toBeDisabled();
    expect(supaButton).toBeEnabled();

    gate.resolve(OK_RESULT);
    await waitFor(() => {
      expect(wooButton).toBeEnabled();
    });
  });

  it("renders a green success badge with the adapter's capability facts", async () => {
    tools = [WOO];
    renderManager();
    fireEvent.click(toolCard("woo_store").getByRole("button", { name: /test connection/i }));

    const badge = await screen.findByTestId("test-result-ok-woo-1");
    expect(badge.textContent).toContain("Connection OK");
    expect(badge.textContent).toContain("search_products");
    expect(badge.textContent).toContain("read-only");
    expect(badge.className).toMatch(/emerald/);
  });

  it("renders the vendor status and safe message on failure, never styled as success", async () => {
    tools = [WOO];
    callEdgeApi.mockResolvedValue(FAIL_RESULT);
    renderManager();
    fireEvent.click(toolCard("woo_store").getByRole("button", { name: /test connection/i }));

    const alert = await screen.findByTestId("test-result-error-woo-1");
    expect(alert.textContent).toContain("WooCommerce rejected the request.");
    expect(alert.textContent).toContain("401");
    expect(alert.className).not.toMatch(/emerald/);
    expect(alert.className).toMatch(/destructive|rose|red/);
    expect(screen.queryByTestId("test-result-ok-woo-1")).not.toBeInTheDocument();
  });

  it("shows the stored last_test_ok=false on first load without clicking", () => {
    tools = [tool({
      id: "woo-1",
      name: "woo_store",
      last_test_at: "2026-08-31T10:00:00Z",
      last_test_ok: false,
      last_test_error: "woocommerce_http_error: WooCommerce rejected the request.",
    })];
    renderManager();

    const stored = toolCard("woo_store").getByTestId("test-result-error-woo-1");
    expect(stored.textContent).toContain("Last test failed");
    expect(stored.textContent).toContain("woocommerce_http_error: WooCommerce rejected the request.");
  });

  it("never renders a typed credential value in any test result", async () => {
    tools = [WOO];
    renderManager();
    openEdit("woo_store");
    fireEvent.change(screen.getByLabelText("Consumer secret"), { target: { value: "cs_super_secret_value" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    fireEvent.click(toolCard("woo_store").getByRole("button", { name: /test connection/i }));
    await screen.findByTestId("test-result-ok-woo-1");

    expect(screen.queryByText(/cs_super_secret_value/)).not.toBeInTheDocument();
  });
});
