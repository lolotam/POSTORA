import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const listFactors = vi.fn();
const unenroll = vi.fn();
const getAal = vi.fn();
const refreshSession = vi.fn();
const challengeAndVerify = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      refreshSession: (...args: unknown[]) => refreshSession(...args),
      mfa: {
        listFactors: (...args: unknown[]) => listFactors(...args),
        unenroll: (...args: unknown[]) => unenroll(...args),
        getAuthenticatorAssuranceLevel: (...args: unknown[]) => getAal(...args),
        challengeAndVerify: (...args: unknown[]) => challengeAndVerify(...args),
      },
    },
  },
}));

import { MFASection } from "../MFASection";

const UNVERIFIED = { id: "f-un", friendly_name: "Authenticator App", factor_type: "totp", status: "unverified", created_at: "2026-10-01T00:00:00Z" };
const VERIFIED = { id: "f-ok", friendly_name: "Phone", factor_type: "totp", status: "verified", created_at: "2026-09-01T00:00:00Z" };

describe("MFASection unfinished setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unenroll.mockResolvedValue({ data: {}, error: null });
    getAal.mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
  });

  it("lists an unverified factor even when nothing is verified, and removes it without a code", async () => {
    listFactors.mockResolvedValueOnce({ data: { totp: [UNVERIFIED] }, error: null });
    listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    render(<MFASection />);

    const remove = await screen.findByRole("button", { name: "Remove unfinished setup" });
    expect(screen.getByText("Set up 2FA")).toBeInTheDocument();
    fireEvent.click(remove);

    await waitFor(() => expect(unenroll).toHaveBeenCalledWith({ factorId: "f-un" }));
    // An AAL1 session may remove an unverified factor directly: no step-up, no code dialog.
    expect(getAal).not.toHaveBeenCalled();
    expect(challengeAndVerify).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("000000")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("unfinished-mfa-setup")).not.toBeInTheDocument());
  });

  it("shows no unfinished-setup block when every factor is verified", async () => {
    listFactors.mockResolvedValue({ data: { totp: [VERIFIED] }, error: null });
    render(<MFASection />);

    expect(await screen.findByText("2FA is enabled")).toBeInTheDocument();
    expect(screen.queryByTestId("unfinished-mfa-setup")).not.toBeInTheDocument();
  });

  it("shows both a verified factor and a leftover unverified one", async () => {
    listFactors.mockResolvedValue({ data: { totp: [VERIFIED, UNVERIFIED] }, error: null });
    render(<MFASection />);

    expect(await screen.findByText("2FA is enabled")).toBeInTheDocument();
    expect(screen.getByTestId("unfinished-mfa-setup")).toBeInTheDocument();
  });
});
