import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProceduresCard } from "../ProceduresCard";
import { eventEnableRefusal } from "@/lib/procedureTemplates";

const mocks = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  links: [] as Array<{ tool_id: string; social_account_id: string }>,
  linksReady: true,
  linksError: null as unknown,
  refetchLinks: vi.fn(),
  bindings: [] as Array<{ social_account_id: string; connector_id: string }> | undefined,
  bindingsLoading: false,
  bindingsError: false,
  refetchBindings: vi.fn(),
  messaging: vi.fn(async (_action: string, _body: Record<string, unknown>) => ({
    status: "pending",
    name: "postora_cod_confirm_v1",
    language: "ar",
    category: "UTILITY",
  })),
}));

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools: mocks.tools }),
  useAiToolAccountLinks: () => ({
    links: mocks.links,
    linksReady: mocks.linksReady,
    linksError: mocks.linksError,
    refetchLinks: mocks.refetchLinks,
  }),
}));
vi.mock("@/hooks/useStoreWebhookBindings", () => ({
  useStoreWebhookBindings: () => ({
    bindings: mocks.bindings,
    isLoading: mocks.bindingsLoading,
    isError: mocks.bindingsError,
    refetch: mocks.refetchBindings,
    createBinding: { isPending: false, mutateAsync: vi.fn() },
    rotateSecret: { isPending: false, mutateAsync: vi.fn() },
  }),
  storeWebhookUrl: (id: string) => `https://example.test/store-webhook/${id}`,
}));
vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: (action: string, body: Record<string, unknown>) => mocks.messaging(action, body),
}));

const readyForm = { is_enabled: true, default_mode: "ai_first" };

const setup = (procedures = {}, props: Record<string, unknown> = {}) => {
  const updateBehavior = vi.fn();
  render(
    <ProceduresCard
      form={readyForm as never}
      update={vi.fn()}
      behavior={{ procedures }}
      updateBehavior={updateBehavior}
      {...props}
    />,
  );
  return updateBehavior;
};

/** Applies each write, the way the settings form keeps the card's behavior. */
function liveCard(props: Record<string, unknown> = {}) {
  const seen: unknown[] = [];
  let procedures: Record<string, unknown> = {};
  const view = render(
    <ProceduresCard
      form={readyForm as never}
      update={vi.fn()}
      behavior={{ procedures }}
      updateBehavior={(_key, value) => {
        procedures = value as Record<string, unknown>;
        seen.push(value);
      }}
      {...props}
    />,
  );
  return {
    seen,
    rerender() {
      view.rerender(
        <ProceduresCard
          form={readyForm as never}
          update={vi.fn()}
          behavior={{ procedures }}
          updateBehavior={(_key, value) => {
            procedures = value as Record<string, unknown>;
            seen.push(value);
          }}
          {...props}
        />,
      );
    },
  };
}

describe("event enable refusals", () => {
  const base = {
    agentEnabled: true,
    defaultMode: "ai_first",
    connectionMode: "cloud_api",
    wooReadOnly: false,
    consentAttested: true,
    qrRiskAcknowledged: true,
    delayDays: 3,
    reviewUrl: "https://shop.example/reviews",
  };
  it.each([
    ["agent off", { agentEnabled: false }, "agent_disabled"],
    ["human first", { defaultMode: "human_first" }, "human_first"],
    ["read-only COD", { wooReadOnly: true }, "read_only"],
    ["consent missing", { consentAttested: false }, "consent_required"],
    ["QR risk missing", { connectionMode: "evolution_qr", qrRiskAcknowledged: false }, "qr_risk_required"],
    ["delay 15", { key: "review_request" as const, delayDays: 15 }, "review_delay"],
    ["delay -1", { key: "review_request" as const, delayDays: -1 }, "review_delay"],
    ["http review link", { key: "review_request" as const, reviewUrl: "http://shop.example/reviews" }, "review_url"],
  ] as const)("%s", (_name, patch, reason) => {
    expect(eventEnableRefusal({ key: "cod_confirm", ...base, ...patch })).toBe(reason);
  });

  it("allows a review request when the delay and https link are valid", () => {
    expect(eventEnableRefusal({ ...base, key: "review_request" })).toBeNull();
  });
});

