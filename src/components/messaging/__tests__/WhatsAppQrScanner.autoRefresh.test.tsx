import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppQrScanner } from "../WhatsAppQrScanner";

vi.mock("@/i18n", () => ({}));

// react-i18next hands out a stable t; a fresh one per render would re-run the poll effect.
const translate = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke } },
}));

const QR_LIFETIME_MS = 45_000;

function refreshCalls(): number {
  return invoke.mock.calls.filter(([, options]) => options?.body?.refresh_qr === true).length;
}

describe("WhatsAppQrScanner expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces an unscanned code by itself when it expires", async () => {
    invoke.mockResolvedValue({ data: { qr: "qr-code", state: "connecting" }, error: null });

    render(<WhatsAppQrScanner socialAccountId="acc-1" onComplete={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QR_LIFETIME_MS - 1000);
    });
    expect(refreshCalls()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(refreshCalls()).toBe(1);
  });

  it("tries a failed renewal once, then leaves the retry to the owner", async () => {
    invoke.mockImplementation(async (_name: string, options: { body: { refresh_qr?: boolean } }) => (
      options.body.refresh_qr
        ? { data: { error: "Evolution unavailable" }, error: null }
        : { data: { qr: "qr-code", state: "connecting" }, error: null }
    ));

    render(<WhatsAppQrScanner socialAccountId="acc-1" onComplete={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QR_LIFETIME_MS + 10_000);
    });
    expect(refreshCalls()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh QR code" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshCalls()).toBe(2);
  });

  it("does not refresh the code once the phone has connected", async () => {
    invoke.mockResolvedValue({ data: { qr: null, state: "open" }, error: null });

    render(<WhatsAppQrScanner socialAccountId="acc-1" onComplete={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QR_LIFETIME_MS + 5000);
    });
    expect(refreshCalls()).toBe(0);
  });
});
