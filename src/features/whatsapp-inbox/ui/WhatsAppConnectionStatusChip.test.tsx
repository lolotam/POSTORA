import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingAccount } from "@/hooks/useMessaging";
import { WhatsAppConnectionStatusChip } from "./WhatsAppConnectionStatusChip";

vi.mock("@/components/messaging/WhatsAppSetup", () => ({
  WhatsAppSetup: () => <div>WhatsApp setup content</div>,
}));

vi.mock("@/components/messaging/WhatsAppCoexistenceSetupBanner", () => ({
  WhatsAppCoexistenceSetupBanner: () => <div>Coexistence setup</div>,
}));

const account: MessagingAccount = {
  id: "account-1",
  platform: "whatsapp",
  platform_user_id: "96550000000",
  platform_username: "Support",
  avatar_url: null,
  connection_mode: "evolution_qr",
};

describe("WhatsAppConnectionStatusChip", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts collapsed when an account is connected", () => {
    render(<WhatsAppConnectionStatusChip connectedAccounts={[account]} selectedAccountId={account.id} />);
    expect(screen.getByRole("button", { name: /connection details/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Support")).toBeInTheDocument();
    expect(screen.getByText("Direct QR")).toBeInTheDocument();
    expect(screen.queryByText("WhatsApp setup content")).not.toBeInTheDocument();
  });

  it("persists the expanded state", () => {
    const { unmount } = render(
      <WhatsAppConnectionStatusChip connectedAccounts={[account]} selectedAccountId={account.id} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /connection details/i }));
    expect(window.localStorage.getItem("postora.whatsapp.setupExpanded")).toBe("true");
    unmount();

    render(<WhatsAppConnectionStatusChip connectedAccounts={[account]} selectedAccountId={account.id} />);
    expect(screen.getByRole("button", { name: /connection details/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("is expanded and non-collapsible with no connected account", () => {
    render(<WhatsAppConnectionStatusChip connectedAccounts={[]} />);
    expect(screen.getByTestId("wa-setup-panel")).toBeVisible();
    expect(screen.getByText("WhatsApp setup content")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connection details/i })).not.toBeInTheDocument();
  });

  it("renders when localStorage access throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    expect(() =>
      render(<WhatsAppConnectionStatusChip connectedAccounts={[account]} selectedAccountId={account.id} />),
    ).not.toThrow();
    expect(screen.getByText("Support")).toBeInTheDocument();
  });
});
