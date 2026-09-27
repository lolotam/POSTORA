import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { buildObservation, flushObservations, type UnmatchedObservation } from "../_shared/unmatchedWebhookObservation.ts";
import { resolveAutomationHandler } from "../_shared/automationHandler.ts";
import {
  logSkippedUnderstanding,
  runInboundMediaUnderstanding,
} from "../_shared/inboundMediaPipeline.ts";
import { cancelOutboxRow } from "../ai-agent-reply/outbox.ts";
import { enqueueAgentReply } from "../_shared/pendingReplies.ts";
import { dispatchAgentReply } from "../_shared/agentReplyDispatch.ts";
import { cloudButtonContent, isPlaceholderOnly, promptSafeInput } from "./messageContent.ts";
import { isOptOutMessage, optOutDb, recordOptOut } from "../_shared/optOut.ts";
import {
  isDispatchIntentId,
  reconcileDispatchIntentByEcho,
} from "../_shared/partnerDispatchIntents.ts";
import { buildMessagePayload, buildMessagingSender, dispatchMessageEvent, shouldDispatchInboundMessage } from "../_shared/n8nMessagingDispatch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Anti-loop: track last auto-reply time per conversation
const lastAutoReplyMap = new Map<string, number>();
const AUTO_REPLY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

interface WhatsAppAccount {
  id: string;
  user_id: string;
  workspace_id: string;
  platform_user_id?: string | null;
  platform_username?: string | null;
  access_token: string | null;
  account_metadata: Record<string, unknown> | null;
  connection_mode?: string | null;
}

