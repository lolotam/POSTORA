import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BringOverSetupBanner } from "@/components/messaging/BringOverSetupBanner";
import type { SetupMoveCandidate } from "@/hooks/useSetupMoveCandidates";
import type { SetupMovePreview } from "@/hooks/useSetupMovePreview";

function mockQueryResult<T>(data: T, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    isPending: false,
    isFetching: false,
    status: "success",
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

const mockCandidatesData = vi.hoisted(() => ({ current: [] as SetupMoveCandidate[] }));
const mockPreviewData = vi.hoisted(() => ({ current: null as SetupMovePreview | null }));
const mockCandidatesFailed = vi.hoisted(() => ({ current: false }));
const candidatesRefetch = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useSetupMoveCandidates", () => ({
  useSetupMoveCandidates: () =>
    mockCandidatesFailed.current
      ? mockQueryResult(undefined, { isError: true, isSuccess: false, status: "error", refetch: candidatesRefetch })
      : mockQueryResult(mockCandidatesData.current),
}));

vi.mock("@/hooks/useSetupMovePreview", () => ({
  useSetupMovePreview: () => mockQueryResult(mockPreviewData.current),
}));

vi.mock("@/hooks/useWhatsAppSetupSummary", () => ({
  useWhatsAppSetupSummary: () => mockQueryResult(null),
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
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const template = typeof fallback === "string" ? fallback : key;
      const vars = typeof fallback === "string" ? options : fallback;
      if (!vars || typeof vars !== "object") return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
    },
  }),
}));

function createPreview(overrides: Record<string, unknown> = {}) {
  return {
    same_workspace: true,
    source_has_agent: true,
    destination_has_agent: false,
    connectors: [],
    partner_items: 0,
    waitlist_count: 0,
    waitlist_moves: true,
    template_count: 0,
    templates_move: true,
    ...overrides,
  };
}

function renderBanner(
  activeAccount: { id: string; platform_username: string | null },
  queryClient?: QueryClient,
) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <BringOverSetupBanner activeAccount={activeAccount} />
      </QueryClientProvider>,
    ),
    queryClient: client,
  };
}

