/** The Supabase Auth calls the 2FA disable flow needs, behind one seam so the hook stays testable. */

import { supabase } from "@/integrations/supabase/client";

export type AssuranceLevel = "aal1" | "aal2" | null;

export interface MfaGateway {
  currentLevel(): Promise<AssuranceLevel>;
  /** Raises the session to AAL2. Rejects on a wrong or expired code. */
  verify(factorId: string, code: string): Promise<void>;
  unenroll(factorId: string): Promise<void>;
  /** Drops the session back to AAL1 at once instead of at the next refresh. */
  refreshSession(): Promise<void>;
}

export const supabaseMfaGateway: MfaGateway = {
  async currentLevel() {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    return (data?.currentLevel as AssuranceLevel) ?? null;
  },
  async verify(factorId, code) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw error;
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
