import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { StoreWebhookSection } from "../StoreWebhookSection";
import { storeWebhookUrl } from "@/hooks/useStoreWebhookBindings";

const ACCOUNT = "acc-1";
const CONNECTOR = "con-1";
const BINDING = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  bindings: [] as Array<Record<string, unknown>> | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useAiAgentTools", () => ({ useAiAgentTools: () => ({ tools: mocks.tools }) }));
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

const woo = { id: CONNECTOR, connector_type: "woocommerce", social_account_id: ACCOUNT, scope: "account" };
const issued = (secret: string) => ({ binding: { id: BINDING, connector_id: CONNECTOR }, secret });

describe("StoreWebhookSection", () => {
  beforeEach(() => {
    mocks.tools = [woo];
    mocks.bindings = [];
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.refetch.mockReset();
    mocks.create.mockReset();
    mocks.rotate.mockReset();
    vi.mocked(toast.error).mockClear();
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
