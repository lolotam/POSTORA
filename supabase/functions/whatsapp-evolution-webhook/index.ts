import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { buildMessagePayload, buildMessagingSender, dispatchMessageEvent } from "../_shared/n8nMessagingDispatch.ts";
import { verifyEvolutionWebhookToken } from "../_shared/evolutionWebhookAuth.ts";
import { normalizeEvolutionEvent } from "../_shared/evolutionApi.ts";
import { syncEvolutionAccountConnection } from "../_shared/evolutionQrAccount.ts";
import { buildEvolutionMessageRow, remoteNumberFor } from "../_shared/evolutionMessage.ts";
import { importEvolutionHistory } from "../_shared/whatsappSyncEngine.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EvolutionAccount {
  id: string;
  user_id: string;
  workspace_id: string;
  platform_user_id: string;
  platform_username?: string | null;
  account_metadata: Record<string, unknown> | null;
}

interface EvolutionInstance {
  social_account_id: string;
  instance_name: string;
  jwt_key: string;
  last_sync_at: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function messageItems(body: any): any[] {
  return Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
}

async function findInstance(admin: any, instanceName: string): Promise<EvolutionInstance | null> {
  const { data, error } = await admin
    .from("whatsapp_evolution_instances")
    .select("social_account_id, instance_name, jwt_key, last_sync_at")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (error) throw error;
  return data as EvolutionInstance | null;
}

async function findAccount(admin: any, socialAccountId: string): Promise<EvolutionAccount | null> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("id, user_id, workspace_id, platform_user_id, platform_username, account_metadata")
    .eq("id", socialAccountId)
    .eq("platform", "whatsapp")
    .eq("connection_mode", "evolution_qr")
    .maybeSingle();
  if (error) throw error;
  return data as EvolutionAccount | null;
}

interface ConversationTouch {
  conversationId: string;
  participantName: string;
  preview: string;
  timestamp: string;
  unreadDelta: number;
}

