import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: { user: { id: "u1" } }, profile: { id: "u1", api_key: "pk" } }),
}));

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({
    tools: [
      {
        id: "tool-1",
        name: "supabase_product_catalog",
        description: "Searches inventory database for matching products and pricing",
        tool_type: "n8n_webhook",
        url: "https://api.postora.cloud/rest/v1/products",
        has_secret: true,
        is_enabled: true,
        admin_only: false,
        connector_type: "supabase",
        permissions: { search_products: true, check_stock: true, lookup_orders: false },
        read_only_mode: true,
        enable_cache: true,
        created_at: "2026-08-25T10:00:00Z",
      },
    ],
    isLoading: false,
    upsertTool: { mutate: vi.fn(), isPending: false },
    deleteTool: { mutate: vi.fn(), isPending: false },
  }),
}));

describe("DatabaseConnectorsManager", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("renders connector directory cards and active connected servers", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DatabaseConnectorsManager />
      </QueryClientProvider>
    );

    expect(screen.getByText("Integrations & Connectors Directory")).toBeInTheDocument();
    expect(screen.getByText("Shopify Storefront")).toBeInTheDocument();
    expect(screen.getByText("WooCommerce Store")).toBeInTheDocument();
    expect(screen.getByText("Salla (سلة)")).toBeInTheDocument();
    expect(screen.getByText("MyFatoorah")).toBeInTheDocument();
    expect(screen.getByText("Higgsfield AI Studio")).toBeInTheDocument();
    expect(screen.getAllByText("Supabase (PostgreSQL)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Custom Webhook")).toBeInTheDocument();
    expect(screen.getByText("Connected Integrations & Active Servers")).toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(1);
  });

  it("opens connector configuration modal when clicking a card", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DatabaseConnectorsManager />
      </QueryClientProvider>
    );

    const shopifyCard = screen.getByText("Shopify Storefront");
    fireEvent.click(shopifyCard);

    expect(screen.getByText("Credentials & API")).toBeInTheDocument();
    expect(screen.getByText("Model Context Protocol (MCP)")).toBeInTheDocument();
    expect(screen.getByText("Security & Isolation")).toBeInTheDocument();
  });
});
