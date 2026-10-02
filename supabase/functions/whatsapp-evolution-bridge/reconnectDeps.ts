// Reconnect dependencies builder for whatsapp-evolution-bridge. Every ownership proof
// lives inside the statement it guards: the instance read and the QR save go through
// SECURITY DEFINER RPCs scoped by the caller's user id (migration
// 20261004100400_owned_evolution_instance_rpcs), so a guessed account id cannot touch
// another user's instance even though this module runs under the service role.
import type { EvolutionApi, EvolutionEvent } from "../_shared/evolutionApi.ts";
import { findOwnedEvolutionAccount } from "../_shared/evolutionQrAccount.ts";
import { clearMismatchFor } from "./clearMismatch.ts";
import type { ReconnectDeps } from "./reconnect.ts";

export const EVOLUTION_EVENTS: EvolutionEvent[] = [
  "MESSAGES_UPSERT",
  // Delivery / read / rejection acks for our own sends. Instances paired before this event
  // was listed need the resubscribe_webhook action once.
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
];

export function buildReconnectDeps(admin: any, ctx: { userId: string; webhookBaseUrl: string }, api: ReconnectDeps["api"]): ReconnectDeps {
  return {
    findAccount: (userId, id) => findOwnedEvolutionAccount(admin, userId, id),
    findInstance: async (id) => {
      const { data, error } = await admin.rpc("get_owned_evolution_instance", {
        p_account_id: id,
        p_user_id: ctx.userId,
      });
      if (error) throw error;
      return data;
    },
    api,
    webhook: {
      url: `${ctx.webhookBaseUrl}/functions/v1/whatsapp-evolution-webhook`,
      events: EVOLUTION_EVENTS,
    },
    saveQr: async (id, qr, state) => {
      const { data, error } = await admin.rpc("save_owned_evolution_qr", {
        p_account_id: id,
        p_user_id: ctx.userId,
        p_qr: qr,
        p_state: state,
      });
      if (error) throw error;
      if (data === false) throw new Error("instance not found for owner");
    },
    // The flag blocks a refused phone; a freshly issued QR is what lets the right phone
    // lift it. The helper keeps the caller's id on both the read and the write.
    clearMismatch: (id) => clearMismatchFor(admin, ctx.userId, id),
    // Reconnect refusals go to system_logs so /admin/logs can explain a 404/409 the
    // user saw. Best effort: reconnect.ts wraps this in its own try/catch, and a
    // failed log write must never turn a refusal into a 500.
    logRefusal: async (refusal) => {
      const { error } = await admin.from("system_logs").insert({
        level: "info",
        category: "system",
        source: "whatsapp-evolution-bridge",
        message: "WhatsApp reconnect refused",
        user_id: refusal.userId,
        metadata: { account_id: refusal.accountId, reason: refusal.reason },
      });
      if (error) console.error("[whatsapp-evolution-bridge] reconnect refusal log failed:", error.message ?? error);
    },
  };
}
