import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { WhatsAppQrScanner } from "../WhatsAppQrScanner";

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

vi.mock("@/i18n", () => ({}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke },
  },
}));

describe("WhatsAppQrScanner mismatch handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows mismatch card with last4, action buttons, and does not show success card or call onComplete", async () => {
    invoke.mockResolvedValue({
      data: {
        success: true,
        social_account_id: "acc-qr-1",
        qr: null,
        state: "number_mismatch",
        expected_last4: "0350",
      },
      error: null,
    });

    const onComplete = vi.fn();
    const onConnectAsNew = vi.fn();

    render(
      <WhatsAppQrScanner
        socialAccountId="acc-qr-1"
        onComplete={onComplete}
        onConnectAsNew={onConnectAsNew}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("You scanned a different phone. This connection belongs to the number ending 0350."),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Scan the right phone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect as a new account" })).toBeInTheDocument();

    expect(screen.queryByText(/WhatsApp connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your Direct QR session is now active/i)).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    // Clicking "Connect as a new account" invokes onConnectAsNew
    fireEvent.click(screen.getByRole("button", { name: "Connect as a new account" }));
    expect(onConnectAsNew).toHaveBeenCalledTimes(1);

    // Clicking "Scan the right phone" invokes reconnect_qr and resets
    fireEvent.click(screen.getByRole("button", { name: "Scan the right phone" }));
    expect(invoke).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
      body: {
        action: "reconnect_qr",
        social_account_id: "acc-qr-1",
      },
    });
  });
});
