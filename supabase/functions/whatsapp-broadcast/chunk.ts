// One time-bounded chunk of a broadcast.
//
// The worker calls this; the worker never sends anything itself. Two rules hold for every
// recipient here: it is sent at most once, and a recipient whose outcome is unknown is never
// sent again. A recipient becomes 'sending' through a conditional update right before its Meta
// call, so two workers can never both send it, and a worker that dies leaves exactly one
// indeterminate row that the next chunk records as 'outcome_unknown'.
import {
  isCloudApiAccount,
  resolveWhatsAppCloudCredentials,
  type WhatsAppAccountRow,
} from "../_shared/whatsappCloudCredentials.ts";
import { type SendRefusedInput } from "../_shared/optOutLookup.ts";
import { partitionOptedOut } from "./optOut.ts";
import type { BroadcastRecord, BroadcastRecipient } from "./handler.ts";

/** How many recipients one chunk takes. The worker leases one job per chunk. */
export const BROADCAST_CHUNK_LIMIT = 150;

/**
 * Time kept back before the deadline before a send is started. One Meta request is bounded at
 * 15 s, and the writes after it need a few more seconds; starting a send that cannot finish
 * would leave an indeterminate row for no reason.
 */
export const BROADCAST_SEND_RESERVE_MS = 20_000;

/** Hard bound on one Meta request. */
export const BROADCAST_META_TIMEOUT_MS = 15_000;

export interface BroadcastChunkPorts {
  now(): number;
  loadBroadcast(broadcastId: string, userId: string): Promise<(BroadcastRecord & { user_id: string }) | null>;
  loadWhatsAppAccounts(userId: string): Promise<WhatsAppAccountRow[]>;
  failStaleSends(broadcastId: string): Promise<number>;
  loadPendingRecipients(broadcastId: string, limit: number): Promise<BroadcastRecipient[]>;
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;
  skipRecipients(broadcastId: string, ids: string[]): Promise<void>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  beginSend(recipientId: string): Promise<boolean>;
  markRecipientSent(id: string, sentAt: string): Promise<void>;
  markRecipientFailed(id: string, errorMessage: string): Promise<void>;
  insertOutbound(row: Record<string, unknown>): Promise<void>;
  postTemplate(
    phoneNumberId: string,
    accessToken: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    ok: boolean;
    data: { messages?: Array<{ id?: string }>; error?: { message?: string } };
  }>;
  refreshTotals(
    broadcastId: string,
    finish: boolean,
  ): Promise<{ sent: number; failed: number; skipped: number; pending: number; final_status: string | null }>;
  sleep(ms: number): Promise<void>;
}

export type ChunkOutcome =
  | { kind: "done"; result: { sent: number; failed: number; skipped: number; status: string } }
  | { kind: "continue"; progress: { sent: number; failed: number; skipped: number; pending: number } }
  | { kind: "failed"; error: string; retryable: boolean };

/** The Meta template body for one recipient. Language defaults to en_US, as before. */
export function templateMessageBody(
  broadcast: BroadcastRecord,
  phone: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: broadcast.template_name,
      language: { code: broadcast.template_components?.language || "en_US" },
    },
  };
  if (broadcast.template_components?.body_parameters) {
    (body.template as Record<string, unknown>).components = [
      {
        type: "body",
        parameters: broadcast.template_components.body_parameters.map((text: string) => ({ type: "text", text })),
      },
    ];
  }
  return body;
}

