// Due WhatsApp scheduled messages. Opt-out is one lookup per user per tick, before any send.
import { digitsOnly, type SendRefusedInput } from "../_shared/optOutLookup.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const GRAPH_API = "https://graph.facebook.com/v22.0";

export interface DueScheduledMessage {
  id: string;
  user_id: string;
  social_account_id: string | null;
  recipient_phone: string;
  message_text: string | null;
  media_url: string | null;
  media_type: string | null;
  social_accounts: { platform_user_id?: string | null; access_token?: string | null } | null;
}

export interface ScheduledSenderDeps {
  authorize(req: Request): { ok: true } | { ok: false; response: Response };
  loadDue(nowIso: string): Promise<{ messages: DueScheduledMessage[] } | { error: string }>;
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  updateMessage(id: string, patch: Record<string, unknown>): Promise<void>;
  insertOutbound(row: Record<string, unknown>): Promise<void>;
  postGraph(url: string, token: string, payload: Record<string, unknown>): Promise<{ data: { error?: { message?: string }; messages?: Array<{ id?: string }> } }>;
  envToken(): string | undefined;
  now(): Date;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleScheduledSender(req: Request, deps: ScheduledSenderDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const cronAuth = deps.authorize(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const loaded = await deps.loadDue(deps.now().toISOString());
    if ("error" in loaded) return json({ error: "scheduled_query_failed" }, 500);
    const pending = loaded.messages;
    if (pending.length === 0) return json({ processed: 0 });

    const byUser = new Map<string, DueScheduledMessage[]>();
    for (const msg of pending) {
      if (!msg.user_id) continue;
      const list = byUser.get(msg.user_id) ?? [];
      list.push(msg);
      byUser.set(msg.user_id, list);
    }

    const blocked = new Set<string>();
    const optedOutIds = new Set<string>();
    for (const [userId, messages] of byUser) {
      try {
        const optedOut = await deps.optedOutPhones(userId, messages.map((msg) => msg.recipient_phone));
        for (const msg of messages) {
          if (optedOut.has(digitsOnly(msg.recipient_phone))) optedOutIds.add(msg.id);
        }
      } catch {
        await deps.logSendRefused({
          source: "whatsapp-scheduled-sender",
          userId,
          reason: "opt_out_lookup_failed",
          metadata: { count: messages.length },
        });
        for (const msg of messages) blocked.add(msg.id);
      }
    }

    const fallbackToken = deps.envToken();
    let processed = 0;
    for (const msg of pending) {
      if (!msg.user_id || blocked.has(msg.id)) continue;
      if (optedOutIds.has(msg.id)) {
        try {
          await deps.updateMessage(msg.id, { status: "skipped", error_message: "opted_out" });
        } catch {
          console.error("[scheduled-sender] opt-out skip update failed", msg.id);
          continue;
        }
        await deps.logSendRefused({
          source: "whatsapp-scheduled-sender",
          userId: msg.user_id,
          reason: "opted_out",
          metadata: { scheduled_message_id: msg.id },
        });
        continue;
      }

      try {
        const phoneNumberId = msg.social_accounts?.platform_user_id;
        if (!phoneNumberId) {
          await deps.updateMessage(msg.id, { status: "failed", error_message: "Social account not found" });
          continue;
        }
        const token = msg.social_accounts?.access_token || fallbackToken;
        if (!token) {
          await deps.updateMessage(msg.id, { status: "failed", error_message: "No access token available" });
          continue;
        }

        let payload: Record<string, unknown>;
        if (msg.media_url && msg.media_type) {
          const mediaObj: Record<string, unknown> = { link: msg.media_url };
          if (msg.message_text) mediaObj.caption = msg.message_text;
          if (msg.media_type === "document") mediaObj.filename = msg.media_url.split("/").pop() || "file";
          payload = { messaging_product: "whatsapp", to: msg.recipient_phone, type: msg.media_type, [msg.media_type]: mediaObj };
        } else {
          payload = {
            messaging_product: "whatsapp",
            to: msg.recipient_phone,
            type: "text",
            text: { body: msg.message_text || "" },
          };
        }

        const { data } = await deps.postGraph(`${GRAPH_API}/${phoneNumberId}/messages`, token, payload);
        if (data.error) {
          await deps.updateMessage(msg.id, { status: "failed", error_message: data.error.message || JSON.stringify(data.error) });
        } else {
          const sentMsgId = data.messages?.[0]?.id;
          await deps.updateMessage(msg.id, { status: "sent", sent_at: deps.now().toISOString() });
          const normalizedPhone = msg.recipient_phone.replace(/^\+/, "");
          await deps.insertOutbound({
            user_id: msg.user_id,
            social_account_id: msg.social_account_id,
            conversation_id: `wa_${phoneNumberId}_${normalizedPhone}`,
            message_id: sentMsgId || `sched_${msg.id}`,
            from_phone: phoneNumberId,
            from_name: "You (Scheduled)",
            to_phone: msg.recipient_phone,
            message_text: msg.message_text || `[${msg.media_type || "scheduled"}]`,
            message_type: msg.media_type || "text",
            direction: "outbound",
            status: "sent",
            timestamp: deps.now().toISOString(),
          });
          processed++;
        }
      } catch (err) {
        console.error("[scheduled-sender] send failed", msg.id);
        try {
          await deps.updateMessage(msg.id, { status: "failed", error_message: (err as Error).message || "Unknown error" });
        } catch {
          console.error("[scheduled-sender] failure status update failed", msg.id);
        }
      }
    }

    return json({ processed, total: pending.length });
  } catch {
    console.error("[scheduled-sender] Fatal error");
    return json({ error: "scheduled_send_failed" }, 500);
  }
}
