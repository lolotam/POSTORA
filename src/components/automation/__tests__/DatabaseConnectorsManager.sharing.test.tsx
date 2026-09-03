import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAgentTool } from "@/hooks/useAiAgentTools";

// Account-scoped connectors (spec §12, §14, §9.1 items 3-4). The behaviours
// that must not regress:
//   - configured state is keyed by TOOL id, so two WooCommerce connectors on
//     one account show two independent states and each Edit opens its own
//     tool (a type-keyed map kept one arbitrary tool's state for both);
//   - every sharing toggle sends the COMPLETE account list — the RPC replaces
//     the whole link set, so a delta strips the connector from every other
//     agent (the exact regression AiKnowledgeManager.sharing.test.tsx covers);
//   - the owning account's box is checked and disabled: unticking it is a
//     change of owner, not a share;
//   - the Settings variant is a read-only overview with no write control at
//     all — an account-less write surface against an account-scoped table is
//     how unscoped rows get created.

const upsertTool = { mutate: vi.fn(), isPending: false };
const deleteTool = { mutate: vi.fn(), isPending: false };
let tools: AiAgentTool[] = [];
let links: Array<{ tool_id: string; social_account_id: string }> = [];
let linksReady = true;
const setToolAccounts = { mutateAsync: vi.fn().mockResolvedValue({}) };

vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools, isLoading: false, upsertTool, deleteTool }),
  useAiToolAccountLinks: () => ({ links, linksReady, linksError: null, setToolAccounts }),
}));

const ACCOUNTS = [
  { id: "wa-1", platform: "whatsapp", platform_username: "Xsellpoint", platform_user_id: null, is_active: true },
  { id: "wa-2", platform: "whatsapp", platform_username: "Second Number", platform_user_id: null, is_active: true },
  { id: "fb-1", platform: "facebook", platform_username: "Page A", platform_user_id: null, is_active: true },
  { id: "ig-1", platform: "instagram", platform_username: "xsellpoint_kw", platform_user_id: null, is_active: true },
  // No agent runs on TikTok: it must not get a sharing checkbox.
  { id: "tt-1", platform: "tiktok", platform_username: "xsellpoint_tt", platform_user_id: null, is_active: true },
];
let socialAccounts: {
  data: typeof ACCOUNTS | undefined;
  isSuccess: boolean;
  error: unknown;
} = { data: ACCOUNTS, isSuccess: true, error: null };
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => socialAccounts,
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
  url: "https://store.example/wp-json/wc/v3/products",
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

// Scoped to the card so two same-type connectors can be told apart by name.
const toolCardElement = (name: string): HTMLElement => {
  const card = screen.getByText(name).closest('[data-testid^="tool-card-"]');
  if (!card) throw new Error(`no tool card for ${name}`);
  return card as HTMLElement;
};

// within(), for querying inside one card. Kept separate from the element above:
// `expect(within(el)).toBeInTheDocument()` type-checks and always fails, because
// a query object is not a node -- the assertion looks right and asserts nothing.
const toolCard = (name: string) => within(toolCardElement(name));

// Anchored like the knowledge strip's helper: "Share <tool> with <account>".
const shareBox = (card: ReturnType<typeof toolCard>, account: string) =>
  card.getByRole("checkbox", { name: new RegExp(`with ${account}$`, "i") });

