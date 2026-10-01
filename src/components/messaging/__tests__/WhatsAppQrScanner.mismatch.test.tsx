import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.useRealTimers();
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

  it("poll returns number_mismatch then open: after waiting > 1.5s, onComplete is never called and no success card appears", async () => {
    vi.useFakeTimers();

    invoke
      .mockResolvedValueOnce({
        data: {
          success: true,
          social_account_id: "acc-qr-1",
          qr: null,
          state: "number_mismatch",
          expected_last4: "0350",
        },
        error: null,
      })
      .mockResolvedValue({
        data: {
          success: true,
          social_account_id: "acc-qr-1",
          qr: null,
          state: "open",
        },
        error: null,
      });

    const onComplete = vi.fn();

    render(
      <WhatsAppQrScanner
        socialAccountId="acc-qr-1"
        onComplete={onComplete}
      />,
    );

    // Let the initial poll resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText("You scanned a different phone. This connection belongs to the number ending 0350."),
    ).toBeInTheDocument();

    // Advance 2s to trigger next poll which returns open
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Advance > 1.5s (the completion delay)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.queryByText(/WhatsApp connected/i)).not.toBeInTheDocument();
  });

  it("clicking 'Scan the right phone' with reconnect_qr mocked to return a QR: mismatch card disappears and QR image is shown", async () => {
    invoke
      .mockResolvedValueOnce({
        data: {
          success: true,
          social_account_id: "acc-qr-1",
          qr: null,
          state: "number_mismatch",
          expected_last4: "0350",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          social_account_id: "acc-qr-1",
          qr: "fresh-reconnect-qr-code",
          state: "connecting",
        },
        error: null,
      });

    render(
      <WhatsAppQrScanner
        socialAccountId="acc-qr-1"
        onComplete={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("You scanned a different phone. This connection belongs to the number ending 0350."),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Scan the right phone" }));

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "WhatsApp connection QR code" })).toBeInTheDocument();
    });

    expect(
      screen.queryByText("You scanned a different phone. This connection belongs to the number ending 0350."),
    ).not.toBeInTheDocument();
  });

  it("NEW: 'Connect as a new account' is NOT rendered when onConnectAsNew is not passed", async () => {
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

    render(
      <WhatsAppQrScanner
        socialAccountId="acc-qr-1"
        onComplete={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("You scanned a different phone. This connection belongs to the number ending 0350."),
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Connect as a new account" })).not.toBeInTheDocument();
  });

  it("NEW: a poll answer that started before 'Scan the right phone' and resolves after it with number_mismatch is ignored", async () => {
    vi.useFakeTimers();

    let resolveLatePoll!: (value: any) => void;
    const latePollPromise = new Promise((resolve) => {
      resolveLatePoll = resolve;
    });

    let pollCount = 0;
    invoke.mockImplementation((fn: string, options: any) => {
      if (options?.body?.action === "reconnect_qr") {
        return Promise.resolve({
          data: {
            success: true,
            social_account_id: "acc-qr-1",
            qr: "fresh-qr-base64",
            state: "connecting",
          },
          error: null,
        });
      }
      if (options?.body?.action === "get_qr_status") {
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve({
            data: {
              success: true,
              social_account_id: "acc-qr-1",
              qr: null,
              state: "number_mismatch",
              expected_last4: "0350",
            },
            error: null,
          });
        }
        return latePollPromise;
      }
      return Promise.resolve({ data: {}, error: null });
    });

    render(
      <WhatsAppQrScanner
        socialAccountId="acc-qr-1"
        onComplete={vi.fn()}
      />,
    );

    // Let the initial poll resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText("You scanned a different phone. This connection belongs to the number ending 0350."),
    ).toBeInTheDocument();

    // Advance 2s to trigger next poll which returns latePollPromise (in flight)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(pollCount).toBe(2);

    // User clicks "Scan the right phone"
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scan the right phone" }));
    });

    expect(screen.getByRole("img", { name: "WhatsApp connection QR code" })).toBeInTheDocument();

    // Now late poll resolves with number_mismatch
    await act(async () => {
      resolveLatePoll({
        data: {
          success: true,
          social_account_id: "acc-qr-1",
          qr: null,
          state: "number_mismatch",
          expected_last4: "0350",
        },
        error: null,
      });
    });

    // The scanner must ignore the stale poll and keep displaying the new QR
    expect(screen.getByRole("img", { name: "WhatsApp connection QR code" })).toBeInTheDocument();
    expect(
      screen.queryByText("You scanned a different phone. This connection belongs to the number ending 0350."),
    ).not.toBeInTheDocument();
  });
});
