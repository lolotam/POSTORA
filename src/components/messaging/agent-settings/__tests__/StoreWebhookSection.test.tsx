import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { StoreWebhookSection } from "../StoreWebhookSection";
import { storeWebhookUrl } from "@/hooks/useStoreWebhookBindings";

const ACCOUNT = "acc-1";
const CONNECTOR = "con-1";
const BINDING = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  links: [] as Array<{ tool_id: string; social_account_id: string }>,
  linksReady: true,
  bindings: [] as Array<Record<string, unknown>> | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools: mocks.tools }),
  useAiToolAccountLinks: () => ({
    links: mocks.links,
    linksReady: mocks.linksReady,
    linksError: null,
    setToolAccounts: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/hooks/useStoreWebhookBindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useStoreWebhookBindings")>();
  return {
    ...actual,
    useStoreWebhookBindings: () => ({
      bindings: mocks.bindings,
      isLoading: mocks.isLoading,
      isError: mocks.isError,
      refetch: mocks.refetch,
      createBinding: { mutateAsync: mocks.create, isPending: false },
      rotateSecret: { mutateAsync: mocks.rotate, isPending: false },
    }),
  };
});

const woo = {
  id: CONNECTOR,
  name: "Alpha",
  connector_type: "woocommerce",
  social_account_id: ACCOUNT,
  scope: "account" as const,
};
const issued = (secret: string) => ({ binding: { id: BINDING, connector_id: CONNECTOR }, secret });

describe("StoreWebhookSection", () => {
  beforeEach(() => {
    mocks.tools = [woo];
    mocks.links = [];
    mocks.linksReady = true;
    mocks.bindings = [];
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.refetch.mockReset();
    mocks.create.mockReset();
    mocks.rotate.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it("shows a WooCommerce connector explicitly shared to this account", () => {
    mocks.tools = [{ ...woo, social_account_id: "acc-other" }];
    mocks.links = [{ tool_id: CONNECTOR, social_account_id: ACCOUNT }];
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByTestId("store-webhook-section")).toBeInTheDocument();
  });

  it("hides a WooCommerce connector shared only with another account", () => {
    mocks.tools = [{ ...woo, social_account_id: "acc-other" }];
    mocks.links = [{ tool_id: CONNECTOR, social_account_id: "acc-3" }];
    const { container } = render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an account without a WooCommerce connector", () => {
    mocks.tools = [{ ...woo, connector_type: "shopify" }];
    const { container } = render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the three WooCommerce topics and the re-enable hint", () => {
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    for (const topic of ["Order created", "Order updated", "Product updated"]) {
      expect(screen.getByText(topic)).toBeInTheDocument();
    }
    expect(screen.getByText(/re-enable it/i)).toBeInTheDocument();
  });

  it("generating creates the binding for this account's connector and shows the secret once", async () => {
    mocks.create.mockResolvedValue(issued("s".repeat(43)));
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate webhook url and secret/i }));
    });
    expect(mocks.create).toHaveBeenCalledWith({ social_account_id: ACCOUNT, connector_id: CONNECTOR });
    expect(screen.getByLabelText(/webhook secret/i)).toHaveValue("s".repeat(43));
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
  });

  it("a connector bound to another WhatsApp account offers no generate or rotate", () => {
    mocks.bindings = [{ id: BINDING, connector_id: CONNECTOR, social_account_id: "acc-other" }];
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByText("This store connection is already linked to another WhatsApp account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate webhook url and secret/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rotate secret/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/delivery url/i)).not.toBeInTheDocument();
  });

  it("an existing binding shows its URL and rotates instead of creating", async () => {
    mocks.bindings = [{ id: BINDING, connector_id: CONNECTOR, social_account_id: ACCOUNT }];
    mocks.rotate.mockResolvedValue(issued("r".repeat(43)));
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByLabelText(/delivery url/i)).toHaveValue(storeWebhookUrl(BINDING));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    });
    expect(mocks.rotate).toHaveBeenCalledWith(BINDING);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/webhook secret/i)).toHaveValue("r".repeat(43));
  });

  it("a failed create shows the error and no secret", async () => {
    mocks.create.mockRejectedValue(new Error("down"));
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate webhook url and secret/i }));
    });
    expect(toast.error).toHaveBeenCalledWith("The webhook secret could not be created. Try again.");
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument();
  });

  it("a failed rotate shows the error and no secret", async () => {
    mocks.bindings = [{ id: BINDING, connector_id: CONNECTOR, social_account_id: ACCOUNT }];
    mocks.rotate.mockRejectedValue(new Error("down"));
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    });
    expect(toast.error).toHaveBeenCalledWith("The webhook secret could not be created. Try again.");
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument();
  });

  it("shows a loading state and does not offer generate while the list is loading", () => {
    mocks.isLoading = true;
    mocks.bindings = undefined;
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading the store webhook/i);
    expect(screen.queryByRole("button", { name: /generate webhook url and secret/i })).not.toBeInTheDocument();
  });

  it("shows an error with retry and does not offer generate when the list fails", () => {
    mocks.isError = true;
    mocks.bindings = undefined;
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByRole("button", { name: /generate webhook url and secret/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("offers generate only after a successful empty result", () => {
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    expect(screen.getByRole("button", { name: /generate webhook url and secret/i })).toBeInTheDocument();
  });

  it("renders one row per eligible WooCommerce connector, each with its own URL", () => {
    const second = "con-2";
    const binding2 = "22222222-2222-4222-8222-222222222222";
    mocks.tools = [
      woo,
      { ...woo, id: second, name: "Beta" },
    ];
    mocks.bindings = [
      { id: BINDING, connector_id: CONNECTOR, social_account_id: ACCOUNT },
      { id: binding2, connector_id: second, social_account_id: ACCOUNT },
    ];
    render(<StoreWebhookSection accountId={ACCOUNT} />);
    const rows = screen.getAllByTestId("store-webhook-connector");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByLabelText(/delivery url/i)).toHaveValue(storeWebhookUrl(BINDING));
    expect(within(rows[1]).getByLabelText(/delivery url/i)).toHaveValue(storeWebhookUrl(binding2));
  });

  it("switching account while a rotate is pending does not show that secret under the new account", async () => {
    let finish: (value: ReturnType<typeof issued>) => void = () => {};
    mocks.bindings = [{ id: BINDING, connector_id: CONNECTOR, social_account_id: ACCOUNT }];
    mocks.rotate.mockReturnValue(new Promise((resolve) => {
      finish = resolve;
    }));
    const { rerender } = render(<StoreWebhookSection accountId={ACCOUNT} />);
    fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    mocks.tools = [{ ...woo, social_account_id: "acc-2" }];
    mocks.bindings = [];
    rerender(<StoreWebhookSection accountId="acc-2" />);
    await act(async () => {
      finish(issued("r".repeat(43)));
    });
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument();
  });

  it("the secret is dropped when the account changes", async () => {
    mocks.create.mockResolvedValue(issued("s".repeat(43)));
    const { rerender } = render(<StoreWebhookSection accountId={ACCOUNT} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate webhook url and secret/i }));
    });
    mocks.tools = [{ ...woo, social_account_id: "acc-2" }];
    rerender(<StoreWebhookSection accountId="acc-2" />);
    expect(screen.queryByLabelText(/webhook secret/i)).not.toBeInTheDocument();
  });
});