function renderManager(props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DatabaseConnectorsManager {...props} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("DatabaseConnectorsManager account scoping", () => {
  beforeEach(() => {
    upsertTool.mutate.mockReset();
    deleteTool.mutate.mockReset();
    setToolAccounts.mutateAsync.mockClear();
    setToolAccounts.mutateAsync.mockResolvedValue({});
    tools = [];
    links = [];
    linksReady = true;
    socialAccounts = { data: ACCOUNTS, isSuccess: true, error: null };
  });

  it("keys configured state by tool id: two same-type connectors stay independent", () => {
    // §9.1 item 3. With the map keyed by connector_type, the second
    // WooCommerce row overwrote the first, and Edit on either card opened
    // whichever row the Map happened to keep.
    tools = [
      tool({ id: "t-old", name: "woo_main", is_enabled: true, created_at: "2026-08-01T00:00:00Z", social_account_id: "fb-1", platform: "facebook" }),
      tool({ id: "t-new", name: "woo_outlet", is_enabled: false, created_at: "2026-08-02T00:00:00Z", social_account_id: "fb-1", platform: "facebook" }),
    ];
    renderManager({ platform: "facebook", accountId: "fb-1" });

    // Two independent states on two cards, not one arbitrary tool's state.
    expect(toolCard("woo_main").getByText("Active Tool")).toBeInTheDocument();
    expect(toolCard("woo_outlet").getByText("Disabled")).toBeInTheDocument();

    // Edit on the FIRST card opens that tool — the type-keyed map opened the
    // second one, silently editing the wrong store.
    fireEvent.click(toolCard("woo_main").getByRole("button", { name: /edit/i }));
    expect(screen.getByLabelText(/tool name/i)).toHaveValue("woo_main");
  });

  it("sends the complete account list on every sharing toggle", () => {
    // The RPC REPLACES the whole link set. Page A is already linked; ticking
    // Instagram must send both — and must NOT send the owning WhatsApp
    // account, which resolves through social_account_id instead.
    tools = [tool({ id: "t1", name: "woo_store" })];
    links = [{ tool_id: "t1", social_account_id: "fb-1" }];
    renderManager({ platform: "whatsapp", accountId: "wa-1" });

    fireEvent.click(shareBox(toolCard("woo_store"), "xsellpoint_kw"));

    expect(setToolAccounts.mutateAsync).toHaveBeenCalledWith({
      toolId: "t1",
      socialAccountIds: ["fb-1", "ig-1"],
    });
  });

  it("renders the owning account's checkbox checked and disabled", () => {
    tools = [tool({ id: "t1", name: "woo_store" })];
    links = [{ tool_id: "t1", social_account_id: "fb-1" }];
    renderManager({ platform: "whatsapp", accountId: "wa-1" });

    const ownerBox = shareBox(toolCard("woo_store"), "Xsellpoint");
    expect(ownerBox).toBeChecked();
    expect(ownerBox).toBeDisabled();
    // The control itself has to say WHY it is locked: unticking the owner is
    // a change of owner, not a share.
    expect(ownerBox.closest("label")?.getAttribute("title")).toMatch(/owner/i);
    // The other shares stay live checkboxes.
    expect(shareBox(toolCard("woo_store"), "Page A")).toBeEnabled();
  });

  it("surfaces a 400's own message and sends the owning account on save", () => {
    // Unknown connector_type now answers 400 naming the type instead of a
    // silent custom_rest downgrade; the user must see that message. And the
    // save itself must name the account the form was opened for — the server
    // refuses an account-less write, which is the point of the dropdown.
    upsertTool.mutate.mockImplementation(
      (_payload: unknown, options: { onError: (e: Error) => void }) =>
        options.onError(new Error("Unknown connector type 'stripe_v2'")),
    );
    renderManager({ platform: "facebook", accountId: "fb-1" });

    fireEvent.click(screen.getByText("Stripe Payments"));
    // The registry marks Stripe's key required: satisfy it so this test keeps
    // proving what it exists to prove (the 400's own message surfacing and
    // the owning account being sent), not the required-field block, which the
    // credentials suite covers.
    fireEvent.change(screen.getByLabelText("Restricted API key"), { target: { value: "rk_test_fill" } });
    fireEvent.click(screen.getByRole("button", { name: /save & connect/i }));

    const payload = upsertTool.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.social_account_id).toBe("fb-1");
    expect(screen.getByText("Unknown connector type 'stripe_v2'")).toBeInTheDocument();
  });

  it("renders an account dropdown that scopes the connector list", async () => {
    tools = [
      tool({ id: "t1", name: "woo_first", social_account_id: "wa-1", platform: "whatsapp" }),
      tool({ id: "t2", name: "woo_second", social_account_id: "wa-2", platform: "whatsapp" }),
    ];
    renderManager({ platform: "whatsapp" });

    // Defaults to the first active account on the platform, like the agent
    // settings tab's own dropdown.
    expect(toolCardElement("woo_first")).toBeInTheDocument();
    expect(screen.queryByText("woo_second")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("connector-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Second Number" }));

    expect(screen.queryByText("woo_first")).not.toBeInTheDocument();
    expect(toolCardElement("woo_second")).toBeInTheDocument();
  });
});

describe("DatabaseConnectorsManager read-only overview (Settings)", () => {
  beforeEach(() => {
    upsertTool.mutate.mockReset();
    deleteTool.mutate.mockReset();
    setToolAccounts.mutateAsync.mockClear();
    tools = [];
    links = [];
    linksReady = true;
    socialAccounts = { data: ACCOUNTS, isSuccess: true, error: null };
  });

  it("exposes no save, delete or add control — only an overview with edit links", () => {
    tools = [
      tool({ id: "t-wa", name: "woo_main", social_account_id: "wa-1", platform: "whatsapp" }),
      tool({ id: "t-fb", name: "woo_page", social_account_id: "fb-1", platform: "facebook" }),
      tool({
        id: "t-all",
        name: "legacy_global",
        scope: "all_accounts",
        social_account_id: null,
        platform: null,
      }),
    ];
    links = [{ tool_id: "t-wa", social_account_id: "ig-1" }];
    const { container } = renderManager({ readOnly: true }) as { container: HTMLElement };

    // The whole point of §14: no *tool* write control may render. Not hidden
    // buttons — none in the tree. Workspace connection controls are the one
    // documented exception: the connection is the credential and Settings is
    // where it lives, so readOnly hides the tool form, not those (spec §9.1).
    for (const group of screen.getAllByTestId(/^overview-account-/)) {
      expect(group.querySelector("button")).toBeNull();
    }
    for (const button of container.querySelectorAll("button")) {
      expect(button.closest('[data-testid^="composio-card-"]')).not.toBeNull();
    }

    // Grouped by owning account, with each account's connectors under it.
    const waGroup = screen.getByTestId("overview-account-wa-1");
    expect(within(waGroup).getByText("woo_main")).toBeInTheDocument();
    const fbGroup = screen.getByTestId("overview-account-fb-1");
    expect(within(fbGroup).getByText("woo_page")).toBeInTheDocument();
    // The all_accounts legacy row has no owner, so it sits in its own group.
    expect(screen.getByTestId("overview-account-all").textContent).toContain("legacy_global");

    // Link-through lands on that account's agent tools tab.
    expect(
      within(fbGroup).getByRole("link", { name: /edit/i }).getAttribute("href"),
    ).toBe("/automation/agents?platform=facebook&tab=tools&account=fb-1");
  });
});
