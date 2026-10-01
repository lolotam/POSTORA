// The bridge's get_qr_status decision tree, extracted from index.ts so the ordering
// contract is testable on its own: a durable mismatch is answered before any provider
// call, a just-detected one never reaches the history import, and only a genuinely
// open session starts one.
import { extractQr, extractState } from "./qr.ts";
import { mismatchStatus, type ReconcileResult } from "./reconcile.ts";

export interface QrStatusAccount {
  id: string;
  platform_user_id: string;
  account_metadata?: Record<string, unknown> | null;
}

export interface QrStatusInstance {
  instance_name: string;
  last_qr: string | null;
}

export interface QrStatusDeps {
  api: {
    connect(instanceName: string): Promise<unknown>;
    connectionState(instanceName: string): Promise<unknown>;
  };
  saveConnectionState(socialAccountId: string, state: string): Promise<void>;
  saveQr?(socialAccountId: string, qr: string | null): Promise<void>;
  reconcile(input: {
    api: QrStatusDeps["api"];
    account: QrStatusAccount & { is_active: boolean };
    instanceName: string;
    state: string;
  }): Promise<ReconcileResult>;
  autoImport(account: QrStatusAccount, instance: QrStatusInstance): Promise<unknown> | unknown;
}

export interface QrStatusInput {
  account: QrStatusAccount & { is_active: boolean };
  instance: QrStatusInstance;
  refreshQr: boolean;
}

export async function getQrStatusResult(deps: QrStatusDeps, input: QrStatusInput) {
  const { account, instance } = input;
  // A durable mismatch from an earlier refusal is answered before any provider call:
  // the session was already logged out, so polling would only see a closed instance
  // and could never clear the flag that must reach the owner.
  const durable = mismatchStatus(account);
  if (durable) return durable;

  let qr = instance.last_qr;
  if (input.refreshQr) {
    qr = extractQr(await deps.api.connect(instance.instance_name));
    await deps.saveQr?.(account.id, qr);
  }
  const state = extractState(await deps.api.connectionState(instance.instance_name));
  if (state) {
    await deps.saveConnectionState(account.id, state);
    // Reconciliation may have just replaced the provisional owner id, and conversation
    // ids are built from it, so the sweep uses the value the reconciler returns rather
    // than the one loaded at the top of this request.
    const result = await deps.reconcile({ api: deps.api, account, instanceName: instance.instance_name, state });
    if (result.mismatch) {
      // This request's account snapshot predates the flag the sync just persisted, so
      // the flag is merged here only to reuse the mismatch payload shape.
      return mismatchStatus({
        ...account,
        account_metadata: { ...account.account_metadata, number_mismatch: true },
      });
    }
    if (state.toLowerCase() === "open") {
      await deps.autoImport({ ...account, platform_user_id: result.ownerNumber }, instance);
    }
  }
  return { success: true, social_account_id: account.id, qr, state };
}