export async function runBroadcastChunk(
  ports: BroadcastChunkPorts,
  input: { broadcastId: string; userId: string; deadlineMs: number },
): Promise<ChunkOutcome> {
  const broadcast = await ports.loadBroadcast(input.broadcastId, input.userId);
  if (!broadcast || broadcast.status !== "sending") {
    // The broadcast was deleted or already terminal. There is nothing left to send.
    return {
      kind: "done",
      result: { sent: 0, failed: 0, skipped: 0, status: broadcast?.status ?? "missing" },
    };
  }

  const accounts = await ports.loadWhatsAppAccounts(broadcast.user_id);
  const resolution = resolveWhatsAppCloudCredentials(accounts);
  if (resolution.status !== "ok") {
    return { kind: "failed", error: "credentials_unavailable", retryable: false };
  }
  const { accessToken, phoneNumberId } = resolution.credentials;
  // The outbound row needs the account id, so an account without one cannot be used to send.
  const account = accounts.find(isCloudApiAccount);
  if (!account?.id) {
    return { kind: "failed", error: "credentials_unavailable", retryable: false };
  }

  await ports.failStaleSends(broadcast.id);

  const pending = await ports.loadPendingRecipients(broadcast.id, BROADCAST_CHUNK_LIMIT);
  if (pending.length === 0) {
    const totals = await ports.refreshTotals(broadcast.id, true);
    return {
      kind: "done",
      result: {
        sent: totals.sent,
        failed: totals.failed,
        skipped: totals.skipped,
        status: totals.final_status ?? "completed",
      },
    };
  }

  let optedOut: Set<string>;
  try {
    optedOut = await ports.optedOutPhones(
      broadcast.user_id,
      pending.map((recipient) => recipient.phone_number),
    );
  } catch {
    await ports.logSendRefused({
      source: "whatsapp-broadcast",
      userId: broadcast.user_id,
      reason: "opt_out_lookup_failed",
      metadata: { broadcast_id: broadcast.id },
    });
    // Nothing has been sent yet, so a retry is safe.
    return { kind: "failed", error: "opt_out_lookup_failed", retryable: true };
  }

  const { send, skipped } = partitionOptedOut(pending, optedOut);
  if (skipped.length > 0) {
    try {
      await ports.skipRecipients(broadcast.id, skipped.map((recipient) => recipient.id));
    } catch {
      console.error("[whatsapp-broadcast] opt-out skip update failed");
      await ports.logSendRefused({
        source: "whatsapp-broadcast",
        userId: broadcast.user_id,
        reason: "opt_out_skip_failed",
        metadata: { broadcast_id: broadcast.id, skipped_count: skipped.length },
      });
      return { kind: "failed", error: "opt_out_skip_failed", retryable: true };
    }
    await ports.logSendRefused({
      source: "whatsapp-broadcast",
      userId: broadcast.user_id,
      reason: "opted_out",
      metadata: { broadcast_id: broadcast.id, skipped_count: skipped.length },
    });
  }

  for (const recipient of send) {
    if (ports.now() >= input.deadlineMs) break;
    // Never begin a send that cannot finish inside the reserve.
    if (input.deadlineMs - ports.now() < BROADCAST_SEND_RESERVE_MS) break;

    const began = await ports.beginSend(recipient.id);
    if (!began) continue; // another worker owns this recipient

    const body = templateMessageBody(broadcast, recipient.phone_number);
    const timeoutMs = Math.min(
      BROADCAST_META_TIMEOUT_MS,
      Math.max(0, input.deadlineMs - ports.now()),
    );
    const signal = AbortSignal.timeout(timeoutMs);

    let response: { ok: boolean; data: { messages?: Array<{ id?: string }>; error?: { message?: string } } };
    try {
      response = await ports.postTemplate(phoneNumberId, accessToken, body, signal);
    } catch {
      // The request was sent but its outcome is unknown. It is never resent.
      console.error("[whatsapp-broadcast] meta request failed", { recipient_id: recipient.id });
      await ports.markRecipientFailed(recipient.id, "outcome_unknown");
      await ports.sleep(100);
      continue;
    }

    const waMessageId = response.data.messages?.[0]?.id;
    if (response.ok && waMessageId) {
      try {
        await ports.markRecipientSent(recipient.id, new Date(ports.now()).toISOString());
      } catch {
        // Meta accepted the message but the row could not be written. The row stays 'sending'
        // and the next chunk records it 'outcome_unknown'. It is never resent.
        console.error("[whatsapp-broadcast] recipient write failed", { recipient_id: recipient.id });
        await ports.sleep(100);
        continue;
      }
      const digits = recipient.phone_number.replace(/\D/g, "");
      try {
        await ports.insertOutbound({
          user_id: broadcast.user_id,
          social_account_id: account.id,
          conversation_id: `wa_${phoneNumberId}_${digits}`,
          message_id: waMessageId,
          to_phone: recipient.phone_number,
          message_text: `[Broadcast: ${broadcast.name}] Template: ${broadcast.template_name}`,
          message_type: "template",
          direction: "outbound",
          status: "sent",
        });
      } catch {
        // Best effort: the recipient is sent, which is the truth that matters.
        console.error("[whatsapp-broadcast] outbound row write failed", { recipient_id: recipient.id });
      }
    } else {
      await ports.markRecipientFailed(recipient.id, response.data.error?.message || "Send failed");
    }
    await ports.sleep(100);
  }

  const totals = await ports.refreshTotals(broadcast.id, false);
  if (totals.pending === 0) {
    const final = await ports.refreshTotals(broadcast.id, true);
    return {
      kind: "done",
      result: {
        sent: final.sent,
        failed: final.failed,
        skipped: final.skipped,
        status: final.final_status ?? "completed",
      },
    };
  }
  return {
    kind: "continue",
    progress: {
      sent: totals.sent,
      failed: totals.failed,
      skipped: totals.skipped,
      pending: totals.pending,
    },
  };
}
