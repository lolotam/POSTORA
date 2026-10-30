/** The Supabase Auth calls the 2FA disable flow needs, behind one seam so the hook stays testable. */

import { supabase } from "@/integrations/supabase/client";

export type AssuranceLevel = "aal1" | "aal2" | null;

/** `invalid_code` is a wrong or expired authenticator code; every other failure rejects. */
export type VerifyOutcome = "verified" | "invalid_code";

export interface MfaGateway {
  currentLevel(): Promise<AssuranceLevel>;
  /**
   * Raises the session to AAL2. Resolves `invalid_code` for a wrong code and rejects for
   * anything else (network, rate limit, a missing factor), which is not the user's mistake.
   */
  verify(factorId: string, code: string): Promise<VerifyOutcome>;
  unenroll(factorId: string): Promise<void>;
  /** Drops the session back to AAL1 at once instead of at the next refresh. */
  refreshSession(): Promise<void>;
}

/**
 * GoTrue answers a wrong TOTP code with `mfa_verification_failed` (supported by the locked
 * @supabase/auth-js). A server too old to send a code is recognised by its message instead.
 */
export function isInvalidCodeError(error: { code?: string; message?: string }): boolean {
  if (error.code) return error.code === "mfa_verification_failed";
  return /invalid totp code/i.test(error.message ?? "");
}

export const supabaseMfaGateway: MfaGateway = {
  async currentLevel() {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    return (data?.currentLevel as AssuranceLevel) ?? null;
  },
  async verify(factorId, code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (!error) return "verified";
    if (isInvalidCodeError(error)) return "invalid_code";
    throw error;
  },
  async unenroll(factorId) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) throw error;
  },
  async refreshSession() {
    const { error } = await supabase.auth.refreshSession();
    if (error) throw error;
  },
};
