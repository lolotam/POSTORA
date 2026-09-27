import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { resolveAutomationHandler } from "../_shared/automationHandler.ts";
import { buildMessagePayload, buildMessagingSender, dispatchMessageEvent } from "../_shared/n8nMessagingDispatch.ts";
import { verifyEvolutionWebhookToken } from "../_shared/evolutionWebhookAuth.ts";
import { normalizeEvolutionEvent } from "../_shared/evolutionApi.ts";
import { syncEvolutionAccountConnection } from "../_shared/evolutionQrAccount.ts";
import { buildEvolutionMessageRow, remoteNumberFor } from "../_shared/evolutionMessage.ts";
import { importEvolutionHistory } from "../_shared/whatsappSyncEngine.ts";
import { ackUpdates, statusesAdvancedBy } from "../_shared/evolutionMessageAck.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import {
  enrichWhatsAppParticipantAvatar,
  WEBHOOK_AVATAR_DEADLINE_MS,
} from "../_shared/whatsappAvatarEnrichment.ts";
import {
  logSkippedUnderstanding,
  runInboundMediaUnderstanding,
} from "../_shared/inboundMediaPipeline.ts";
import { EvolutionFetcher } from "../_shared/inboundMediaFetchers.ts";
import { automationAllowedAfterInbound, inboundOptOutPlan, optOutDb, optOutPersistDecision, recordOptOut } from "../_shared/optOut.ts";

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
    // A deactivated account's Baileys session can stay open for minutes after the
    // product disconnects it (Evolution's logout races the session teardown), and a
    // still-open session keeps delivering webhooks. Without this filter those
    // deliveries kept ingesting messages and dispatching the AI agent for an account
    // the user believed was gone.
    .eq("is_active", true)
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