// The exact strings extractMessageContent produces when there is no caption. Used to tell
// "no caption" from a caption that merely looks like one.
interface MessageContent {
  messageText: string;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaMetadata: Record<string, unknown> | null;
  /**
   * What the customer actually typed alongside the media, where that is not already
   * `messageText`.
   *
   * Images and videos put their caption straight into `messageText`; a document cannot,
   * because `messageText` has to carry the filename for the inbox to display. Keeping the
   * two apart is what lets the filename stay in storage while only the caption -- the part
   * a human wrote -- reaches the rules and the model.
   */
  caption: string | null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

async function hasValidMetaSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const hexDigest = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return constantTimeEqual(signature, `sha256=${hexDigest}`);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // GET: Meta webhook verification challenge
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(challenge, { status: 200 });
    }
    console.warn("[whatsapp-webhook] Verification failed - token mismatch");
    return new Response("Forbidden", { status: 403 });
  }

  // POST: Incoming webhook events from Meta
  if (req.method === "POST") {
    const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ||
      Deno.env.get("META_APP_SECRET") ||
      Deno.env.get("FACEBOOK_APP_SECRET");
    const signature = req.headers.get("x-hub-signature-256");

    if (!appSecret || !signature) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = await req.text();
    if (!(await hasValidMetaSignature(rawBody, signature, appSecret))) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const body = JSON.parse(rawBody);
      console.log("[whatsapp-webhook] Received verified event");

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseKey);

      const entries = body?.entry || [];
      // Collected across the request and written once: runInBackground's degraded path
      // awaits up to 2s per call, so a per-event write would charge that to the ack.
      const unmatched: UnmatchedObservation[] = [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change.value;
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          // Find the social account up front: embedded-signup accounts carry
          // their own access token, needed for media resolution and auto-replies.
          const account = await findWhatsAppAccount(adminClient, phoneNumberId);
          const accessToken: string | null =
            account?.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || null;

          if (change.field === "messages") {
            // Status updates resolve by wamid, not account, so they are
            // processed even when no active account matches.
            await handleLiveMessages(adminClient, account, value, accessToken, unmatched, entry, change);
          } else if (!account) {
            console.warn(`[whatsapp-webhook] No matching account found for field: ${change.field}, phone_number_id: ${value?.metadata?.phone_number_id}`);
            // history / smb_message_echoes / smb_app_state_sync -- not inbound messages,
            // so the kind is 'unknown' and change.field carries what was actually dropped.
            unmatched.push(buildObservation({
              recipientId: phoneNumberId,
              eventKind: "unknown",
              inactiveAccount: await findAnyWhatsAppAccount(adminClient, phoneNumberId),
              entry,
              change,
            }));
            continue;
          } else if (change.field === "history") {
            await handleHistorySync(adminClient, account, value);
          } else if (change.field === "smb_message_echoes") {
            await handleEchoes(adminClient, account, value, accessToken);
          } else if (change.field === "smb_app_state_sync") {
            await handleContactSync(adminClient, account, value);
          }
        }
      }

      await runInBackground(
        "whatsapp unmatched observations",
        () => flushObservations(adminClient, "whatsapp", unmatched),
      );

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch {
      console.error("[whatsapp-webhook] Webhook processing failed");
      return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

// Diagnostic-only twin of findWhatsAppAccount, without the is_active filter. Tells "your
// number, but disconnected" apart from "this number is not in Postora"; never routed.
async function findAnyWhatsAppAccount(
  adminClient: any,
  phoneNumberId: string,
): Promise<{ id: string; user_id: string } | null> {
  const { data } = await adminClient
    .from("social_accounts")
    .select("id, user_id")
    .eq("platform", "whatsapp")
    .eq("platform_user_id", phoneNumberId)
    .limit(1);
  return data?.[0] ?? null;
}

async function findWhatsAppAccount(adminClient: any, phoneNumberId: string): Promise<WhatsAppAccount | null> {
  const { data: accounts } = await adminClient
    .from("social_accounts")
    .select("id, user_id, workspace_id, platform_user_id, platform_username, access_token, account_metadata, connection_mode")
    .eq("platform", "whatsapp")
    .eq("platform_user_id", phoneNumberId)
    .eq("is_active", true)
    .limit(1);
  const account = accounts?.[0];
  if (!account) return null;
  if (account.workspace_id) return account as WhatsAppAccount;

  // Legacy accounts may predate workspace_id. Resolve their owner's personal
  // workspace without changing Meta signature verification or webhook auth.
  const { data: workspace } = await adminClient
    .from("workspaces")
    .select("id")
    .eq("owner_id", account.user_id)
    .eq("is_personal", true)
    .maybeSingle();
  if (!workspace) return null;
  return { ...account, workspace_id: workspace.id } as WhatsAppAccount;
}

// Maps a Cloud API message object (live, history, or echo — all share the same
// per-type content shape) to display text + media info. Media URL resolution is
// optional so bulk history imports don't fan out one Graph call per media message.
async function extractMessageContent(
  msg: any,
  accessToken: string | null,
  resolveMedia: boolean,
): Promise<MessageContent> {
  const msgType = msg.type;
  let messageText = "";
  let mediaUrl: string | null = null;
  let mediaType: string | null = null;
  let mediaMetadata: Record<string, unknown> | null = null;
  let caption: string | null = null;

  if (msgType === "text") {
    messageText = msg.text?.body || "";
  } else if (msgType === "image") {
    messageText = msg.image?.caption || `[Image]`;
    mediaType = "image";
    mediaMetadata = { mime_type: msg.image?.mime_type, sha256: msg.image?.sha256, media_id: msg.image?.id };
    if (resolveMedia) mediaUrl = await resolveMediaUrl(msg.image?.id, accessToken);
  } else if (msgType === "video") {
    messageText = msg.video?.caption || `[Video]`;
    mediaType = "video";
    mediaMetadata = { mime_type: msg.video?.mime_type, sha256: msg.video?.sha256, media_id: msg.video?.id };
    if (resolveMedia) mediaUrl = await resolveMediaUrl(msg.video?.id, accessToken);
  } else if (msgType === "document") {
    messageText = `[Document] ${msg.document?.filename || ""}`;
    // Cloud API carries a document caption separately from the filename, and it was being
    // dropped: a customer writing "here is the signed contract" got nothing through.
    caption = msg.document?.caption || null;
    mediaType = "document";
    mediaMetadata = { mime_type: msg.document?.mime_type, sha256: msg.document?.sha256, filename: msg.document?.filename, media_id: msg.document?.id };
    if (resolveMedia) mediaUrl = await resolveMediaUrl(msg.document?.id, accessToken);
  } else if (msgType === "audio") {
    messageText = "[Audio message]";
    mediaType = "audio";
    mediaMetadata = { mime_type: msg.audio?.mime_type, media_id: msg.audio?.id };
    if (resolveMedia) mediaUrl = await resolveMediaUrl(msg.audio?.id, accessToken);
  } else if (msgType === "sticker") {
    messageText = "[Sticker]";
    mediaType = "sticker";
    mediaMetadata = { mime_type: msg.sticker?.mime_type, media_id: msg.sticker?.id };
    if (resolveMedia) mediaUrl = await resolveMediaUrl(msg.sticker?.id, accessToken);
  } else if (msgType === "location") {
    messageText = `[Location] ${msg.location?.latitude}, ${msg.location?.longitude}`;
  } else if (msgType === "contacts") {
    messageText = `[Contact] ${msg.contacts?.[0]?.name?.formatted_name || ""}`;
  } else if (msgType === "interactive") {
    messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interactive]";
  } else if (msgType === "button") {
    const button = cloudButtonContent(msg.button);
    messageText = button.text;
    mediaMetadata = button.metadata;
  } else if (msgType === "reaction") {
    messageText = `[Reaction] ${msg.reaction?.emoji || ""}`;
  } else {
    messageText = `[${msgType}]`;
  }

  return { messageText, mediaUrl, mediaType, mediaMetadata, caption };
}

