import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatabaseConnectorsManager } from "@/components/automation/DatabaseConnectorsManager";

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({
    tools: [
      {
        id: "tool-1",
        name: "search_products",
        description: "Searches inventory database for matching products and pricing",
        tool_type: "n8n_webhook",
        url: "https://api.postora.cloud/rest/v1/products",
        secret: "test-secret",
        is_enabled: true,
        admin_only: false,
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

  it("renders connected database and store tools", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DatabaseConnectorsManager />
      </QueryClientProvider>
    );

    expect(screen.getByText("search_products")).toBeInTheDocument();
    expect(screen.getByText(/Searches inventory database/i)).toBeInTheDocument();
    expect(screen.getByText("New Connector")).toBeInTheDocument();
    expect(screen.getByText("Preset Integrations")).toBeInTheDocument();
  });

  it("opens preset picker dialog when clicking Preset Integrations", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <DatabaseConnectorsManager />
      </QueryClientProvider>
    );

    const presetBtn = screen.getByText("Preset Integrations");
    fireEvent.click(presetBtn);

    expect(screen.getByText("Choose a Connector Integration")).toBeInTheDocument();
    expect(screen.getByText("Supabase (Self-Hosted / Cloud)")).toBeInTheDocument();
    expect(screen.getByText("WooCommerce Store")).toBeInTheDocument();
    expect(screen.getByText("Shopify Storefront / Admin")).toBeInTheDocument();
  });
});