describe("BringOverSetupBanner", () => {
  const activeAccount = {
    id: "acc-active-1",
    platform_username: "xsellpoint",
  };

  const candidateWithSetup = {
    id: "cand-1",
    platform_username: "xsellpoint (old)",
    reason: "same_number" as const,
    from: {
      id: "cand-1",
      platform_username: "xsellpoint (old)",
    },
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
    mockCandidatesData.current = [];
    mockCandidatesFailed.current = false;
    mockPreviewData.current = createPreview();
    invokeSpy.mockResolvedValue({ data: { status: "moved" }, error: null });
  });

  it("a. no candidates → nothing rendered", () => {
    mockCandidatesData.current = [];
    mockPreviewData.current = createPreview();
    const { container } = renderBanner(activeAccount);
    expect(container.firstChild).toBeNull();
  });

  it("b. one candidate 'xsellpoint (old)' whose summary has agent_config 1, connectors 1, store_bindings 1, knowledge_sources 5, active 'xsellpoint' → the sentence 'xsellpoint (old) has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to xsellpoint?'", () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview();
    renderBanner(activeAccount);

    expect(
      screen.getByText(
        "xsellpoint (old) has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to xsellpoint?",
      ),
    ).toBeInTheDocument();
  });

  it("c. preview connector 'woo_store' (has_store_webhook true, name_clash false) as checked checkbox; source_has_agent true and destination_has_agent false → store-bound connector checkbox is DISABLED with hint 'The agent moves, so its store connector must move too'", () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      source_has_agent: true,
      destination_has_agent: false,
      connectors: [
        {
          name: "woo_store",
          connector_type: "woocommerce",
          has_store_webhook: true,
          name_clash: false,
          destination_has_store_webhook: false,
        },
      ],
    });

    renderBanner(activeAccount);

    const checkbox = screen.getByRole("checkbox", { name: /woo_store/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(
      screen.getByText("The agent moves, so its store connector must move too"),
    ).toBeInTheDocument();
  });

  it("d. connector 'woo_two' (has_store_webhook false, name_clash true, destination_has_store_webhook false) shows radio/select 'Replace the one here' / 'Keep the one here (skip)'; choosing skip", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      connectors: [
        {
          name: "woo_two",
          connector_type: "woocommerce",
          has_store_webhook: false,
          name_clash: true,
          destination_has_store_webhook: false,
        },
      ],
    });

    renderBanner(activeAccount);

    expect(screen.getByText(/Replace the one here/i)).toBeInTheDocument();
    const skipOption = screen.getByLabelText(/Keep the one here \(skip\)/i);
    expect(skipOption).toBeInTheDocument();

    fireEvent.click(skipOption);
    expect(skipOption).toBeChecked();
  });

  it("e. partner_items 3 → a 'Partner API keys and webhooks (3)' checkbox, unchecked by default", () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({ partner_items: 3 });

    renderBanner(activeAccount);

    const partnerCheckbox = screen.getByRole("checkbox", {
      name: /Partner API keys and webhooks \(3\)/i,
    });
    expect(partnerCheckbox).toBeInTheDocument();
    expect(partnerCheckbox).not.toBeChecked();
  });

  it("f. both have an agent → radio 'Keep this account's AI agent' (default) / 'Use the one from xsellpoint (old)'", () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      source_has_agent: true,
      destination_has_agent: true,
    });

    renderBanner(activeAccount);

    const keepRadio = screen.getByLabelText("Keep this account's AI agent");
    const useSourceRadio = screen.getByLabelText("Use the one from xsellpoint (old)");

    expect(keepRadio).toBeInTheDocument();
    expect(keepRadio).toBeChecked();
    expect(useSourceRadio).toBeInTheDocument();
    expect(useSourceRadio).not.toBeChecked();
  });

  it("g. clicking 'Move' invokes move_setup with exact choices object { agent_config: 'source', connectors: { 'woo_two': 'skip' }, partner: true }", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      source_has_agent: true,
      destination_has_agent: true,
      partner_items: 3,
      connectors: [
        {
          name: "woo_two",
          connector_type: "woocommerce",
          has_store_webhook: false,
          name_clash: true,
          destination_has_store_webhook: false,
        },
      ],
    });

    renderBanner(activeAccount);

    const partnerCheckbox = screen.getByRole("checkbox", {
      name: /Partner API keys and webhooks \(3\)/i,
    });
    fireEvent.click(partnerCheckbox);

    const skipOption = screen.getByLabelText(/Keep the one here \(skip\)/i);
    fireEvent.click(skipOption);

    const useSourceRadio = screen.getByLabelText("Use the one from xsellpoint (old)");
    fireEvent.click(useSourceRadio);

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: "cand-1",
          to: "acc-active-1",
          choices: {
            agent_config: "source",
            connectors: { woo_two: "skip" },
            partner: true,
          },
        },
      });
    }, { timeout: 250 });
  });

  it("h. on success: toast 'Setup moved', the card is hidden, and queryClient.invalidateQueries is called for ['whatsapp-setup-move-candidates'], ['whatsapp-setup-summary'], ['ai-agent-config'], ['ai-agent-tools']", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview();
    invokeSpy.mockResolvedValueOnce({
      data: { status: "moved" },
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderBanner(activeAccount, queryClient);

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Setup moved" }),
      );
    }, { timeout: 250 });

    await waitFor(() => {
      expect(
        screen.queryByText(/xsellpoint \(old\) has an AI agent/),
      ).not.toBeInTheDocument();
    }, { timeout: 250 });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["whatsapp-setup-move-candidates"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["whatsapp-setup-summary"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-agent-config"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-agent-tools"],
    });
  });

  it("i. error body { error: 'connector_name_clash' } shows 'A connector with the same name already exists here. Choose replace or skip for it.' and stays open", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview();
    invokeSpy.mockResolvedValueOnce({
      data: null,
      error: {
        name: "FunctionsHttpError",
        context: new Response(JSON.stringify({ error: "connector_name_clash" }), { status: 409 }),
      },
    });

    renderBanner(activeAccount);

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          "A connector with the same name already exists here. Choose replace or skip for it.",
        ),
      ).toBeInTheDocument();
    }, { timeout: 250 });

    expect(
      screen.getByText(/xsellpoint \(old\) has an AI agent/),
    ).toBeInTheDocument();
  });

  it("i. error body { error: 'order_in_flight' } shows 'An order message is being sent right now. Try again in a minute.' and stays open", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview();
    invokeSpy.mockResolvedValueOnce({
      data: null,
      error: {
        name: "FunctionsHttpError",
        context: new Response(JSON.stringify({ error: "order_in_flight" }), { status: 409 }),
      },
    });

    renderBanner(activeAccount);

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          "An order message is being sent right now. Try again in a minute.",
        ),
      ).toBeInTheDocument();
    }, { timeout: 250 });

    expect(
      screen.getByText(/xsellpoint \(old\) has an AI agent/),
    ).toBeInTheDocument();
  });

  it("l. unchecking a connector with no name clash and no store webhook sends connectors: { <name>: 'skip' } in the exact choices", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      connectors: [
        {
          name: "woo_plain",
          connector_type: "woocommerce",
          has_store_webhook: false,
          name_clash: false,
          destination_has_store_webhook: false,
        },
      ],
    });

    renderBanner(activeAccount);

    const checkbox = screen.getByRole("checkbox", { name: /woo_plain/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: "cand-1",
          to: "acc-active-1",
          choices: {
            agent_config: "source",
            connectors: { woo_plain: "skip" },
            partner: false,
          },
        },
      });
    }, { timeout: 250 });
  });

  it("m. a store-webhook connector unchecked BEFORE picking 'Use the one from …' becomes disabled AND re-checked, and sent choices do not contain skip", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      source_has_agent: true,
      destination_has_agent: true,
      connectors: [
        {
          name: "woo_store",
          connector_type: "woocommerce",
          has_store_webhook: true,
          name_clash: false,
          destination_has_store_webhook: false,
        },
      ],
    });

    renderBanner(activeAccount);

    const checkbox = screen.getByRole("checkbox", { name: /woo_store/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBeDisabled();

    // Owner unchecks BEFORE picking "Use the one from …"
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // Owner picks "Use the one from …"
    const useSourceRadio = screen.getByLabelText("Use the one from xsellpoint (old)");
    fireEvent.click(useSourceRadio);

    // Becomes disabled AND re-checked
    expect(checkbox).toBeDisabled();
    expect(checkbox).toBeChecked();

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: "cand-1",
          to: "acc-active-1",
          choices: {
            agent_config: "source",
            connectors: {},
            partner: false,
          },
        },
      });
    }, { timeout: 250 });
  });

  it("n. a name-clash connector whose preview has destination_has_store_webhook true defaults to 'skip' with 'Replace the one here' disabled; sent choices contain 'skip' for it", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      connectors: [
        {
          name: "woo_clash",
          connector_type: "woocommerce",
          has_store_webhook: false,
          name_clash: true,
          destination_has_store_webhook: true,
        },
      ],
    });

    renderBanner(activeAccount);

    const skipOption = screen.getByLabelText(/Keep the one here \(skip\)/i);
    const replaceOption = screen.getByLabelText(/Replace the one here/i);

    expect(skipOption).toBeChecked();
    expect(replaceOption).toBeDisabled();

    const moveButton = screen.getByRole("button", { name: /^Move$/i });
    fireEvent.click(moveButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "move_setup",
          from: "cand-1",
          to: "acc-active-1",
          choices: {
            agent_config: "source",
            connectors: { woo_clash: "skip" },
            partner: false,
          },
        },
      });
    }, { timeout: 250 });
  });

  it("j. preview waitlist_moves false with waitlist_count 3 → line '3 waitlisted customers stay — they agreed to messages from the old number'; templates_move false with template_count 2 → '2 message templates must be recreated on this account'", () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview({
      waitlist_count: 3,
      waitlist_moves: false,
      template_count: 2,
      templates_move: false,
    });

    renderBanner(activeAccount);

    expect(
      screen.getByText(
        "3 waitlisted customers stay — they agreed to messages from the old number",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 message templates must be recreated on this account",
      ),
    ).toBeInTheDocument();
  });

  it("k. 'Not now' invokes {action:'dismiss_setup_move', from, to} and hides the card", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    mockPreviewData.current = createPreview();
    invokeSpy.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    renderBanner(activeAccount);

    const notNowButton = screen.getByRole("button", { name: /Not now/i });
    fireEvent.click(notNowButton);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "dismiss_setup_move",
          from: "cand-1",
          to: "acc-active-1",
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByText(/xsellpoint \(old\) has an AI agent/),
      ).not.toBeInTheDocument();
    });
  });

  describe("store flows the kept agent has off (Codex review on PR #263)", () => {
    const storeConnector = {
      name: "woo_store",
      connector_type: "woocommerce",
      has_store_webhook: true,
      name_clash: false,
      destination_has_store_webhook: false,
    };

    it("o. keeping this account's agent warns about each store flow it has off, and the warning goes once the old agent is chosen", () => {
      mockCandidatesData.current = [candidateWithSetup];
      mockPreviewData.current = createPreview({
        source_has_agent: true,
        destination_has_agent: true,
        destination_agent_enabled: true,
        source_store_flows: ["cod_confirm", "review_request"],
        destination_store_flows: ["review_request"],
        connectors: [storeConnector],
      });

      renderBanner(activeAccount);

      const warning = screen.getByText(/This account's AI agent doesn't send/);
      expect(warning).toHaveTextContent("doesn't send order confirmations, so store orders");
      expect(warning).not.toHaveTextContent("review requests");

      fireEvent.click(screen.getByLabelText("Use the one from xsellpoint (old)"));
      expect(screen.queryByText(/This account's AI agent doesn't send/)).not.toBeInTheDocument();
    });

    it("p. an agent that is switched off here loses every store flow the old agent had on", () => {
      mockCandidatesData.current = [candidateWithSetup];
      mockPreviewData.current = createPreview({
        source_has_agent: true,
        destination_has_agent: true,
        destination_agent_enabled: false,
        source_store_flows: ["cod_confirm", "review_request"],
        destination_store_flows: ["cod_confirm", "review_request"],
        connectors: [storeConnector],
      });

      renderBanner(activeAccount);

      expect(screen.getByText(/This account's AI agent doesn't send/)).toHaveTextContent(
        "doesn't send order confirmations and review requests",
      );
    });

    it("q. no warning when no store webhook moves", () => {
      mockCandidatesData.current = [candidateWithSetup];
      mockPreviewData.current = createPreview({
        source_has_agent: true,
        destination_has_agent: true,
        destination_agent_enabled: true,
        source_store_flows: ["cod_confirm"],
        destination_store_flows: [],
        connectors: [{ ...storeConnector, has_store_webhook: false }],
      });

      renderBanner(activeAccount);

      expect(screen.queryByText(/This account's AI agent doesn't send/)).not.toBeInTheDocument();
    });
  });

  it("s. a failed candidates read says so and offers a retry instead of rendering nothing", () => {
    mockCandidatesFailed.current = true;

    renderBanner(activeAccount);

    expect(screen.getByText("Couldn't check for setup from an earlier WhatsApp connection.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(candidatesRefetch).toHaveBeenCalledTimes(1);
  });

  it("t. error body { error: 'linked_connector_name_clash' } explains the shared connector clash and stays open", async () => {
    mockCandidatesData.current = [candidateWithSetup];
    invokeSpy.mockResolvedValueOnce({ data: { error: "linked_connector_name_clash" }, error: null });

    renderBanner(activeAccount);
    fireEvent.click(screen.getByRole("button", { name: /^Move$/i }));

    expect(
      await screen.findByText(/A store connector shared with xsellpoint \(old\) has the same name as one on this account/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Move$/i })).toBeInTheDocument();
  });

  it("r. choices made for one old account never carry into the next candidate", async () => {
    const secondCandidate = {
      ...candidateWithSetup,
      id: "cand-2",
      platform_username: "xsellpoint (older)",
      from: { id: "cand-2", platform_username: "xsellpoint (older)" },
    };
    mockCandidatesData.current = [candidateWithSetup, secondCandidate];
    mockPreviewData.current = createPreview({ partner_items: 2 });
    invokeSpy.mockResolvedValueOnce({ data: { success: true }, error: null });

    renderBanner(activeAccount);

    fireEvent.click(screen.getByRole("checkbox", { name: /Partner API keys and webhooks \(2\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));

    await screen.findByText(/xsellpoint \(older\) has an AI agent/);
    expect(screen.getByRole("checkbox", { name: /Partner API keys and webhooks \(2\)/i })).not.toBeChecked();

    invokeSpy.mockResolvedValueOnce({ data: { status: "moved" }, error: null });
    fireEvent.click(screen.getByRole("button", { name: /^Move$/i }));
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenLastCalledWith("whatsapp-evolution-bridge", {
        body: expect.objectContaining({
          action: "move_setup",
          from: "cand-2",
          choices: expect.objectContaining({ partner: false }),
        }),
      });
    });
  });
});