async function persistEvolutionMessage(
  admin: any,
  account: EvolutionAccount,
  message: any,
  instanceName: string,
): Promise<200 | 500> {
  const built = buildEvolutionMessageRow(account, message);
  if (!built) return 200;
  const { conversationId, sentByOwner, row } = built;
  const remoteNumber = remoteNumberFor(message.key.remoteJid);
  const inboundText = (row.message_text as string) || "";
  // Owner echoes are never opt-outs. A contact opt-out is recorded before the
  // persist RPC. That RPC consumes the redelivery, so recording afterwards
  // would be skipped when the retry lands in the duplicate return.
  const optOutPlan = inboundOptOutPlan(inboundText, sentByOwner);
  if (optOutPlan.recordBeforePersist) {
    const decision = optOutPersistDecision(await recordOptOut(optOutDb(admin), {
      userId: account.user_id,
      socialAccountId: account.id,
      phone: remoteNumber,
      conversationId,
    }));
    // The persist RPC consumes the redelivery. Leave before it when the
    // opt-out row was not written so Evolution retries this delivery.
    if (!decision.persist) {
      console.error("[whatsapp-evolution-webhook] Opt-out row was not stored");
      return decision.status;
    }
  }

  // The persist and the message.received fan-out are ONE statement (D5 R1).
  // The row here can be EITHER direction -- owner-sent echoes go through
  // this same statement as direction "outbound" -- and the SQL function
  // enqueues only for a genuinely inserted INBOUND row, so an owner echo can
  // never surface as a received event.
  const { data: persistResult, error: insertError } = await admin
    .rpc("partner_upsert_whatsapp_message", {
      p_workspace_id: account.workspace_id,
      p_user_id: row.user_id,
      p_social_account_id: row.social_account_id,
      p_conversation_id: row.conversation_id,
      p_message_id: row.message_id,
      p_from_phone: row.from_phone,
      p_from_name: row.from_name,
      p_to_phone: row.to_phone,
      p_message_text: row.message_text,
      p_message_type: row.message_type,
      p_media_url: row.media_url ?? null,
      p_media_type: row.media_type,
      p_media_metadata: row.media_metadata,
      p_direction: row.direction,
      p_status: row.status,
      p_timestamp: row.timestamp,
    });

  // Without this a failed write is indistinguishable from the deliberate duplicate skip
  // below, which is how a silent persistence failure could look like normal operation.
  if (insertError) {
    console.error("[whatsapp-evolution-webhook] Message persist failed:", insertError.message);
    return 200;
  }
  const persisted = (persistResult ?? [])[0] as
    | { row_id: string | null; was_inserted: boolean }
    | undefined;
  if (!persisted || !persisted.was_inserted) return 200;

  await touchConversation(admin, account, {
    conversationId,
    participantName: built.participantName,
    preview: built.preview,
    timestamp: built.timestamp,
    unreadDelta: sentByOwner ? 0 : 1,
  });
  // Owner-sent echoes still enrich the other party; skip only the automation fan-out.
  await enrichWhatsAppParticipantAvatar(
    {
      admin,
      cacheAvatar: cacheAvatarToCdn,
      deadlineAt: Date.now() + WEBHOOK_AVATAR_DEADLINE_MS,
      fetchProfilePictureUrl: (name, number) =>
        createEvolutionApi().fetchProfilePictureUrl(name, number),
    },
    {
      userId: account.user_id,
      workspaceId: account.workspace_id,
      accountId: account.id,
      conversationId,
      instanceName,
      contactNumber: remoteNumber,
    },
  );
  // Inbound row and inbox cache are stored. The opt-out was recorded before the
  // persist RPC, and no agent reply is enqueued. Leave before n8n and the agent.
  if (!automationAllowedAfterInbound({ optedOut: optOutPlan.recordBeforePersist })) return 200;

  // Only a message from the contact is an inbound event for automations; echoing the
  // operator's own reply back into n8n would retrigger their workflows on their own text.
  if (sentByOwner) return 200;

  const automationHandler = resolveAutomationHandler(account.account_metadata);

  if (automationHandler === "n8n") {
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

  if (automationHandler !== "internal" || !inboundText.trim()) return 200;

  // Evolution builds "[Document] <filename>" from a sender-chosen name, exactly like the
  // Cloud path. Keep it out of the keyword matcher and out of the model: there it is an
  // instruction the customer never typed. The stored row keeps the filename.
  const promptSafeText = (row.media_type as string | null) === "document"
    ? "[Document]"
    : inboundText;

  // Same shape as the Cloud path: understand the media FIRST, then give the agent the
  // transcript instead of "[Audio message]". Evolution hands over bytes through its own
  // instance API rather than a URL, which is the only difference -- and it lives entirely
  // inside EvolutionFetcher (spec D9).
  const mediaKind = row.media_type as string | null;
  const mediaMime = (row.media_metadata as { mime_type?: string } | null)?.mime_type ?? null;

  if ((mediaKind === "audio" || mediaKind === "image" || mediaKind === "document") && mediaMime) {
    const mediaRowId = persisted?.row_id ?? null;
    await runInBackground("evolution inbound media understanding", async () => {
      const evolutionBase = Deno.env.get("EVOLUTION_API_URL");
      const evolutionKey = Deno.env.get("EVOLUTION_API_KEY");
      const outcome = evolutionBase && evolutionKey
        ? await runInboundMediaUnderstanding(admin, {
          account: {
            id: account.id,
            user_id: account.user_id,
            platform_user_id: account.platform_user_id,
            connection_mode: "evolution_qr",
            account_metadata: account.account_metadata,
          },
          // Keys the per-sender sub-cap: digits-only, and already the sender id used for
          // this row's contact.
          senderId: remoteNumber,
          messageRowId: mediaRowId,
          mediaId: row.message_id as string,
          mimeType: mediaMime,
          caption: inboundText.startsWith("[") ? null : inboundText,
          platform: "whatsapp",
        }, {
          fetchers: [new EvolutionFetcher(evolutionBase, evolutionKey, instanceName)],
        })
        : { understood: false as const, reason: "evolution credentials missing" };

      if (!outcome.understood) {
        logSkippedUnderstanding("whatsapp-evolution-webhook", outcome.reason);
      }
      const agentInput = outcome.understood ? outcome.agentText : promptSafeText;
      // Without this the reply endpoint falls back to counting characters, and the English
      // data-marker around an Arabic transcript wins -- the exact bug this feature hit on
      // the Cloud path. Evolution needs the same hint.
      await triggerAiAgentReply(
        account, conversationId, account.platform_user_id, remoteNumber, agentInput,
        outcome.understood ? outcome.languageCode : undefined,
      );
    });
    return 200;
  }

  triggerAiAgentReply(
    account,
    conversationId,
    account.platform_user_id,
    remoteNumber,
    promptSafeText,
  ).catch((e) => console.error("[whatsapp-evolution-webhook] AI agent dispatch failed:", e?.message || e));

  return 200;
}

async function triggerAiAgentReply(
  account: { id: string; user_id: string },
  conversationId: string,
  phoneNumberId: string,
  recipientPhone: string,
  inboundText: string,
  languageHint?: string,
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
      ...(languageHint ? { language_hint: languageHint } : {}),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[whatsapp-evolution-webhook] ai-agent-reply returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

// A server ack for one of our own sends. Scoped to the account the token authenticated. The
// rank check lives in the UPDATE predicate: delivery and read acks for one message can run
// concurrently, and a read-then-write let the later DELIVERY_ACK overwrite READ.
async function handleMessagesUpdate(admin: any, account: EvolutionAccount, body: any): Promise<void> {
  for (const update of ackUpdates(messageItems(body))) {
    const { error } = await admin
      .from("whatsapp_messages")
      .update({ status: update.status })
      .eq("social_account_id", account.id)
      .eq("message_id", update.messageId)
      .in("status", statusesAdvancedBy(update.status));
    if (error) throw error;
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
      for (const message of messageItems(body)) {
        const status = await persistEvolutionMessage(admin, account, message, instance.instance_name);
        if (status !== 200) return jsonResponse({ error: "Webhook processing failed" }, status);
      }
    } else if (event === "MESSAGES_UPDATE") {
      await handleMessagesUpdate(admin, account, body);
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
