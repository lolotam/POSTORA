import { useCallback, useState } from "react";
import { supabaseMfaGateway, type MfaGateway } from "../infrastructure/mfaGateway";

/**
 * Disabling a verified 2FA factor needs an AAL2 session: Supabase refuses
 * `unenroll` otherwise ("AAL2 required to unenroll verified factor"). An AAL2
 * session unenrolls at once; an AAL1 session is first asked for an
 * authenticator code, which `challengeAndVerify` uses to step it up.
 *
 * An unverified factor never needs that: Supabase lets an AAL1 session remove it
 * directly, and the user may have no authenticator to prove it with.
 */
export interface DisableMfaOptions {
  onDisabled: () => void | Promise<void>;
  onError: (message: string) => void;
  gateway?: MfaGateway;
}

/** The part of a listed factor the disable flow needs. */
export interface DisableMfaFactor {
  id: string;
  status: string;
}

export function useDisableMfa({ onDisabled, onError, gateway = supabaseMfaGateway }: DisableMfaOptions) {
  const [busyFactorId, setBusyFactorId] = useState<string | null>(null);
  const [pendingFactorId, setPendingFactorId] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const finish = useCallback(async (factorId: string, { refresh }: { refresh: boolean }) => {
    await gateway.unenroll(factorId);
    // The factor is gone either way; a failed refresh only delays the drop to AAL1.
    if (refresh) await gateway.refreshSession().catch(() => {});
    await onDisabled();
  }, [gateway, onDisabled]);

  const requestDisable = useCallback(async (factor: DisableMfaFactor) => {
    setBusyFactorId(factor.id);
    try {
      if (factor.status === "unverified") {
        await finish(factor.id, { refresh: false });
      } else if ((await gateway.currentLevel()) === "aal2") {
        await finish(factor.id, { refresh: true });
      } else {
        setCodeError(null);
        setPendingFactorId(factor.id);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyFactorId(null);
    }
  }, [gateway, finish, onError]);

  /**
   * Returns true when the factor was removed. A wrong code keeps the dialog open; any other
   * failure is reported through `onError`, closes the dialog and leaves the factor enrolled.
   */
  const submitCode = useCallback(async (code: string, invalidCodeMessage: string): Promise<boolean> => {
    if (!pendingFactorId) return false;
    setSubmitting(true);
    setCodeError(null);
    try {
      if ((await gateway.verify(pendingFactorId, code)) === "invalid_code") {
        setCodeError(invalidCodeMessage);
        return false;
      }
      await finish(pendingFactorId, { refresh: true });
      setPendingFactorId(null);
      return true;
    } catch (error) {
      setPendingFactorId(null);
      onError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [gateway, pendingFactorId, finish, onError]);

  const cancel = useCallback(() => {
    setPendingFactorId(null);
    setCodeError(null);
  }, []);

  return { busyFactorId, pendingFactorId, codeError, submitting, requestDisable, submitCode, cancel };
}