describe("ProceduresCard", () => {
  beforeEach(() => {
    mocks.tools = [];
    mocks.links = [];
    mocks.linksReady = true;
    mocks.linksError = null;
    mocks.refetchLinks.mockClear();
    mocks.bindings = [];
    mocks.bindingsLoading = false;
    mocks.bindingsError = false;
    mocks.refetchBindings.mockClear();
    mocks.messaging.mockClear();
    mocks.messaging.mockResolvedValue({ status: "pending", name: "postora_cod_confirm_v1", language: "ar", category: "UTILITY" });
  });

  it("turning a flow on merges only that flow into procedures", () => {
    const updateBehavior = setup({ booking: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.click(screen.getByRole("switch", { name: /lead capture/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      booking: { enabled: true, prompts: {}, closing: "" },
      lead_capture: { enabled: true, prompts: {}, closing: "" },
    });
  });

  it("enabling the product finder seeds the two question slots the business must fill", () => {
    const updateBehavior = setup();
    fireEvent.click(screen.getByRole("switch", { name: /product finder/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      product_finder: { enabled: true, prompts: {}, closing: "", questions: ["", ""] },
    });
  });

  it("hides store-event toggles until the account is WhatsApp", () => {
    setup({ cod_confirm: { enabled: true, prompts: {}, closing: "" } });
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(screen.queryByRole("switch", { name: /cod order confirmation/i })).not.toBeInTheDocument();
  });

  it("shows the three event toggles on a WhatsApp account", () => {
    setup({}, { storeAccountId: "acc-1", connectionMode: "cloud_api" });
    expect(screen.getByRole("switch", { name: /cod order confirmation/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /review request/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /back in stock/i })).toBeInTheDocument();
  });

  it("refuses COD until the consent box is ticked, then stores the attestation", async () => {
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/consent/i);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    await waitFor(() => {
      const written = card.seen.at(-1) as { cod_confirm: { enabled: boolean; consent_attested_at?: string } };
      expect(written.cod_confirm.enabled).toBe(true);
      expect(written.cod_confirm.consent_attested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("refuses a QR event flow until the ban risk is acknowledged", () => {
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "evolution_qr" });
    fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/restrict numbers/i);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /restrict numbers/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    const written = card.seen.at(-1) as { cod_confirm: { enabled?: boolean; qr_risk_acknowledged_at?: string } };
    expect(written.cod_confirm.enabled).toBe(true);
    expect(written.cod_confirm.qr_risk_acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mocks.messaging.mock.calls.some((call) => call[1]?.create === true)).toBe(false);
  });

  it.each([
    ["account links are loading", () => {
      mocks.linksReady = false;
    }],
    ["webhook bindings are loading", () => {
      mocks.bindingsLoading = true;
      mocks.bindings = undefined;
    }],
  ])("disables COD while %s", (_name, arrange) => {
    arrange();
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    const toggle = screen.getByRole("switch", { name: /cod order confirmation/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/checking whether this store can update orders/i)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(card.seen).toEqual([]);
  });

  it.each([
    ["the account-link query fails", () => {
      mocks.linksError = new Error("links failed");
    }],
    ["the webhook-binding query fails", () => {
      mocks.bindingsError = true;
      mocks.bindings = undefined;
    }],
  ])("disables COD when %s", (_name, arrange) => {
    arrange();
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    const toggle = screen.getByRole("switch", { name: /cod order confirmation/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be checked/i);
    fireEvent.click(toggle);
    expect(card.seen).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(mocks.refetchLinks).toHaveBeenCalled();
    expect(mocks.refetchBindings).toHaveBeenCalled();
  });

  it("refuses COD while the WooCommerce connector is read-only", () => {
    mocks.tools = [{
      id: "woo-1",
      name: "Main shop",
      connector_type: "woocommerce",
      scope: "account",
      social_account_id: "acc-1",
      read_only_mode: true,
    }];
    mocks.bindings = [{ social_account_id: "acc-1", connector_id: "woo-1" }];
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Main shop/);
    expect(screen.getByRole("alert")).toHaveTextContent(/read-only/i);
    expect(card.seen.some((value) => (value as { cod_confirm?: { enabled?: boolean } }).cod_confirm?.enabled)).toBe(false);
  });

  it("refuses COD when any bound WooCommerce connector is read-only", () => {
    mocks.tools = [
      {
        id: "woo-write",
        name: "Writable shop",
        connector_type: "woocommerce",
        scope: "account",
        social_account_id: "acc-1",
        read_only_mode: false,
      },
      {
        id: "woo-read",
        name: "Catalog shop",
        connector_type: "woocommerce",
        scope: "account",
        social_account_id: "acc-1",
        read_only_mode: true,
      },
    ];
    mocks.bindings = [
      { social_account_id: "acc-1", connector_id: "woo-write" },
      { social_account_id: "acc-1", connector_id: "woo-read" },
    ];
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Catalog shop");
    expect(screen.getByRole("alert").textContent ?? "").not.toContain("Writable shop");
    expect(card.seen.some((value) => (value as { cod_confirm?: { enabled?: boolean } }).cod_confirm?.enabled)).toBe(false);
  });

  it("refuses a review request until the delay and https link are valid", async () => {
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    const reviewBox = () => screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[1];
    fireEvent.click(reviewBox());
    card.rerender();
    fireEvent.change(screen.getByLabelText(/review link/i), { target: { value: "http://shop.example/reviews" } });
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /review request/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/https/i);
    fireEvent.change(screen.getByLabelText(/review link/i), { target: { value: "https://shop.example/reviews" } });
    card.rerender();
    fireEvent.change(screen.getByLabelText(/days after delivery/i), { target: { value: "15" } });
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /review request/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/0 to 14/i);
    fireEvent.change(screen.getByLabelText(/days after delivery/i), { target: { value: "3" } });
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /review request/i }));
    await waitFor(() => {
      const written = card.seen.at(-1) as { review_request: { enabled: boolean; delay_days: number; review_url: string } };
      expect(written.review_request).toMatchObject({ enabled: true, delay_days: 3, review_url: "https://shop.example/reviews" });
    });
  });

  it.each(["cloud_api", "coexistence"] as const)(
    "enabling on %s submits the template and keeps the returned status",
    async (connectionMode) => {
      mocks.messaging.mockImplementation(async (_action: string, body: Record<string, unknown>) => (
        body.create === true
          ? { status: "approved", name: "postora_cod_confirm_v1", language: "ar", category: "UTILITY" }
          : { status: "missing", name: "", language: "ar", category: "" }
      ));
      const card = liveCard({ storeAccountId: "acc-1", connectionMode });
      fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
      card.rerender();
      fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
      await waitFor(() => {
        expect(mocks.messaging).toHaveBeenCalledWith("event_template_status", expect.objectContaining({
          social_account_id: "acc-1",
          flow: "cod_confirm",
          create: true,
        }));
        const written = card.seen.at(-1) as { cod_confirm?: { enabled?: boolean } };
        expect(written.cod_confirm?.enabled).toBe(true);
      });
      expect(screen.getByTestId("template-status-cod_confirm")).toHaveTextContent("approved");
    },
  );

  it.each([
    ["throws", async () => { throw new Error("template rejected"); }],
    ["returns rejected", async () => ({ status: "rejected", name: "postora_cod_confirm_v1", language: "ar", category: "UTILITY" })],
  ] as const)("a failed template submission (%s) leaves the flow disabled", async (_name, createResult) => {
    mocks.messaging.mockImplementation(async (_action: string, body: Record<string, unknown>) => {
      if (body.create === true) return createResult();
      return { status: "missing", name: "", language: "ar", category: "" };
    });
    const card = liveCard({ storeAccountId: "acc-1", connectionMode: "cloud_api" });
    fireEvent.click(screen.getAllByRole("checkbox", { name: /checkout collects customer consent/i })[0]);
    card.rerender();
    fireEvent.click(screen.getByRole("switch", { name: /cod order confirmation/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be submitted/i);
    expect(card.seen.some((value) => (value as { cod_confirm?: { enabled?: boolean } }).cod_confirm?.enabled)).toBe(false);
    expect(screen.getByRole("switch", { name: /cod order confirmation/i })).not.toBeChecked();
  });

  it("shows the template status and submits it", async () => {
    setup({}, { storeAccountId: "acc-1", connectionMode: "cloud_api" });
    expect(await screen.findAllByText("pending")).not.toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: /submit template/i })[0]);
    expect(mocks.messaging).toHaveBeenCalledWith("event_template_status", expect.objectContaining({
      social_account_id: "acc-1",
      flow: "cod_confirm",
      create: true,
    }));
  });

  it("editing a field prompt writes it under that field's name", () => {
    const updateBehavior = setup({ order_status: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.change(screen.getByLabelText(/order_number/i), { target: { value: "Your order number please" } });
    expect(updateBehavior).toHaveBeenLastCalledWith("procedures", {
      order_status: { enabled: true, prompts: { order_number: "Your order number please" }, closing: "" },
    });
  });
});