function toIsoTimestamp(timestamp: unknown): string {
  const seconds = parseInt(String(timestamp), 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

// The name the business saved for this contact on their phone, if the
// coexistence contact sync has delivered it. Falls back to null.
async function findSavedContactName(
  adminClient: any,
  workspaceId: string,
  participantWaId: string,
): Promise<string | null> {
  const { data: contact } = await adminClient
    .from("whatsapp_contacts")
    .select("display_name")
    .eq("workspace_id", workspaceId)
    .eq("phone_number", participantWaId.replace(/\D/g, ""))
    .maybeSingle();
  return contact?.display_name || null;
}

// Surfaces/refreshes a conversation row in the inbox list. Never touches
// participant_name or unread_count of an existing row unless resetUnread is set
// (an outbound reply from the phone implies the thread was seen).
async function touchConversation(
  adminClient: any,
  account: WhatsAppAccount,
  conversationId: string,
  participantWaId: string,
  preview: string,
  timestampIso: string,
  opts: { onlyIfNewer: boolean; resetUnread: boolean },
): Promise<void> {
  const { data: cached } = await adminClient
    .from("messaging_cache")
    .select("last_message_at")
    .eq("user_id", account.user_id)
    .eq("workspace_id", account.workspace_id)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (cached) {
    const isNewer = !cached.last_message_at ||
      new Date(timestampIso).getTime() > new Date(cached.last_message_at).getTime();
    if (opts.onlyIfNewer && !isNewer) return;

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (isNewer) {
      update.last_message_preview = preview.slice(0, 200);
      update.last_message_at = timestampIso;
    }
    if (opts.resetUnread) update.unread_count = 0;

    await adminClient
      .from("messaging_cache")
      .update(update)
      .eq("user_id", account.user_id)
      .eq("workspace_id", account.workspace_id)
      .eq("conversation_id", conversationId);
    return;
  }

  const savedName = await findSavedContactName(adminClient, account.workspace_id, participantWaId);

  await adminClient.from("messaging_cache").insert({
    user_id: account.user_id,
    workspace_id: account.workspace_id,
    social_account_id: account.id,
    conversation_id: conversationId,
    platform: "whatsapp",
    participant_name: savedName || `+${participantWaId}`,
    participant_avatar: null,
    last_message_preview: preview.slice(0, 200),
    last_message_at: timestampIso,
    unread_count: 0,
    updated_at: new Date().toISOString(),
  });
}

async function handleLiveMessages(
  adminClient: any,
  account: WhatsAppAccount | null,
  value: any,
  accessToken: string | null,
  unmatched?: UnmatchedObservation[],
  entry?: any,
  change?: any,
) {
  const phoneNumberId = value.metadata.phone_number_id;
  const displayPhone = value?.metadata?.display_phone_number;

  // Process incoming messages
  const messages = value?.messages || [];
  for (const msg of messages) {
    if (!account) {
      console.warn("[whatsapp-webhook] No matching account found");
      // The break below sits ahead of the echo filter, so unlike the Facebook/Instagram
      // message branch this point is reachable by our own outbound echoes. Gate the
      // observation on the same predicate the router uses rather than reordering the
      // router itself -- recording an echo as an undeliverable inbound message would be
      // a false alarm pointing at the account's own traffic.
      // Scan the whole array, not just this first message: the break below ends the loop
      // immediately, so gating on msg alone would miss a real inbound message sitting
      // behind one of our own echoes.
      const hasInbound = messages.some((candidate: any) =>
        shouldDispatchInboundMessage({ isEcho: candidate?.is_echo })
      );
      if (unmatched && hasInbound) {
        unmatched.push(buildObservation({
          recipientId: phoneNumberId,
          eventKind: "message",
          inactiveAccount: await findAnyWhatsAppAccount(adminClient, phoneNumberId),
          entry,
          change,
        }));
      }
      break;
    }
    const from = msg.from;
    if (!shouldDispatchInboundMessage({ isEcho: msg.is_echo })) continue;
    const msgType = msg.type;
    const messageId = msg.id;

    const { messageText, mediaUrl, mediaType, mediaMetadata, caption } =
      await extractMessageContent(msg, accessToken, true);

    const conversationId = `wa_${phoneNumberId}_${from.replace(/\D/g, "")}`;

    const contacts = value?.contacts || [];
    const contactName = contacts.find((c: any) => c.wa_id === from)?.profile?.name || from;
    const msgTimestamp = toIsoTimestamp(msg.timestamp);

    // Inbox list name: the business's saved phone contact beats the customer's
    // self-chosen push name; the per-message from_name keeps the push name.
    const savedName = await findSavedContactName(adminClient, account.workspace_id, from);
    const participantName = savedName || contactName;

    // Store individual message with media info, and enqueue the
    // message.received partner event in the SAME statement (D5 R1: a second
    // client call after this one would have a crash gap between the row and
    // the event -- the exact gap the outbox exists to close). The SQL
    // function performs the (user_id, message_id) upsert that consumes
    // Meta's redeliveries AND fans out to matching webhook subscriptions
    // atomically; a duplicate message id inserts nothing and emits nothing.
    const { data: persistResult, error: persistError } = await adminClient
      .rpc("partner_upsert_whatsapp_message", {
        p_workspace_id: account.workspace_id,
        p_user_id: account.user_id,
        p_social_account_id: account.id,
        p_conversation_id: conversationId,
        p_message_id: messageId,
        p_from_phone: from,
        p_from_name: contactName,
        p_to_phone: displayPhone ?? null,
        p_message_text: messageText,
        p_message_type: msgType,
        p_media_url: mediaUrl,
        p_media_type: mediaType,
        p_media_metadata: mediaMetadata,
        p_direction: "inbound",
        p_status: "received",
        p_timestamp: msgTimestamp,
      });
    // A failed write is not a duplicate. Logging it here distinguishes the
    // two, which is the distinction the Evolution path already drew.
    if (persistError) {
      console.error("[whatsapp-webhook] Inbound message persist failed:", persistError.message);
      continue;
    }
    const persisted = (persistResult ?? [])[0] as
      | { row_id: string | null; was_inserted: boolean }
      | undefined;

    if (!persisted || !persisted.was_inserted) {
      console.log("[whatsapp-webhook] Duplicate inbound message skipped");
      continue;
    }

    // The outbox row is created HERE, one statement after the insert that consumes Meta's
    // redelivery, and before any other awaited work.
    //
    // That ordering is the whole point. The upsert above is the idempotency claim: once it
    // succeeds, a redelivery of the same message is a no-op and `continue`s. So every await
    // between that claim and the enqueue is a window in which a killed worker loses the
    // message with no possibility of recovery -- the platform will not tell us again. It
    // used to include the messaging_cache upsert, two contact lookups and processAutoReplies,
    // which can itself send. Now it includes nothing.
    const automationHandler = resolveAutomationHandler(account.account_metadata);
    const promptSafeText = promptSafeInput(mediaType, messageText, caption);
    const enqueued = automationHandler === "internal"
      ? await enqueueAgentReply(adminClient, {
        socialAccountId: account.id,
        platform: "whatsapp",
        messageId,
        conversationId,
        recipientId: from,
        inboundText: promptSafeText,
        // The platform's timestamp, not now(): a delayed webhook must not be ordered as
        // though it had just arrived, and the 24h window is measured from it.
        inboundAt: msgTimestamp,
        mediaUrl,
        mediaKind: mediaType,
        mediaCaption: caption,
      })
      : null;
    // A redelivery whose predecessor died after enqueuing does not start a second reply --
    // the owner holds a lease, and recovery is the backstop. A row that could not be written
    // at all still replies, which is the one degradation this design accepts.
    if (enqueued && !enqueued.newlyEnqueued) continue;
    const outboxId = enqueued?.id ?? null;

    // Upsert messaging_cache, incrementing the unread counter
    const { data: cachedConversation } = await adminClient
      .from("messaging_cache")
      .select("unread_count")
      .eq("user_id", account.user_id)
      .eq("workspace_id", account.workspace_id)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    await adminClient
      .from("messaging_cache")
      .upsert({
        user_id: account.user_id,
        workspace_id: account.workspace_id,
        social_account_id: account.id,
        conversation_id: conversationId,
        platform: "whatsapp",
        participant_name: participantName,
        participant_avatar: null,
        last_message_preview: messageText.slice(0, 200),
        last_message_at: msgTimestamp,
        unread_count: (cachedConversation?.unread_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "user_id,conversation_id",
      });

    console.log("[whatsapp-webhook] Stored inbound message");

    // Opt-out lands before n8n dispatch and auto-replies, so it holds with the agent off.
    // The outbox row enqueued above is cancelled: nothing answers an opt-out.
    const optedOut = isOptOutMessage(messageText);
    if (optedOut) {
      await recordOptOut(optOutDb(adminClient), {
        userId: account.user_id,
        socialAccountId: account.id,
        phone: from,
        conversationId,
      });
      if (outboxId) await cancelOutboxRow(adminClient, outboxId, "opted_out");
    }

    if (automationHandler === "n8n") {
      await runInBackground("whatsapp message dispatch", () => dispatchMessageEvent(
        adminClient,
        account.user_id,
        buildMessagePayload({
          platform: "whatsapp",
          socialAccountId: account.id,
          account: { id: account.id, platform: "whatsapp", platform_user_id: account.platform_user_id, platform_username: account.platform_username },
          conversationId,
          // `from` is the digits-only wa_id, so it serves as both sender id and phone.
          sender: buildMessagingSender({
            platform: "whatsapp",
            id: from,
            name: contactName,
            phone: from,
          }),
          message: {
            id: messageId,
            text: messageText,
            type: msgType,
            attachments: mediaUrl ? [{ url: mediaUrl, type: mediaType, metadata: mediaMetadata }] : [],
          },
          timestamp: msgTimestamp,
        }),
      ));
    }

    if (optedOut) continue;

    // promptSafeText is computed with the enqueue above, because the row records it.
    //
    // A document's text is "[Document] <filename>", and the sender chooses that filename.
    // Stored and dispatched it is data; fed to a keyword matcher it lets a sender trigger
    // an away rule by naming a file, and fed to the model it is an instruction the customer
    // never typed. Both consumers get the constant instead. Genuine captions -- which the
    // same check identifies -- still pass through untouched.
    const ruleReplied = automationHandler === "internal"
      ? await processAutoReplies(adminClient, account, {
        conversationId,
        phoneNumberId,
        recipientPhone: from,
        inboundText: promptSafeText,
        accessToken,
        releaseToRule: () => outboxId ? cancelOutboxRow(adminClient, outboxId, "rule_replied") : Promise.resolve(true),
      })
      : false;

    // Deterministic keyword/away rules outrank the AI; only unanswered
    // messages reach the agent. Imported/history/echo messages never get
    // here (see handleHistorySync guard), so the AI cannot reply to them.
    if (automationHandler === "internal" && ruleReplied && outboxId) {
      // Covers the suppression paths that return true WITHOUT sending -- an active cooldown,
      // or a matched rule with no access token. releaseToRule already cancelled the row on
      // the path that does send, and a second cancel of an already-cancelled row is refused
      // and logged rather than doing harm.
      await cancelOutboxRow(adminClient, outboxId, "rule_replied");
    }
    if (automationHandler === "internal" && !ruleReplied) {
      const understandableKind = mediaType === "audio" || mediaType === "image" ||
        mediaType === "document";
      const mediaMime = (mediaMetadata as { mime_type?: string } | null)?.mime_type ?? null;
      await replyThroughAgent(adminClient, account, accessToken, {
        outboxId,
        phoneNumberId,
        from,
        conversationId,
        promptSafeText,
        media: understandableKind && mediaMime
          ? {
            rowId: persisted.row_id ?? null,
            id: (mediaMetadata as { media_id?: string } | null)?.media_id ?? null,
            url: mediaUrl,
            kind: mediaType!,
            mime: mediaMime,
            // Compare against this type's placeholder. `startsWith("[")` discarded genuine
            // captions such as "[URGENT] leaking pipe".
            caption: caption ?? (isPlaceholderOnly(mediaType!, messageText) ? null : messageText),
          }
          : null,
      });
    }
  }

  // Process status updates — write back to whatsapp_messages and surface failures
  const statuses = value?.statuses || [];
  for (const status of statuses) {
    const wamid: string | undefined = status.id;
    const newStatus: string = status.status; // sent | delivered | read | failed
    const errObj = Array.isArray(status.errors) && status.errors.length ? status.errors[0] : null;
    const errorCode: string | null = errObj ? String(errObj.code ?? "") : null;
    const rawErrorMessage: string | null = errObj?.message || errObj?.title || null;

    // Friendly mapping for common codes
    let friendlyError = rawErrorMessage;
    if (errorCode === "131047") {
      friendlyError = "Recipient hasn't messaged you in the last 24h — send an approved Template Message instead.";
    } else if (errorCode === "131026") {
      friendlyError = "Message undeliverable — recipient may not have WhatsApp.";
    } else if (errorCode === "131051") {
      friendlyError = "Unsupported message type for this recipient.";
    }

    console.log(`[whatsapp-webhook] Received ${newStatus} status update`);

    if (!wamid) continue;

    // D13 reconciliation (deliverable 3.4): a status whose
    // biz_opaque_callback_data carries one of our dispatch intent ids is the
    // POSITIVE signal that the send happened — the only thing that resolves
    // an `indeterminate` intent. This must be a SEPARATE lookup from the
    // whatsapp_messages update above: in the crash case persistOutbound never
    // ran (it writes that row only after a wamid is known), so the update
    // matches nothing and this echo is the only reconciliation channel.
    //
    // Whether Meta echoes the field for TEMPLATE sends at all is unconfirmed
    // (it is documented for free-form messages; see the D13 decision record).
    // If the echo never arrives, every indeterminate intent simply stays
    // terminal — today's behaviour — so this degrades safely by design.
    // Reconciliation moves a row to reconciled_sent and never marks anything
    // resendable; there is no such transition in the state machine.
    const echoedIntentId = status?.biz_opaque_callback_data;
    if (isDispatchIntentId(echoedIntentId)) {
      await reconcileDispatchIntentByEcho(adminClient, echoedIntentId, wamid);
    }

    // Update the original message row AND enqueue the message.delivered /
    // .read / .failed partner event in the same statement (D5 R1). The SQL
    // function keeps this handler's exact update semantics (error fields
    // only where present) and emits only for the three certified status
    // transitions -- a 'sent' status is not an event, because D6 renamed
    // message.sent to message.accepted and its certified producer is the
    // dispatch settle, not a status echo. The occurrence id is
    // message.<status>:<wamid>, so the three transitions of one message can
    // never collide on the resource id alone.
    const { data: updatedRows, error: statusError } = await adminClient
      .rpc("partner_apply_whatsapp_message_status", {
        p_message_id: wamid,
        p_status: newStatus,
        p_error_code: errorCode,
        p_error_message: friendlyError,
      });

    if (statusError) {
      // Logged, not fatal: one message's status must not abort the rest of
      // the webhook batch (the same policy the D13 reconcile follows).
      console.error("[whatsapp-webhook] Status apply failed:", statusError.message);
    } else if (newStatus === "failed" && updatedRows && updatedRows.length > 0) {
      const row = updatedRows[0] as {
        conversation_id: string;
        user_id: string;
        social_account_id: string;
        message_text: string | null;
      };
      const warnPreview = `⚠️ ${row.message_text || "(send failed)"}`.slice(0, 200);
      await adminClient
        .from("messaging_cache")
        .update({
          last_message_preview: warnPreview,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", row.user_id)
        .eq("conversation_id", row.conversation_id);
    }
  }
}

// Coexistence one-time history push: Meta sends recent phone threads in chunks
// minutes after an onboarding where the user approved chat-history sharing.
// Imported messages must never trigger auto-replies, external webhook dispatch,
// or unread badges — they were already handled on the phone.
async function handleHistorySync(
  adminClient: any,
  account: WhatsAppAccount,
  value: any,
) {
  const phoneNumberId = value.metadata.phone_number_id;
  const chunks = value?.history || [];
  let imported = 0;

  for (const chunk of chunks) {
    // Meta answers a sync request with an error chunk (e.g. 2593109 "History
    // sync is turned off by the business") instead of threads when the
    // business declined history sharing during onboarding.
    if (chunk?.errors?.length) {
      console.warn(
        `[whatsapp-webhook] History sync error for ${phoneNumberId}:`,
        JSON.stringify(chunk.errors),
      );
      continue;
    }
    const threads = chunk?.threads || [];
    for (const thread of threads) {
      const contactWaId: string | undefined = thread?.id;
      if (!contactWaId) continue;

      const conversationId = `wa_${phoneNumberId}_${contactWaId.replace(/\D/g, "")}`;
      const rows: Record<string, unknown>[] = [];
      let latestTs: string | null = null;
      let latestPreview = "";

      for (const msg of thread?.messages || []) {
        if (!msg?.id) continue;

        const isInbound = msg.from === contactWaId;
        // Media URLs are not resolved for history (media_id kept in metadata):
        // old media is often expired and per-message Graph calls would blow the
        // function budget on large imports.
        const { messageText, mediaType, mediaMetadata } =
          await extractMessageContent(msg, null, false);
        const msgTimestamp = toIsoTimestamp(msg.timestamp);

        rows.push({
          user_id: account.user_id,
          social_account_id: account.id,
          conversation_id: conversationId,
          message_id: msg.id,
          from_phone: isInbound ? contactWaId : phoneNumberId,
          from_name: isInbound ? contactWaId : "You",
          to_phone: isInbound ? phoneNumberId : contactWaId,
          message_text: messageText,
          message_type: msg.type || "text",
          media_url: null,
          media_type: mediaType,
          media_metadata: mediaMetadata,
          direction: isInbound ? "inbound" : "outbound",
          status: msg.history_context?.status || (isInbound ? "received" : "sent"),
          timestamp: msgTimestamp,
        });

        if (!latestTs || new Date(msgTimestamp).getTime() > new Date(latestTs).getTime()) {
          latestTs = msgTimestamp;
          latestPreview = messageText;
        }
      }

      if (rows.length === 0) continue;

      // One statement whose rows commit EITHER direction depending on the
      // per-row isInbound boolean -- the trap the producer ledger names. The
      // SQL function performs the whole bulk upsert and enqueues
      // message.received for the genuinely INSERTED INBOUND rows only, in
      // the same transaction: a hook attached to "the statement" would fire
      // for the thread's outbound rows too, and that is precisely what must
      // not happen.
      const { data: insertedCount, error: batchError } = await adminClient
        .rpc("partner_import_whatsapp_message_batch", {
          p_workspace_id: account.workspace_id,
          p_rows: rows,
        });
      if (batchError) {
        console.error("[whatsapp-webhook] History batch insert failed:", batchError.message);
        continue;
      }
      imported += insertedCount ?? 0;

      await touchConversation(
        adminClient,
        account,
        conversationId,
        contactWaId,
        latestPreview,
        latestTs!,
        { onlyIfNewer: true, resetUnread: false },
      );
    }
  }

  console.log(`[whatsapp-webhook] History sync stored ${imported} messages`);
}

// Coexistence echo: a message the business sent from the WhatsApp Business app.
// Mirrors it into the web inbox as outbound; no auto-replies or dispatch.
async function handleEchoes(
  adminClient: any,
  account: WhatsAppAccount,
  value: any,
  accessToken: string | null,
) {
  const phoneNumberId = value.metadata.phone_number_id;
  const echoes = value?.message_echoes || [];

  for (const msg of echoes) {
    if (!msg?.id || !msg?.to) continue;

    const recipient = String(msg.to).replace(/\D/g, "");
    const conversationId = `wa_${phoneNumberId}_${recipient}`;
    const { messageText, mediaUrl, mediaType, mediaMetadata } =
      await extractMessageContent(msg, accessToken, true);
    const msgTimestamp = toIsoTimestamp(msg.timestamp);

    const { data: insertedRows } = await adminClient
      .from("whatsapp_messages")
      .upsert({
        user_id: account.user_id,
        social_account_id: account.id,
        conversation_id: conversationId,
        message_id: msg.id,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient,
        message_text: messageText,
        message_type: msg.type || "text",
        media_url: mediaUrl,
        media_type: mediaType,
        media_metadata: mediaMetadata,
        direction: "outbound",
        status: "sent",
        timestamp: msgTimestamp,
      }, { onConflict: "user_id,message_id", ignoreDuplicates: true })
      .select("id");

    if (!insertedRows || insertedRows.length === 0) {
      console.log("[whatsapp-webhook] Duplicate echo skipped");
      continue;
    }

    await touchConversation(
      adminClient,
      account,
      conversationId,
      recipient,
      messageText,
      msgTimestamp,
      { onlyIfNewer: false, resetUnread: true },
    );

    console.log("[whatsapp-webhook] Stored phone-sent echo");
  }
}

// Coexistence contact sync: the business's saved phone contacts, pushed once
// after onboarding and again on every add/edit/remove in the WhatsApp Business
// app. Saved names are mirrored into whatsapp_contacts and onto existing
// conversation rows so the inbox shows names instead of raw numbers.
async function handleContactSync(
  adminClient: any,
  account: WhatsAppAccount,
  value: any,
) {
  const phoneNumberId = value.metadata.phone_number_id;
  let synced = 0;

  for (const entry of value?.state_sync || []) {
    if (entry?.type !== "contact" || entry?.action === "remove") continue;

    const phone = String(entry?.contact?.phone_number || "").replace(/\D/g, "");
    const displayName = entry?.contact?.full_name || entry?.contact?.first_name;
    if (!phone || !displayName) continue;

    await adminClient.from("whatsapp_contacts").upsert({
      user_id: account.user_id,
      workspace_id: account.workspace_id,
      phone_number: phone,
      display_name: displayName,
    }, { onConflict: "user_id,phone_number" });

    await adminClient
      .from("messaging_cache")
      .update({ participant_name: displayName, updated_at: new Date().toISOString() })
      .eq("user_id", account.user_id)
      .eq("workspace_id", account.workspace_id)
      .eq("conversation_id", `wa_${phoneNumberId}_${phone}`);

    synced++;
  }

  console.log(`[whatsapp-webhook] Contact sync stored ${synced} contacts`);
}

// Returns true when auto-reply rules own this message (a rule replied, or a
// rule replied recently and the anti-spam cooldown is active), so the AI
// agent should stay silent. Returns false when no rule claimed the message.
interface AutoReplyContext {
  conversationId: string;
  phoneNumberId: string;
  recipientPhone: string;
  inboundText: string;
  accessToken: string | null;
  /**
   * Called once a rule has matched and is about to SEND, and only then. Returning false
   * means the outbox row could not be released -- someone else is answering this message --
   * and the rule must stand down rather than duplicate it.
   *
   * The release has to happen before the provider call, not after: a kill in between would
   * leave the row recoverable and the customer would get the rule's answer and then the
   * agent's. Releasing first fails the other way, which matches the existing precedence --
   * a matched rule suppresses the agent whether or not its own delivery succeeds.
   */
  releaseToRule: () => Promise<boolean>;
}

async function processAutoReplies(
  adminClient: any,
  account: { id: string; user_id: string },
  context: AutoReplyContext,
): Promise<boolean> {
  const { conversationId, phoneNumberId, recipientPhone, inboundText, accessToken } = context;
  try {
    // Check cooldown — set only after a rule reply, so "active" means a rule
    // answered this conversation within the window and still owns it.
    const lastReply = lastAutoReplyMap.get(conversationId);
    if (lastReply && Date.now() - lastReply < AUTO_REPLY_COOLDOWN_MS) {
      console.log("[whatsapp-webhook] Auto-reply cooldown active");
      return true;
    }

    // Fetch active auto-reply rules for this user
    const { data: rules, error } = await adminClient
      .from("whatsapp_auto_replies")
      .select("*")
      .eq("user_id", account.user_id)
      .eq("is_active", true);

    if (error || !rules || rules.length === 0) return false;

    const now = new Date();
    const currentDay = now.getDay(); // 0=Sun
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM

    let matchedReply: string | null = null;
    let matchedRuleId: string | null = null;

    // Check away rules first
    for (const rule of rules) {
      if (rule.rule_type !== "away") continue;

      if (rule.schedule_days && !rule.schedule_days.includes(currentDay)) continue;

      if (rule.schedule_start && rule.schedule_end) {
        const start = rule.schedule_start.slice(0, 5);
        const end = rule.schedule_end.slice(0, 5);

        if (start <= end) {
          if (currentTime < start || currentTime > end) continue;
        } else {
          if (currentTime < start && currentTime > end) continue;
        }
      }

      matchedReply = rule.reply_message;
      matchedRuleId = rule.id;
      console.log("[whatsapp-webhook] Away rule matched");
      break;
    }

    // If no away rule matched, check keyword rules
    if (!matchedReply) {
      const lowerText = inboundText.toLowerCase();
      for (const rule of rules) {
        if (rule.rule_type !== "keyword" || !rule.keywords) continue;
        const matched = rule.keywords.some((kw: string) => lowerText.includes(kw.toLowerCase()));
        if (matched) {
          matchedReply = rule.reply_message;
          matchedRuleId = rule.id;
          console.log("[whatsapp-webhook] Keyword rule matched");
          break;
        }
      }
    }

    if (!matchedReply) return false;

    // Send auto-reply via WhatsApp Cloud API using the account's own token
    // (env WHATSAPP_ACCESS_TOKEN fallback happens at the call site)
    if (!accessToken) {
      console.error("[whatsapp-webhook] No access token for this account and WHATSAPP_ACCESS_TOKEN not set, cannot send auto-reply");
      // A rule matched: keep AI out even though the send failed, so the AI
      // never overrides a deterministic answer the business configured.
      return true;
    }

    // The rule owns this message now. Release the outbox row before the provider call.
    if (!await context.releaseToRule()) {
      console.warn("[whatsapp-webhook] auto-reply stood down: the outbox row moved on");
      return true;
    }

    const sendRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipientPhone,
          type: "text",
          text: { body: matchedReply },
        }),
      }
    );

    const sendData = await sendRes.json();
    console.log("[whatsapp-webhook] Auto-reply request completed");

    if (sendRes.ok) {
      // Store outbound auto-reply in whatsapp_messages
      const outboundMsgId = sendData?.messages?.[0]?.id || `auto_${Date.now()}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: account.user_id,
        social_account_id: account.id,
        conversation_id: conversationId,
        message_id: outboundMsgId,
        from_phone: phoneNumberId,
        from_name: "Auto-Reply",
        to_phone: recipientPhone,
        message_text: matchedReply,
        message_type: "text",
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Update cooldown
      lastAutoReplyMap.set(conversationId, Date.now());

      // Log auto-reply usage for analytics
      if (matchedRuleId) {
        await adminClient.from("whatsapp_auto_reply_usage").insert({
          user_id: account.user_id,
          auto_reply_rule_id: matchedRuleId,
          conversation_id: conversationId,
        }).then(() => {
          console.log(`[whatsapp-webhook] Auto-reply usage logged for rule ${matchedRuleId}`);
        }).catch((e: any) => {
          console.warn("[whatsapp-webhook] Failed to log auto-reply usage:", e);
        });
      }
    }
    // A rule matched; the AI must not answer on top of it even if the Graph
    // send was rejected — precedence is decided by the match, not the send.
    return true;
  } catch {
    console.error("[whatsapp-webhook] Auto-reply failed");
    // Rule evaluation itself failed before any match was established, so the
    // AI agent may still answer as a fallback.
    return false;
  }
}

interface InboundForAgent {
  /** The row the caller already enqueued, or null when it could not be written. */
  outboxId: string | null;
  phoneNumberId: string;
  from: string;
  conversationId: string;
  /** What the rules and the model may read: the placeholder, never a sender-chosen filename. */
  promptSafeText: string;
  media: {
    rowId: string | null;
    id: string | null;
    url: string | null;
    kind: string;
    mime: string;
    caption: string | null;
  } | null;
}

/**
 * Hands one inbound message to the AI agent. The ai-agent-reply function enforces its own
 * gates (enabled flag, engagement mode, human assignment, 24h window, cooldown, daily cap).
 *
 * The work item was already recorded by the caller, one statement after the insert that
 * consumes Meta's redelivery -- see the enqueue there for why that ordering is the whole
 * guarantee. Everything from here runs in the background, which is ~50s against a 60s
 * worker ceiling, and is recoverable precisely because the row already exists.
 */
async function replyThroughAgent(
  adminClient: any,
  account: any,
  accessToken: string | null,
  inbound: InboundForAgent,
): Promise<void> {
  const { from, conversationId, media, outboxId } = inbound;

  // Both branches run in the background now. The text-only path used to fire and forget
  // with a bare .catch(), which dropped replies just as readily as the media path did.
  await runInBackground("whatsapp agent reply", async () => {
    const understood = await understandInbound(adminClient, account, accessToken, from, media);

    // The agent owns the row from here and settles every outcome itself. A POST that never
    // reaches it leaves the row pending under its lease -- what recovery is for.
    await dispatchAgentReply({
      userId: account.user_id,
      platform: "whatsapp",
      socialAccountId: account.id,
      conversationId,
      recipientId: from,
      inboundText: understood.text ?? inbound.promptSafeText,
      phoneNumberId: inbound.phoneNumberId,
      languageHint: understood.languageHint,
      outboxId,
    });
  });
}

/**
 * The media's transcript or description, or nulls when there is nothing to read.
 *
 * `text: null` means "use the caller's placeholder" rather than "empty message" -- an empty
 * string here would hand the agent a blank customer message.
 */
async function understandInbound(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  // deno-lint-ignore no-explicit-any
  account: any,
  accessToken: string | null,
  from: string,
  media: InboundForAgent["media"],
): Promise<{ text: string | null; languageHint: string | undefined }> {
  if (!media) return { text: null, languageHint: undefined };

  const outcome = await runInboundMediaUnderstanding(adminClient, {
    account: {
      id: account.id,
      user_id: account.user_id,
      platform_user_id: account.platform_user_id,
      connection_mode: account.connection_mode,
      access_token: accessToken,
      account_metadata: account.account_metadata,
    },
    // Keys the per-sender sub-cap: the customer's phone number, so one number cannot spend
    // the account's whole daily media allowance.
    senderId: from,
    messageRowId: media.rowId,
    mediaId: media.id,
    mediaUrl: media.url,
    mimeType: media.mime,
    caption: media.caption,
    platform: "whatsapp",
  });

  if (outcome.understood) {
    // The transcript's detected language beats counting characters in text that now carries
    // an English data-marker (see detectReplyLanguage).
    return { text: outcome.agentText, languageHint: outcome.languageCode };
  }
  logSkippedUnderstanding("whatsapp-webhook", outcome.reason);
  return { text: null, languageHint: undefined };
}

async function resolveMediaUrl(mediaId: string | undefined, token: string | null): Promise<string | null> {
  if (!mediaId || !token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}
