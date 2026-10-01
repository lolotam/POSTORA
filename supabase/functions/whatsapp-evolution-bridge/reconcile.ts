// Connection reconciliation for the bridge poll path. Extracted from index.ts so the
// mismatch contract is importable and testable on its own: every caller must observe a
// refused phone as the same durable state, never as "still connected".
import { NumberMismatchError, syncEvolutionAccountConnection } from "../_shared/evolutionQrAccount.ts";
import { handleNumberMismatch } from "../_shared/numberMismatch.ts";
import type { EvolutionApi } from "../_shared/evolutionApi.ts";

// The admin seam is exactly what syncEvolutionAccountConnection accepts (the Supabase
// service client); spelled through that signature so this module adds no new explicit-any.
type ReconcileAdmin = Parameters<typeof syncEvolutionAccountConnection>[0];

export type ReconcileResult = { ownerNumber: string; mismatch: boolean };

// A refused phone is a state the owner must see, not an error to swallow. The flag lives
// in account_metadata because getQrStatus checks it BEFORE any provider call, so a stale
// poll cannot resurrect the mismatched session between webhooks.
export function mismatchStatus(account: {
  id: string;
  platform_user_id: string;
  account_metadata?: Record<string, unknown> | null;
}): {
  success: true;
  social_account_id: string;
  qr: null;
  state: "number_mismatch";
  expected_last4: string;
} | null {
  if (account.account_metadata?.number_mismatch !== true) return null;
  // Only the last four digits cross the API: the owner needs to tell which phone is the
  // right one, and the logs and responses carry no more than that.
  return {
    success: true,
    social_account_id: account.id,
    qr: null,
    state: "number_mismatch",
    expected_last4: account.platform_user_id.slice(-4),
  };
}

export async function reconcileAccountConnection(reconciliation: {
  admin: ReconcileAdmin;
  api: EvolutionApi;
  account: { id: string; platform_user_id: string; is_active: boolean };
  instanceName: string;
  state: string;
}): Promise<ReconcileResult> {
  const { admin, api, account, instanceName } = reconciliation;
  const connection = reconciliation.state.toLowerCase();
  if (connection === "open") {
    if (account.is_active && !account.platform_user_id.startsWith("pending_")) {
      return { ownerNumber: account.platform_user_id, mismatch: false };
    }
    try {
      const ownerNumber = await syncEvolutionAccountConnection(admin, account, connection, await api.fetchInstance(instanceName));
      return { ownerNumber, mismatch: false };
    } catch (error) {
      if (!(error instanceof NumberMismatchError)) throw error;
      // The linked phone is not the stored one: the shared handler kills the remote
      // session so it stops answering polls, and records why in the instance row. A
      // logout failure must not hide the mismatch -- the flag in account_metadata is
      // the durable record.
      await handleNumberMismatch(admin, api, { accountId: account.id, instanceName });
      return { ownerNumber: account.platform_user_id, mismatch: true };
    }
  }
  if (connection === "close" && account.is_active) {
    await syncEvolutionAccountConnection(admin, account, connection, null);
  }
  return { ownerNumber: account.platform_user_id, mismatch: false };
}
