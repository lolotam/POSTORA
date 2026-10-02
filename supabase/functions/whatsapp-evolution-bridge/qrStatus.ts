// The bridge's get_qr_status decision tree, extracted from index.ts so the ordering
// contract is testable on its own: a durable mismatch is answered before any provider
// call, a just-detected one never reaches the history import, and only a genuinely
// open session starts one.
import { extractQr, extractState } from "./qr.ts";
import { mismatchStatus, reconcileAccountConnection, type ReconcileResult } from "./reconcile.ts";
import type { EvolutionApi } from "../_shared/evolutionApi.ts";

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

// The admin seam is the Supabase service client, spelled structurally like the other
// seams in this file so the module neither takes an explicit-any nor imports its
// callers' types.
interface QrStatusAdmin {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{ error: unknown }>;
    };
  };
}

type BuiltQrStatusDeps = Omit<QrStatusDeps, "autoImport">;

// Everything the poller's decision tree needs that the admin client and the caller's
// user id can construct; index.ts adds only the background autoImport wiring. Every
// write goes through a SECURITY DEFINER RPC scoped by ctx.userId, so a guessed account
// id cannot store a state or QR into another user's instance even though this module
// runs under the service role.
export function buildQrStatusDeps(
  admin: QrStatusAdmin,
  ctx: { userId: string },
  api: EvolutionApi,
): BuiltQrStatusDeps {
  return {
    api,
    saveConnectionState: async (socialAccountId, state) => {
      const { data, error } = await admin.rpc("save_owned_evolution_state", {
        p_account_id: socialAccountId,
        p_user_id: ctx.userId,
        p_state: state,
      });
      if (error) throw error;
      // The RPC returns false when the tenant-scoped update matched nothing: treating
      // that as success would report a state this request never actually stored.
      if (data === false) throw new Error("instance not found for owner");
    },
    saveQr: async (socialAccountId, qr) => {
      const { data, error } = await admin.rpc("save_owned_evolution_qr", {
        p_account_id: socialAccountId,
        p_user_id: ctx.userId,
        p_qr: qr,
        p_state: null,
      });
      if (error) throw error;
      if (data === false) throw new Error("instance not found for owner");
    },
    reconcile: ({ account, instanceName, state }) =>
      reconcileAccountConnection({ admin, api, account, instanceName, state, userId: ctx.userId }),
  };
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
    // The reconciler deactivates the account when the remote session closed; it must
    // run before the observed state is persisted, so a failed reconcile never stores a
    // state this request could not actually verify.
    const result = await deps.reconcile({ api: deps.api, account, instanceName: instance.instance_name, state });
    // Reconciliation may have just replaced the provisional owner id, and conversation
    // ids are built from it, so the sweep uses the value the reconciler returns rather
    // than the one loaded at the top of this request.
    if (result.mismatch) {
      // On a mismatch the scoped flag RPC already stored 'number_mismatch' on the
      // instance, so saving the observed provider state here would overwrite the very
      // flag that must reach the owner. This request's account snapshot predates that
      // flag, so the payload shape is rebuilt from it instead.
      return mismatchStatus({
        ...account,
        account_metadata: { ...account.account_metadata, number_mismatch: true },
      });
    }
    await deps.saveConnectionState(account.id, state);
    if (state.toLowerCase() === "open") {
      await deps.autoImport({ ...account, platform_user_id: result.ownerNumber }, instance);
    }
  }
  return { success: true, social_account_id: account.id, qr, state };
}
