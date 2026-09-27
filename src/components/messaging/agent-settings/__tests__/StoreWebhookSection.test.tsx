import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StoreWebhookSection } from "../StoreWebhookSection";

const ACCOUNT = "acc-1";
const CONNECTOR = "con-1";
const BINDING = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  bindings: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("@/hooks/useAiAgentTools", () => ({ useAiAgentTools: () => ({ tools: mocks.tools }) }));
vi.mock("@/hooks/useStoreWebhookBindings", () => ({
  storeWebhookUrl: (id: string) => `https://api.postora.cloud/functions/v1/store-webhook/${id}`,
  useStoreWebhookBindings: () => ({
    bindings: mocks.bindings,
    createBinding: { mutateAsync: mocks.create, isPending: false },
    rotateSecret: { mutateAsync: mocks.rotate, isPending: false },
  }),
}));

const woo = { id: CONNECTOR, connector_type: "woocommerce", social_account_id: ACCOUNT, scope: "account" };
const issued = (secret: string) => ({ binding: { id: BINDING, connector_id: CONNECTOR }, secret });

describe("StoreWebhookSection", () => {
  beforeEach(() => {
    mocks.tools = [woo];
    mocks.bindings = [];
    mocks.create.mockReset();
    mocks.rotate.mockReset();
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
    expect(screen.getByLabelText(/delivery url/i)).toHaveValue(
      `https://api.postora.cloud/functions/v1/store-webhook/${BINDING}`,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    });
    expect(mocks.rotate).toHaveBeenCalledWith(BINDING);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/webhook secret/i)).toHaveValue("r".repeat(43));
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
