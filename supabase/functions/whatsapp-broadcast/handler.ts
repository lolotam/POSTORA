// Broadcast send. Opt-out is resolved after the batch cap and before the broadcast is marked sending.
import { resolveWhatsAppCloudCredentials, type WhatsAppAccountRow } from "../_shared/whatsappCloudCredentials.ts";
import { type SendRefusedInput } from "../_shared/optOutLookup.ts";
import { partitionOptedOut } from "./optOut.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface BroadcastRecipient {
  id: string;
  phone_number: string;
}

export interface BroadcastRecord {
  id: string;
  status: string;
  name: string;
  template_name: string;
  template_components: { language?: string; body_parameters?: string[] } | null;
  sent_count: number;
  failed_count: number;
}

export interface BroadcastDeps {
  authenticate(req: Request): Promise<{ userId: string } | { response: Response }>;
  loadBroadcast(userId: string, broadcastId: string): Promise<BroadcastRecord | null>;
  loadWhatsAppAccounts(userId: string): Promise<WhatsAppAccountRow[]>;
  loadPendingRecipients(broadcastId: string): Promise<BroadcastRecipient[] | null>;
  markSending(broadcastId: string): Promise<void>;
  skipRecipients(broadcastId: string, ids: string[]): Promise<void>;
  markRecipientSent(id: string, sentAt: string): Promise<void>;
  markRecipientFailed(id: string, errorMessage: string): Promise<void>;
  insertOutbound(row: Record<string, unknown>): Promise<void>;
  finish(broadcastId: string, patch: { status: string; sent_count: number; failed_count: number }): Promise<void>;
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  postTemplate(phoneNumberId: string, accessToken: string, body: Record<string, unknown>): Promise<{
    ok: boolean;
    data: { messages?: Array<{ id?: string }>; error?: { message?: string } };
  }>;
  sleep(ms: number): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleWhatsAppBroadcast(req: Request, deps: BroadcastDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = await deps.authenticate(req);
    if ("response" in auth) return auth.response;

    const { broadcast_id } = await req.json();
    if (!broadcast_id) return json({ error: "broadcast_id required" }, 400);

    const broadcast = await deps.loadBroadcast(auth.userId, broadcast_id);
    if (!broadcast) return json({ error: "Broadcast not found" }, 404);
    if (broadcast.status !== "pending") {
      return json({ error: `Broadcast already ${broadcast.status}` }, 400);
    }

    const resolution = resolveWhatsAppCloudCredentials(await deps.loadWhatsAppAccounts(auth.userId));
    if (resolution.status !== "ok") {
      return json(
        resolution.status === "requires_cloud_api"
          ? {
            error: resolution.reason === "qr_only"
              ? "Broadcasts require a Cloud API connection. This number is connected with Direct QR, which cannot send template messages."
              : "This WhatsApp number is missing the Cloud API credentials needed to broadcast. Reconnect it from Setup.",
            code: "BROADCAST_REQUIRES_CLOUD_API",
          }
          : { error: "No connected WhatsApp Business account", code: "NO_WHATSAPP_ACCOUNT" },
        400,
      );
    }
    const { accessToken, phoneNumberId } = resolution.credentials;

    const recipients = await deps.loadPendingRecipients(broadcast_id);
    if (!recipients?.length) return json({ error: "No pending recipients" }, 400);
    const batch = recipients.slice(0, 1000);

    let optedOut: Set<string>;
    try {
      optedOut = await deps.optedOutPhones(auth.userId, batch.map((recipient) => recipient.phone_number));
    } catch {
      await deps.logSendRefused({
        source: "whatsapp-broadcast",
        userId: auth.userId,
        reason: "opt_out_lookup_failed",
        metadata: { broadcast_id },
      });
      return json({ error: "opt_out_lookup_failed" }, 500);
    }

    const { send, skipped } = partitionOptedOut(batch, optedOut);
    if (skipped.length > 0) {
      try {
        await deps.skipRecipients(broadcast.id, skipped.map((recipient) => recipient.id));
      } catch {
        console.error("[whatsapp-broadcast] opt-out skip update failed");
        await deps.logSendRefused({
          source: "whatsapp-broadcast",
          userId: auth.userId,
          reason: "opt_out_skip_failed",
          metadata: { broadcast_id: broadcast.id, skipped_count: skipped.length },
        });
        return json({ error: "opt_out_skip_failed" }, 500);
      }
      await deps.logSendRefused({
        source: "whatsapp-broadcast",
        userId: auth.userId,
        reason: "opted_out",
        metadata: { broadcast_id: broadcast.id, skipped_count: skipped.length },
      });
    }

    if (send.length > 0) await deps.markSending(broadcast.id);

    let sentCount = 0;
    let failedCount = 0;
    for (const recipient of send) {
      try {
        const messageBody: Record<string, unknown> = {
          messaging_product: "whatsapp",
          to: recipient.phone_number,
          type: "template",
          template: {
            name: broadcast.template_name,
            language: { code: broadcast.template_components?.language || "en_US" },
          },
        };
        if (broadcast.template_components?.body_parameters) {
          (messageBody.template as Record<string, unknown>).components = [
            {
              type: "body",
              parameters: broadcast.template_components.body_parameters.map((text: string) => ({ type: "text", text })),
            },
          ];
        }

        const { ok, data } = await deps.postTemplate(phoneNumberId, accessToken, messageBody);
        const waMessageId = data.messages?.[0]?.id;
        if (ok && waMessageId) {
          const sentAt = new Date().toISOString();
          await deps.markRecipientSent(recipient.id, sentAt);
          const normalizedPhone = recipient.phone_number.replace(/\D/g, "");
          await deps.insertOutbound({
            user_id: auth.userId,
            conversation_id: `wa_${phoneNumberId}_${normalizedPhone}`,
            direction: "outbound",
            message_type: "template",
            content: `[Broadcast: ${broadcast.name}] Template: ${broadcast.template_name}`,
            wa_message_id: waMessageId,
            phone_number_id: phoneNumberId,
            contact_phone: recipient.phone_number,
            status: "sent",
          });
          sentCount++;
        } else {
          await deps.markRecipientFailed(recipient.id, data.error?.message || "Send failed");
          failedCount++;
        }
      } catch (error) {
        await deps.markRecipientFailed(recipient.id, (error as Error).message);
        failedCount++;
      }
      await deps.sleep(100);
    }

    const finalStatus = send.length > 0 && failedCount === send.length ? "failed" : "completed";
    await deps.finish(broadcast.id, {
      status: finalStatus,
      sent_count: broadcast.sent_count + sentCount,
      failed_count: broadcast.failed_count + failedCount,
    });

    return json({ success: true, sent: sentCount, failed: failedCount, skipped: skipped.length, status: finalStatus });
  } catch (e) {
    console.error("[whatsapp-broadcast] send failed");
    return json({ error: (e as Error).message }, 500);
  }
}
