// Postgres adapters for the broadcast chunk. Every adapter throws when the database reports
// an error: a silent read error would let the worker finish a job "succeeded" while the
// broadcast is still sending.
import {
  logSendRefused as writeSendRefused,
  optedOutPhones as lookupOptedOutPhones,
} from "../_shared/optOutLookup.ts";
import type { WhatsAppAccountRow } from "../_shared/whatsappCloudCredentials.ts";
import type { BroadcastChunkPorts } from "./chunk.ts";
import { markRecipientsSkipped } from "./optOut.ts";
import type { BroadcastRecipient } from "./handler.ts";

/**
 * The client is deliberately loose: a precise builder type makes `deno check` instantiate the
 * Supabase client's generics until it gives up. Same reason as OptOutLookupAdmin.
 */
export interface ChunkAdmin {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): any;
}

function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export function createBroadcastChunkPorts(admin: ChunkAdmin): BroadcastChunkPorts {
  return {
    now: () => Date.now(),

    async loadBroadcast(broadcastId) {
      const { data, error } = await admin
        .from("whatsapp_broadcasts")
        .select("id, user_id, status, name, template_name, template_components, sent_count, failed_count")
        .eq("id", broadcastId)
        .maybeSingle();
      if (error) throw new Error(`load broadcast: ${error.message}`);
      return data ?? null;
    },

    async loadWhatsAppAccounts(userId) {
      const { data, error } = await admin
        .from("social_accounts")
        .select("id, platform_user_id, access_token, account_metadata")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (error) throw new Error(`load accounts: ${error.message}`);
      return (data ?? []) as WhatsAppAccountRow[];
    },

    async failStaleSends(broadcastId) {
      const { data, error } = await admin.rpc("fail_stale_broadcast_sends", {
        p_broadcast_id: broadcastId,
      });
      if (error) throw new Error(`fail stale sends: ${error.message}`);
      return Number(data ?? 0);
    },

    async loadPendingRecipients(broadcastId, limit) {
      const { data, error } = await admin
        .from("whatsapp_broadcast_recipients")
        .select("id, phone_number")
        .eq("broadcast_id", broadcastId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`load recipients: ${error.message}`);
      return (data ?? []) as BroadcastRecipient[];
    },

    optedOutPhones(userId, phones) {
      return lookupOptedOutPhones(admin, userId, phones);
    },

    async skipRecipients(broadcastId, ids) {
      await markRecipientsSkipped(admin, broadcastId, ids);
    },

    async logSendRefused(input) {
      await writeSendRefused(admin, input);
    },

    async beginSend(recipientId) {
      const { data, error } = await admin.rpc("begin_broadcast_recipient_send", {
        p_recipient_id: recipientId,
      });
      if (error) throw new Error(`begin send: ${error.message}`);
      return data === true;
    },

    async markRecipientSent(id, sentAt) {
      const { error } = await admin
        .from("whatsapp_broadcast_recipients")
        .update({ status: "sent", sent_at: sentAt, error_message: null })
        .eq("id", id);
      if (error) throw new Error(`mark sent: ${error.message}`);
    },

    async markRecipientFailed(id, errorMessage) {
      const { error } = await admin
        .from("whatsapp_broadcast_recipients")
        .update({ status: "failed", error_message: errorMessage })
        .eq("id", id);
      if (error) throw new Error(`mark failed: ${error.message}`);
    },

    async insertOutbound(row) {
      const { error } = await admin.from("whatsapp_messages").insert(row);
      if (error) throw new Error(`insert outbound: ${error.message}`);
    },

    async postTemplate(phoneNumberId, accessToken, body, signal) {
      const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const data = await res.json();
      return { ok: res.ok, data };
    },

    async refreshTotals(broadcastId, finish) {
      const { data, error } = await admin.rpc("refresh_whatsapp_broadcast_totals", {
        p_broadcast_id: broadcastId,
        p_finish: finish,
      });
      if (error) throw new Error(`refresh totals: ${error.message}`);
      const row = (asRows<Record<string, unknown>>(data)[0] ?? {}) as Record<string, unknown>;
      return {
        sent: Number(row.sent ?? 0),
        failed: Number(row.failed ?? 0),
        skipped: Number(row.skipped ?? 0),
        pending: Number(row.pending ?? 0),
        final_status: typeof row.final_status === "string" ? row.final_status : null,
      };
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