async function touchConversation(admin: any, account: EvolutionAccount, touch: ConversationTouch): Promise<void> {
  const { data: cached } = await admin
    .from("messaging_cache")
    .select("unread_count, participant_name, participant_avatar")
    .eq("user_id", account.user_id)
    .eq("workspace_id", account.workspace_id)
    .eq("conversation_id", touch.conversationId)
    .maybeSingle();
  await admin.from("messaging_cache").upsert({
    user_id: account.user_id,
    workspace_id: account.workspace_id,
    social_account_id: account.id,
    conversation_id: touch.conversationId,
    platform: "whatsapp",
    // An owner-sent message carries the owner's own push name, which must not overwrite
    // the name already resolved for the person on the other end.
    participant_name: touch.participantName || cached?.participant_name || null,
    participant_avatar: cached?.participant_avatar || null,
    last_message_preview: touch.preview.slice(0, 200),
    last_message_at: touch.timestamp,
    unread_count: (cached?.unread_count || 0) + touch.unreadDelta,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,conversation_id" });
}

async function persistEvolutionMessage(admin: any, account: EvolutionAccount, message: any): Promise<boolean> {
  const built = buildEvolutionMessageRow(account, message);
  if (!built) return false;
  const { conversationId, sentByOwner, row } = built;
  const remoteNumber = remoteNumberFor(message.key.remoteJid);

  const { data: insertedRows, error: insertError } = await admin
    .from("whatsapp_messages")
    .upsert(row, { onConflict: "user_id,message_id", ignoreDuplicates: true })
    .select("id");

  // Without this a failed write is indistinguishable from the deliberate duplicate skip
  // below, which is how a silent persistence failure could look like normal operation.
  if (insertError) {
    console.error("[whatsapp-evolution-webhook] Message persist failed:", insertError.message);
    return false;
  }
  if (!insertedRows || insertedRows.length === 0) return false;
  await touchConversation(admin, account, {
    conversationId,
    participantName: built.participantName,
    preview: built.preview,
    timestamp: built.timestamp,
    unreadDelta: sentByOwner ? 0 : 1,
  });
  // Only a message from the contact is an inbound event for automations; echoing the
  // operator's own reply back into n8n would retrigger their workflows on their own text.
  if (sentByOwner) return true;

  const automationHandler = resolveAutomationHandler(account.account_metadata);

  if (automationHandler !== "off") {
    await runInBackground("whatsapp evolution message dispatch", () => dispatchMessageEvent(
      admin,
      account.user_id,
      buildMessagePayload({
        platform: "whatsapp",
        socialAccountId: account.id,
        account: { id: account.id, platform: "whatsapp", platform_user_id: account.platform_user_id, platform_username: account.platform_username },
        conversationId,
        // The raw JID carries Evolution's "@s.whatsapp.net" suffix. Automations match on the
        // same digits the Cloud path sends, so the suffix is stripped before it leaves Postora.
        // remoteNumber is digits-only and serves as both sender id and phone.
        sender: buildMessagingSender({
          platform: "whatsapp",
          id: remoteNumber,
          name: built.participantName,
          phone: remoteNumber,
        }),
        message: {
          id: row.message_id as string,
          text: row.message_text as string,
          type: row.message_type as string,
          attachments: [],
        },
        timestamp: built.timestamp,
      }),
    ));
  }

  const inboundText = (row.message_text as string) || "";
  if (automationHandler === "internal" && inboundText.trim()) {
    triggerAiAgentReply(
      account,
      conversationId,
      account.platform_user_id,
      remoteNumber,
      inboundText,
    ).catch((e) => console.error("[whatsapp-evolution-webhook] AI agent dispatch failed:", e?.message || e));
  }

  return true;
}

function resolveAutomationHandler(metadata: unknown): "internal" | "n8n" | "off" {
  if (!metadata || typeof metadata !== "object") return "internal";
  const handler = (metadata as Record<string, unknown>).automation_handler;
  if (handler === "off" || handler === "n8n" || handler === "internal") return handler;
  return "internal";
}

async function triggerAiAgentReply(
  account: { id: string; user_id: string },
  conversationId: string,
  phoneNumberId: string,
  recipientPhone: string,
  inboundText: string
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetch(`${supabaseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: account.user_id,
      platform: "whatsapp",
      social_account_id: account.id,
      conversation_id: conversationId,
      phone_number_id: phoneNumberId,
      recipient_phone: recipientPhone,
      inbound_text: inboundText,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[whatsapp-evolution-webhook] ai-agent-reply returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function handleConnectionUpdate(
  admin: any,
  account: EvolutionAccount,
  instance: EvolutionInstance,
  data: any,
): Promise<void> {
  const state = String(data?.state || data?.connection || data?.status || "").toLowerCase();
  if (!state) return;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_connection_state: state })
    .eq("social_account_id", account.id);

  // Activation resolves the provisional platform_user_id, so the import below has to use the
  // value that was just stored rather than the one this request loaded.
  const ownerNumber = await syncEvolutionAccountConnection(admin, account, state, data);

  // Evolution reports "open" more than once while a session settles, and the QR screen stops
  // polling shortly after the first one. Importing from here too gives the sweep a later
  // attempt, which matters because Baileys may still be pulling history off the phone when
  // the connection first opens. The lease and last_sync_at keep it to one real run.
  if (state === "open" && !instance.last_sync_at) {
    await runInBackground("whatsapp history sync", () => importEvolutionHistory({
      admin,
      api: createEvolutionApi(),
      account: { ...account, platform_user_id: ownerNumber },
      instanceName: instance.instance_name,
    }));
  }
}

async function handleQrUpdate(admin: any, socialAccountId: string, data: any): Promise<void> {
  const qr = data?.qrcode?.base64 || data?.qrcode?.code || data?.base64 || data?.code || null;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_qr: qr, last_connection_state: "connecting" })
    .eq("social_account_id", socialAccountId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const instanceName = body?.instance || body?.instanceName;
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!instanceName || !token) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Webhook unavailable" }, 503);
  const admin = createClient(supabaseUrl, serviceRoleKey);

  try {
    const instance = await findInstance(admin, instanceName);
    // Evolution's signed token authenticates the instance, not the body. A captured
    // token can therefore be replayed during its short lifetime; message-id
    // idempotency below makes a replayed inbound message a no-op.
    if (!instance || !(await verifyEvolutionWebhookToken(token, instance.jwt_key))) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const account = await findAccount(admin, instance.social_account_id);
    if (!account) return jsonResponse({ error: "Unauthorized" }, 401);

    const event = normalizeEvolutionEvent(body.event);
    if (event === "MESSAGES_UPSERT") {
      for (const message of messageItems(body)) await persistEvolutionMessage(admin, account, message);
    } else if (event === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(admin, account, instance, body.data);
    } else if (event === "QRCODE_UPDATED") {
      await handleQrUpdate(admin, account.id, body.data);
    }
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("[whatsapp-evolution-webhook] Processing failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Webhook processing failed" }, 500);
  }
});
