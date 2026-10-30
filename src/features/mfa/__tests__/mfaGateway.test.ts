import { beforeEach, describe, expect, it, vi } from "vitest";

const challengeAndVerify = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { mfa: { challengeAndVerify: (...args: unknown[]) => challengeAndVerify(...args) } } },
}));

import { isInvalidCodeError, supabaseMfaGateway } from "../infrastructure/mfaGateway";

describe("supabaseMfaGateway.verify", () => {
  beforeEach(() => challengeAndVerify.mockReset());

  it("resolves verified when Supabase accepts the code", async () => {
    challengeAndVerify.mockResolvedValue({ data: {}, error: null });
    await expect(supabaseMfaGateway.verify("factor-1", "123456")).resolves.toBe("verified");
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "factor-1", code: "123456" });
  });

  it("resolves invalid_code only for GoTrue's wrong-code error", async () => {
    challengeAndVerify.mockResolvedValue({ data: null, error: { code: "mfa_verification_failed", message: "Invalid TOTP code entered" } });
    await expect(supabaseMfaGateway.verify("factor-1", "000000")).resolves.toBe("invalid_code");
  });

  it.each([
    ["a rate limit", { code: "over_request_rate_limit", message: "Too many requests" }],
    ["a missing factor", { code: "mfa_factor_not_found", message: "MFA factor not found" }],
    ["a rejecting hook", { code: "mfa_verification_rejected", message: "rejected" }],
    ["a server error", { code: "unexpected_failure", message: "boom" }],
  ])("rejects for %s instead of calling it a wrong code", async (_name, error) => {
    challengeAndVerify.mockResolvedValue({ data: null, error });
    await expect(supabaseMfaGateway.verify("factor-1", "123456")).rejects.toEqual(error);
  });
});

describe("isInvalidCodeError", () => {
  it("trusts the error code when there is one", () => {
    expect(isInvalidCodeError({ code: "mfa_verification_failed" })).toBe(true);
    expect(isInvalidCodeError({ code: "mfa_challenge_expired", message: "Invalid TOTP code entered" })).toBe(false);
  });

  it("falls back to the message for a server that sends no code", () => {
    expect(isInvalidCodeError({ message: "Invalid TOTP code entered" })).toBe(true);
    expect(isInvalidCodeError({ message: "Network request failed" })).toBe(false);
    expect(isInvalidCodeError({})).toBe(false);
  });
});
