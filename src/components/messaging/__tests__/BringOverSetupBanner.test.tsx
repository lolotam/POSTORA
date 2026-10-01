import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BringOverSetupBanner } from "@/components/messaging/BringOverSetupBanner";

const mockCandidates = vi.hoisted(() => ({ current: [] as any[] }));
vi.mock("@/hooks/useSetupMoveCandidates", () => ({
  useSetupMoveCandidates: () => mockCandidates.current,
}));

const mockActiveSummary = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/hooks/useWhatsAppSetupSummary", () => ({
  useWhatsAppSetupSummary: () => ({
    data: mockActiveSummary.current,
    isLoading: false,
  }),
}));

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  toast: toastSpy,
}));

const invokeSpy = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: invokeSpy,
    },
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === "get_whatsapp_account_setup_summary") {
        return Promise.resolve({ data: mockActiveSummary.current, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const template = typeof fallback === "string" ? fallback : _key;
      const vars = typeof fallback === "string" ? options : fallback;
      if (!vars || typeof vars !== "object") return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
    },
  }),
}));

function renderBanner(activeAccount: any) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BringOverSetupBanner activeAccount={activeAccount} />
    </QueryClientProvider>,
  );
}

describe("BringOverSetupBanner", () => {
  const activeAccount = {
    id: "active-1",
    name: "xsellpoint",
    platform_username: "xsellpoint",
    platform_user_id: "96597950350",
    connection_mode: "evolution_qr",
    account_metadata: {},
  };

  const candidateWithSetup = {
    from: {
      id: "cand-1",
      name: "xsellpoint (old)",
      platform_username: "xsellpoint (old)",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
    },
    id: "cand-1",
    name: "xsellpoint (old)",
    platform_username: "xsellpoint (old)",
    summary: {
      agent_config: 1,
      connectors: 1,
      connector_links: 0,
      store_bindings: 1,
      knowledge_sources: 5,
      test_cases: 0,
      waitlist: 0,
      templates: 0,
      partner_keys_primary: 0,
      partner_key_links: 0,
      partner_webhooks: 0,
      n8n_subscriptions: 0,
      scheduled_messages: 0,
      automation_handlers: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCandidates.current = [];
    mockActiveSummary.current = null;
    invokeSpy.mockResolvedValue({ data: { status: "moved" }, error: null });
  });

  it("renders nothing when there are no setup move candidates", () => {
    mockCandidates.current = [];
    const { container } = renderBanner(activeAccount);
    expect(container.firstChild).toBeNull();
  });

  it("renders explanation text with candidate name, active name, and summarized setup items", () => {
    mockCandidates.current = [candidateWithSetup];

    renderBanner(activeAccount);

    const expectedText =
      "xsellpoint (old) has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to xsellpoint?";
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("checklist: unchecking WooCommerce connector disables Store webhook checkbox and shows helper text", () => {
    mockCandidates.current = [candidateWithSetup];

    renderBanner(activeAccount);

    const wooCheckbox = screen.getByLabelText(/WooCommerce connector/i);
    const storeWebhookCheckbox = screen.getByLabelText(/Store webhook/i);

    expect(wooCheckbox).toBeChecked();
    expect(storeWebhookCheckbox).not.toBeDisabled();

    fireEvent.click(wooCheckbox);

    expect(wooCheckbox).not.toBeChecked();
    expect(storeWebhookCheckbox).toBeDisabled();
    expect(screen.getByText("Moves with its WooCommerce connector")).toBeInTheDocument();
  });

  it("renders radio group to choose between active agent and candidate agent when active account also has an agent config", () => {
    mockCandidates.current = [candidateWithSetup];
    mockActiveSummary.current = {
      agent_config: 1,
      connectors: 0,
      store_bindings: 0,
      knowledge_sources: 0,
    };

    renderBanner(activeAccount);

    expect(screen.getByText("Keep this account's AI agent")).toBeInTheDocument();
    expect(screen.getByText("Use the one from xsellpoint (old)")).toBeInTheDocument();
  });

  it("clicking Move invokes move_setup on whatsapp-evolution-bridge and shows toast Setup moved on success", async () => {
    mockCandidates.current = [candidateWithSetup];
    invokeSpy.mockResolvedValueOnce({
      data: { status: "moved", moved: { agent_config: 1 } },
      error: null,
    });

    renderBanner(activeAccount);

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: expect.objectContaining({
          action: "move_setup",
          from: "cand-1",
          to: "active-1",
          choices: expect.any(Object),
        }),
      });
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Setup moved",
        }),
      );
    });
  });

  it("clicking Not now invokes dismiss_setup_move on whatsapp-evolution-bridge and hides the banner", async () => {
    mockCandidates.current = [candidateWithSetup];
    invokeSpy.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const { container } = renderBanner(activeAccount);

    const notNowButton = screen.getByRole("button", { name: /Not now/i });
    fireEvent.click(notNowButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "dismiss_setup_move",
          from: "cand-1",
          to: "active-1",
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/xsellpoint \(old\) has an AI agent/),
      ).not.toBeInTheDocument();
    });
  });
});
