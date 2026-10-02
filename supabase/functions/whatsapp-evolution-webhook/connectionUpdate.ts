// connection.update handling for the Evolution webhook, extracted from index.ts so the
// activation/mismatch contract is importable and testable on its own: a refused phone
// answers "number_mismatch" and runs nothing that follows a successful activation.
import { NumberMismatchError, syncEvolutionAccountConnection } from "../_shared/evolutionQrAccount.ts";
import { handleNumberMismatch } from "../_shared/numberMismatch.ts";
import type { SyncAccount } from "../_shared/whatsappSyncEngine.ts";

export interface ConnectionUpdateDeps {
  admin: Parameters<typeof syncEvolutionAccountConnection>[0];
  api: { logout(instanceName: string): Promise<unknown> };
  handleNumberMismatch: typeof handleNumberMismatch;
  syncEvolutionAccountConnection: typeof syncEvolutionAccountConnection;
  importEvolutionHistory(input: {
    admin: ConnectionUpdateDeps["admin"];
    account: SyncAccount;
    instanceName: string;
  }): Promise<unknown>;
  runInBackground(label: string, task: () => Promise<unknown>): Promise<void> | void;
}

interface ConnectionUpdateInstance {
  instance_name: string;
  last_sync_at: string | null;
}

export async function handleConnectionUpdate(
  deps: ConnectionUpdateDeps,
  input: {
    account: Parameters<typeof syncEvolutionAccountConnection>[1] & SyncAccount;
    instance: ConnectionUpdateInstance;
    data: unknown;
  },
): Promise<"number_mismatch" | undefined> {
  const { admin } = deps;
  const { account, instance, data } = input;
  const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const state = String(payload.state || payload.connection || payload.status || "").toLowerCase();
  if (!state) return undefined;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_connection_state: state })
    .eq("social_account_id", account.id);

  // Activation resolves the provisional platform_user_id, so the import below has to use the
  // value that was just stored rather than the one this request loaded.
  let ownerNumber: string;
  try {
    // The callback is authenticated against this instance's jwt_key, so the instance
    // name is the tenant scope the mismatch flag requires -- the SQL joins it
    // structurally to the account it belongs to.
    ownerNumber = await deps.syncEvolutionAccountConnection(admin, account, state, data, {
      instanceName: instance.instance_name,
    });
  } catch (error) {
    if (!(error instanceof NumberMismatchError)) throw error;
    // A different phone scanned onto this connection: the row is flagged and deactivated
    // by the sync. The shared handler kills the remote session and persists the blocked
    // state, and the mismatch reaches the owner instead of a history import under a
    // number the phone does not own.
    await deps.handleNumberMismatch(deps.admin, deps.api, {
      accountId: account.id,
      instanceName: instance.instance_name,
    });
    return "number_mismatch";
  }

  // Evolution reports "open" more than once while a session settles, and the QR screen stops
  // polling shortly after the first one. Importing from here too gives the sweep a later
  // attempt, which matters because Baileys may still be pulling history off the phone when
  // the connection first opens. The lease and last_sync_at keep it to one real run.
  if (state === "open" && !instance.last_sync_at) {
    await deps.runInBackground("whatsapp history sync", () => deps.importEvolutionHistory({
      admin,
      account: { ...account, platform_user_id: ownerNumber },
      instanceName: instance.instance_name,
    }));
  }
  return undefined;
}
