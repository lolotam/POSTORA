import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";
import {
  DeleteWhatsAppAccountDialog,
  type DeleteWhatsAppAccountDialogProps,
} from "../DeleteWhatsAppAccountDialog";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars || typeof vars !== "object") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

vi.mock("@/hooks/useWhatsAppSetupSummary", () => ({
  useWhatsAppSetupSummary: vi.fn(),
}));

const mockSummaryData = {
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
};

const sampleAccount = {
  id: "wa-acc-123",
  platform_username: "xsellpoint",
  platform_user_id: "96597950350",
};

function renderDialog(props: DeleteWhatsAppAccountDialogProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  const utils = render(<DeleteWhatsAppAccountDialog {...props} />, {
    wrapper: Wrapper,
  });

  return {
    ...utils,
    rerender: (nextProps: DeleteWhatsAppAccountDialogProps) =>
      utils.rerender(<DeleteWhatsAppAccountDialog {...nextProps} />),
  };
}

describe("DeleteWhatsAppAccountDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWhatsAppSetupSummary).mockReturnValue({
      data: mockSummaryData,
      isLoading: false,
    } as any);
  });

  it("renders nothing when account is null", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    const { container } = renderDialog({
      account: null,
      onCancel,
      onConfirm,
    });

    expect(
      screen.queryByText(/This permanently deletes the account and its AI agent setup/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("renders warning, account name, summary lines, and WhatsApp page link when account is set", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    renderDialog({
      account: sampleAccount,
      onCancel,
      onConfirm,
    });

    expect(
      screen.getByText(/This permanently deletes the account and its AI agent setup/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/xsellpoint/i)).toBeInTheDocument();

    expect(screen.getByText("AI agent settings")).toBeInTheDocument();
    expect(screen.getByText("1 connector")).toBeInTheDocument();
    expect(screen.getByText("1 store webhook")).toBeInTheDocument();
    expect(screen.getByText("5 knowledge sources")).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /Disconnect it on the WhatsApp page instead/i,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/messaging/whatsapp/setup");
  });

  it("calls onConfirm once with account id on confirm, and calls onCancel on cancel", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    renderDialog({
      account: sampleAccount,
      onCancel,
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("wa-acc-123");

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows 23503 error text and stays open when onConfirm rejects with code 23503", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue({ code: "23503" });

    renderDialog({
      account: sampleAccount,
      onCancel,
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    fireEvent.click(confirmBtn);

    expect(
      await screen.findByText(
        "This account can't be deleted while connectors or partner integrations use it. Disconnect it from the WhatsApp page instead.",
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/This permanently deletes the account and its AI agent setup/i),
    ).toBeInTheDocument();
  });

  it("shows generic error text and stays open when onConfirm rejects with another error", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error("unexpected error"));

    renderDialog({
      account: sampleAccount,
      onCancel,
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    fireEvent.click(confirmBtn);

    expect(
      await screen.findByText("The account could not be deleted. Try again."),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/This permanently deletes the account and its AI agent setup/i),
    ).toBeInTheDocument();
  });

  it("disables the confirm button while onConfirm is pending and ignores a second click", async () => {
    let finish: () => void = () => {};
    const pendingPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onConfirm = vi.fn().mockReturnValue(pendingPromise);

    renderDialog({
      account: sampleAccount,
      onCancel: vi.fn(),
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    expect(confirmBtn).toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    finish();
  });

  it("disables the confirm button while setup summary is loading and does not call onConfirm on click", () => {
    vi.mocked(useWhatsAppSetupSummary).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as any);

    const onConfirm = vi.fn().mockResolvedValue(undefined);

    renderDialog({
      account: sampleAccount,
      onCancel: vi.fn(),
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    expect(confirmBtn).toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables confirm button and shows warning message when setup summary query fails", () => {
    vi.mocked(useWhatsAppSetupSummary).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as any);

    const onConfirm = vi.fn().mockResolvedValue(undefined);

    renderDialog({
      account: sampleAccount,
      onCancel: vi.fn(),
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    expect(confirmBtn).toBeDisabled();

    expect(
      screen.getByText("We couldn't load what is attached to this account. Try again later."),
    ).toBeInTheDocument();

    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clears error text when re-rendered with null account and then a different account", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error("unexpected error"));

    const { rerender } = renderDialog({
      account: sampleAccount,
      onCancel,
      onConfirm,
    });

    const confirmBtn = screen.getByRole("button", { name: /delete account/i });
    fireEvent.click(confirmBtn);

    expect(
      await screen.findByText("The account could not be deleted. Try again."),
    ).toBeInTheDocument();

    rerender({
      account: null,
      onCancel,
      onConfirm,
    });

    expect(
      screen.queryByText("The account could not be deleted. Try again."),
    ).not.toBeInTheDocument();

    rerender({
      account: {
        id: "wa-acc-999",
        platform_username: "otheraccount",
        platform_user_id: "96599999999",
      },
      onCancel,
      onConfirm,
    });

    expect(screen.getByText(/otheraccount/i)).toBeInTheDocument();
    expect(
      screen.queryByText("The account could not be deleted. Try again."),
    ).not.toBeInTheDocument();
  });
});
