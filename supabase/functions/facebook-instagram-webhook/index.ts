import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { resolveAutomationHandler, resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { getSendCredentials, type SocialAccountForMessaging } from "../_shared/messengerCredentials.ts";
import { buildCommentPayload, buildMessagePayload, buildMessagingSender, dispatchMessageEvent, dispatchN8nEvent, shouldDispatchInboundMessage } from "../_shared/n8nMessagingDispatch.ts";
import { isOwnComment } from "../_shared/commentAuthor.ts";
import {
  logSkippedUnderstanding,
  runInboundMediaUnderstanding,
} from "../_shared/inboundMediaPipeline.ts";
import { enqueueAgentReply } from "../_shared/pendingReplies.ts";
import { dispatchAgentReply } from "../_shared/agentReplyDispatch.ts";
import { MetaMessagingFetcher } from "../_shared/inboundMediaFetchers.ts";
import {
  attachmentList,
  firstReadableAttachment,
  type InboundAttachment,
  leadPlaceholder,
  noteUnreadAttachments,
} from "./attachments.ts";
import { matchAutoReplyRule } from "../_shared/autoReplyRules.ts";
import { handleCommentInternally } from "../_shared/commentAutomation.ts";
import { normalizeMetaCommentChange } from "./commentEvents.ts";
import {
  buildObservation,
  flushObservations,
  type UnmatchedObservation,
} from "../_shared/unmatchedWebhookObservation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Anti-loop: track last auto-reply time per conversation
const lastAutoReplyMap = new Map<string, number>();
const AUTO_REPLY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, ig_auth_type, account_metadata, access_token";

// Finds the social_accounts row for a webhook entry.id. Instagram Login issues two ids per
// account — an app-scoped one from /me?fields=id and the Instagram-scoped id (IGID) from
// /me?fields=user_id — and messaging webhooks address the account by its IGID. Connect
// stores the app-scoped id in platform_user_id/ig_user_id and the IGID in ig_igid, so all
// three are tried: platform_user_id covers Facebook pages and older Graph-linked Instagram
// accounts, ig_igid covers direct-login accounts, and ig_user_id stays as a fallback for
// rows connected before ig_igid existed.
async function findAccountForRecipient(
  adminClient: any,
  platform: "facebook" | "instagram",
  recipientId: string,
): Promise<SocialAccountForMessaging | null> {
  const { data: byPlatformUserId } = await adminClient
    .from("social_accounts")
    .select(ACCOUNT_SELECT)
    .eq("platform", platform)
    .eq("platform_user_id", recipientId)
    .eq("is_active", true)
    .limit(1);
  if (byPlatformUserId && byPlatformUserId.length > 0) return byPlatformUserId[0];

  if (platform !== "instagram") return null;

  for (const metadataKey of ["ig_igid", "ig_user_id"]) {
    const { data } = await adminClient
      .from("social_accounts")
      .select(ACCOUNT_SELECT)
      .eq("platform", "instagram")
      .eq("is_active", true)
      .eq(`account_metadata->>${metadataKey}`, recipientId)
      .limit(1);
    if (data && data.length > 0) return data[0];
  }
  return null;
}

type InactiveAccountRef = {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string | null;
  platform_username: string | null;
  account_metadata: unknown;
};

// The identity columns are not optional here even though only id and user_id are stored:
// isOwnComment resolves an account's own ids from platform_user_id and the two Instagram
// metadata keys, so a narrower select would make ownIds() empty and every self-authored
// comment read as somebody else's.
const INACTIVE_ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, account_metadata";

// Same resolution as findAccountForRecipient, minus the is_active filter. Diagnostic
// only: it exists to tell "this is your account, but disconnected" apart from "this
// account is not in Postora at all", and its result is never routed or replied to.
// Called only after the active lookup has already failed, so it costs nothing on the
// normal path.
async function findAnyAccountForRecipient(
  adminClient: any,
  platform: "facebook" | "instagram",
  recipientId: string,
): Promise<InactiveAccountRef | null> {
  const { data: byPlatformUserId } = await adminClient
    .from("social_accounts")
    .select(INACTIVE_ACCOUNT_SELECT)
    .eq("platform", platform)
    .eq("platform_user_id", recipientId)
    .limit(1);
  if (byPlatformUserId && byPlatformUserId.length > 0) return byPlatformUserId[0];

  if (platform !== "instagram") return null;

  for (const metadataKey of ["ig_igid", "ig_user_id"]) {
    const { data } = await adminClient
      .from("social_accounts")
      .select(INACTIVE_ACCOUNT_SELECT)
      .eq("platform", "instagram")
      .eq(`account_metadata->>${metadataKey}`, recipientId)
      .limit(1);
    if (data && data.length > 0) return data[0];
  }
  return null;
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
    const verifyToken = Deno.env.get("META_MESSAGING_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[fb-ig-webhook] Verification successful");
      return new Response(challenge, { status: 200 });
    }
    console.warn("[fb-ig-webhook] Verification failed - token mismatch");
    return new Response("Forbidden", { status: 403 });
  }

  // POST: Incoming webhook events from Meta
  if (req.method === "POST") {
    const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
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
      const platform = body.object === "instagram" ? "instagram" : "facebook";
      console.log(`[fb-ig-webhook] Received verified ${platform} event`);

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseKey);

      const entries = body?.entry || [];
      // Collected across the whole request and written once at the end: runInBackground's
      // degraded path awaits up to 2s per call, so a per-event write would charge that to
      // Meta's acknowledgement repeatedly.
      const unmatched: UnmatchedObservation[] = [];
      for (const entry of entries) {
        const recipientId = entry.id;
        const events = entry?.messaging || [];
        let handledMessages = 0;

        for (const event of events) {
          // Only handle actual inbound messages, not delivery/read receipts or echoes of our own sends.
          if (!event.message || !shouldDispatchInboundMessage({ isEcho: event.message.is_echo })) continue;
          handledMessages += 1;

          const account = await findAccountForRecipient(adminClient, platform, recipientId);
          if (!account) {
            console.warn(`[fb-ig-webhook] No matching ${platform} account found for recipient ${recipientId}`);
            // Echoes and receipts were already filtered above, so everything reaching
            // here is a genuine inbound message that could not be delivered.
            unmatched.push(buildObservation({
              recipientId,
              eventKind: "message",
              inactiveAccount: await findAnyAccountForRecipient(adminClient, platform, recipientId),
              entry,
            }));
            continue;
          }

          const senderId: string = event.sender?.id;
          const attachments = attachmentList(event.message);
          const readable = firstReadableAttachment(event.message);
          // The placeholder names what was sent even when nothing can read it, so the agent
          // can say "I can see you sent a video" instead of the useless "[Attachment]".
          const messageText: string = event.message.text || leadPlaceholder(event.message) || "";

          // Keyed by this account's stable internal id rather than any Meta-supplied id: Meta
          // represents the same account/conversation with different external ids depending on
          // which API surface produced them (confirmed for direct-login Instagram accounts,
          // where the id inside conversation payloads differs from platform_user_id). The
          // internal id is the one thing both this webhook and list_conversations agree on.
          const conversationId = `${account.id}_${senderId}`;

          const inboxResult = await recordInboxEvent(adminClient, {
            account,
            platform,
            eventType: "message",
            externalEventId: event.message.mid || `${senderId}:${event.timestamp}`,
            payload: event,
          });

          const automationHandler = resolveAutomationHandler(account.account_metadata);

          // Dispatch stays tied to a successful insert, which is what makes the insert an
          // idempotency claim: Meta retries a failed delivery, and dispatching on error too
          // would run the user's workflow again when that retry finally persists. The
          // failure is logged instead, because it was previously indistinguishable from a
          // message that simply had nothing to dispatch.
          if (inboxResult === "error") {
            console.error(`[fb-ig-webhook] Inbox persist failed for ${platform}; automation not dispatched`);
          }
          // Exactly one handler owns a message. "internal" means the Postora agent
          // answers, so dispatching here too made the n8n workflow reply alongside it --
          // and, whenever the agent failed, instead of it. The comment branch below and
          // whatsapp-webhook both gate on "n8n"; this is the surface that drifted.
          if (inboxResult === "inserted" && automationHandler === "n8n") {
            await runInBackground("facebook-instagram message dispatch", () => dispatchMessageEvent(
              adminClient,
              account.user_id,
              buildMessagePayload({
                platform,
                socialAccountId: account.id,
                account,
                conversationId,
                // Meta messaging webhooks carry only the sender id; phone stays null rather
                // than reading event.sender.phone, which Meta never populates.
                sender: buildMessagingSender({
                  platform,
                  id: senderId,
                  name: event.sender?.name,
                }),
                message: {
                  id: event.message.mid || `${senderId}:${event.timestamp}`,
                  text: messageText,
                  type: event.message.attachments ? "attachment" : "text",
                  attachments: event.message.attachments?.data || event.message.attachments || [],
                },
                timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
              }),
            ));
          }

          console.log(`[fb-ig-webhook] Received inbound ${platform} message`);

          const ruleReplied = automationHandler === "internal"
            ? await processAutoReplies(adminClient, account, platform, conversationId, senderId, messageText)
            : false;

          // Deterministic rules outrank the AI; only unclaimed messages reach
          // the agent. Echoes/receipts never get here (filtered above).
          if (automationHandler === "internal" && !ruleReplied) {
            await replyThroughAgent(adminClient, account, platform, {
              messageId: event.message.mid || `${senderId}:${event.timestamp}`,
              inboundAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
              senderId,
              conversationId,
              messageText,
              caption: event.message.text || null,
              attachments,
              readable,
            });
          }
        }

        for (const change of entry?.changes || []) {
          // Normalized before the inbox claim, not after. The Page-level `feed` subscription
          // that delivers comments also delivers likes, edits and removals, and every one of
          // those carries the same `comment_id`. Claiming the idempotency slot first would let
          // a like on a comment consume that comment's only claim; the real comment then reads
          // back as a duplicate and is dropped, silently and permanently. Meta does not
          // guarantee delivery order, so this is not a theoretical race.
          const normalized = normalizeMetaCommentChange(platform, change);
          if (!normalized) continue;

          const account = await findAccountForRecipient(adminClient, platform, recipientId);
          if (!account) {
            // Unlike the message branch there is no own-comment filter ahead of this
            // point, and there cannot be: isOwnComment below compares the author against
            // the account, so with no account the question is unanswerable. A
            // self-authored comment on an unknown recipient is therefore recorded — which
            // is right, since a comment arriving for an account Postora does not have is
            // exactly the signal this table exists to surface.
            const inactiveAccount = await findAnyAccountForRecipient(adminClient, platform, recipientId);
            if (!inactiveAccount || !isOwnComment(inactiveAccount, normalized.author)) {
              unmatched.push(buildObservation({
                recipientId,
                eventKind: "comment",
                inactiveAccount,
                entry,
                change,
              }));
            }
            continue;
          }

          const inboxResult = await recordInboxEvent(adminClient, {
            account,
            platform,
            eventType: "comment",
            externalEventId: normalized.comment.id,
            payload: change,
          });
          if (inboxResult !== "inserted") continue;
          // The loop breaker, and it must stay ahead of both branches below: whatever replies
          // here comes back as another comment event, and only this check ends that cycle.
          if (isOwnComment(account, normalized.author)) {
            console.log(`[fb-ig-webhook] skipped own ${platform} comment ${normalized.comment.id}`);
            continue;
          }

          const commentHandler = resolveCommentAutomationHandler(account.account_metadata);
          if (commentHandler === "n8n") {
            await runInBackground("facebook-instagram comment dispatch", () => dispatchN8nEvent(
              adminClient,
              account.user_id,
              buildCommentPayload({ platform, socialAccountId: account.id, account, ...normalized }),
            ));
          } else if (commentHandler === "internal") {
            await runInBackground("facebook-instagram comment automation", () => handleCommentInternally(
              adminClient,
              account,
              { comment: normalized.comment, post: normalized.post, author: normalized.author },
            ));
          }
        }

        // Meta delivering an event that yields no message is indistinguishable from Meta
        // not delivering at all, because every filter above continues silently. This
        // records the envelope shape -- never message content -- so a delivery that does
        // not become an inbox event can be told apart from one that never arrived.
        if (handledMessages === 0) {
          console.log(`[fb-ig-webhook] ${platform} entry produced no inbound message`, JSON.stringify({
            entryId: recipientId,
            entryKeys: Object.keys(entry || {}),
            messagingCount: events.length,
            messagingKinds: events.map((event: any) =>
              Object.keys(event || {}).filter((key) => key !== "sender" && key !== "recipient" && key !== "timestamp")
            ),
            changeFields: (entry?.changes || []).map((change: any) => change?.field),
          }));
        }
      }

      // Off the response path, and unable to affect it: flushObservations never throws,
      // and the catch below turns anything that did into a 500, which would make Meta
      // redeliver. A diagnostic must not become a delivery bug.
      await runInBackground(
        "fb-ig unmatched observations",
        () => flushObservations(adminClient, platform, unmatched),
      );

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[fb-ig-webhook] Webhook processing failed:", err);
      return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

async function recordInboxEvent(
  adminClient: any,
  { account, platform, eventType, externalEventId, payload }: {
    account: SocialAccountForMessaging;
    platform: "facebook" | "instagram";
    eventType: "message" | "comment";
    externalEventId: string;
    payload: unknown;
  },
): Promise<"inserted" | "duplicate" | "error"> {
  const { data, error } = await adminClient.from("social_inbox_events").upsert({
    user_id: account.user_id,
    social_account_id: account.id,
    platform,
    event_type: eventType,
    external_event_id: externalEventId,
    payload,
  }, { onConflict: "social_account_id,external_event_id", ignoreDuplicates: true }).select("id");
  if (error) {
    console.error("[fb-ig-webhook] Failed to persist inbox event", error.message);
    return "error";
  }
  return data?.length ? "inserted" : "duplicate";
}

// Returns true when auto-reply rules own this message (a rule matched, or a
// rule replied recently and the anti-spam cooldown is active), so the AI
// agent should stay silent. Returns false when no rule claimed the message.
async function processAutoReplies(
  adminClient: any,
  account: SocialAccountForMessaging,
  platform: "facebook" | "instagram",
  conversationId: string,
  recipientId: string,
  inboundText: string,
): Promise<boolean> {
  try {
    const lastReply = lastAutoReplyMap.get(conversationId);
    if (lastReply && Date.now() - lastReply < AUTO_REPLY_COOLDOWN_MS) {
      console.log("[fb-ig-webhook] Auto-reply cooldown active");
      return true;
    }

    const { data: rules, error } = await adminClient
      .from("messenger_auto_replies")
      .select("*")
      .eq("user_id", account.user_id)
      .eq("platform", platform)
      .eq("is_active", true);

    if (error || !rules || rules.length === 0) return false;

    const match = matchAutoReplyRule(rules, inboundText, new Date());
    if (!match) return false;
    console.log(`[fb-ig-webhook] ${match.ruleType} rule matched`);
    const matchedReply = match.replyMessage;
    const matchedRuleId = match.ruleId;

    // Skip auto-reply while a human agent is actively assigned to this
    // conversation. The rule still "claims" the message (return true): a
    // human-owned conversation must not fall through to the AI either.
    const { data: assignment } = await adminClient
      .from("whatsapp_conversation_assignments")
      .select("id")
      .eq("conversation_id", conversationId)
      .is("unassigned_at", null)
      .maybeSingle();
    if (assignment) {
      console.log("[fb-ig-webhook] Conversation has an active human agent, skipping auto-reply");
      return true;
    }

    const { graphBase, pageId, pageToken } = await getSendCredentials(adminClient, account);
    const sendUrl = `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;

    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: matchedReply },
      }),
    });

    const sendData = await sendRes.json();
    console.log("[fb-ig-webhook] Auto-reply request completed");

    if (sendRes.ok) {
      lastAutoReplyMap.set(conversationId, Date.now());

      if (matchedRuleId) {
        await adminClient.from("messenger_auto_reply_usage").insert({
          user_id: account.user_id,
          auto_reply_rule_id: matchedRuleId,
          conversation_id: conversationId,
        }).then(() => {
          console.log(`[fb-ig-webhook] Auto-reply usage logged for rule ${matchedRuleId}`);
        }).catch((e: unknown) => {
          console.warn("[fb-ig-webhook] Failed to log auto-reply usage:", e);
        });
      }
    } else {
      console.error("[fb-ig-webhook] Auto-reply send failed:", sendData);
    }
    // A rule matched; precedence is decided by the match, not the send result.
    return true;
  } catch (err) {
    console.error("[fb-ig-webhook] Auto-reply failed:", err);
    // Rule evaluation failed before a match was established; the AI agent may
    // still answer as a fallback.
    return false;
  }
}

// Fire-and-forget hand-off to the internal AI agent reply engine. The
// ai-agent-reply function enforces its own gates (enabled flag, engagement
// mode, human assignment, cooldown, daily cap).
interface InboundForAgent {
  messageId: string;
  inboundAt: string;
  senderId: string;
  conversationId: string;
  /** The placeholder as it stands before understanding: what the agent gets if that fails. */
  messageText: string;
  caption: string | null;
  attachments: unknown[];
  readable: InboundAttachment | null;
}

/**
 * Hands one inbound message to the AI agent, durably.
 *
 * The work item is recorded BEFORE the background continuation starts, because that
 * continuation is ~50s of best-effort work against a 60s worker ceiling and a kill anywhere
 * in it used to drop the customer's message with no trace. Its own function so the
 * ownership early-exit is local: this used to sit two loops deep, where a `return` would
 * have ended the whole webhook without a Response and dropped the sibling events.
 */
async function replyThroughAgent(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  account: SocialAccountForMessaging,
  platform: "facebook" | "instagram",
  inbound: InboundForAgent,
): Promise<void> {
  const { senderId, conversationId, readable } = inbound;
  const unread = inbound.attachments.length - (readable ? 1 : 0);

  const enqueued = await enqueueAgentReply(adminClient, {
    socialAccountId: account.id,
    platform,
    messageId: inbound.messageId,
    conversationId,
    recipientId: senderId,
    inboundText: noteUnreadAttachments(inbound.messageText, unread),
    inboundAt: inbound.inboundAt,
    mediaUrl: readable?.url ?? null,
    mediaKind: readable?.kind ?? null,
    mediaCaption: inbound.caption,
    unreadAttachments: unread,
  });
  // A redelivery is not a second customer message. The first invocation owns the row and
  // holds its lease; the recovery job is the backstop if that invocation dies. This one
  // acknowledges and stops rather than starting a parallel reply.
  if (enqueued && !enqueued.newlyEnqueued) return;
  // A record that could not be made at all is the one degradation accepted: reply anyway.
  const outboxId = enqueued?.id ?? null;

  // Understand the media FIRST, then hand the agent the description instead of "[Image]".
  // The download and the model call run off the response path to keep Meta's webhook fast,
  // and the agent trigger lives INSIDE that continuation because firing it before the text
  // exists was the original bug.
  await runInBackground("facebook-instagram agent reply", async () => {
    const understood = await understandInbound(adminClient, account, platform, senderId, inbound);

    // The agent owns the row from here: it settles every outcome itself. A POST that never
    // reaches it leaves the row pending under its lease, which is exactly what recovery is
    // for.
    await dispatchAgentReply({
      userId: account.user_id,
      platform,
      socialAccountId: account.id,
      conversationId,
      recipientId: senderId,
      inboundText: noteUnreadAttachments(understood.text, unread),
      // Without this the reply endpoint falls back to counting characters, and the English
      // data-marker wrapping an Arabic transcript wins.
      languageHint: understood.languageHint,
      outboxId,
    });
  });
}

/** The attachment's description, or the placeholder when nothing could read it. */
async function understandInbound(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  account: SocialAccountForMessaging,
  platform: "facebook" | "instagram",
  senderId: string,
  inbound: InboundForAgent,
): Promise<{ text: string; languageHint: string | undefined }> {
  const { readable } = inbound;
  if (!readable?.url) return { text: inbound.messageText, languageHint: undefined };

  const outcome = await runInboundMediaUnderstanding(adminClient, {
    account: {
      id: account.id,
      user_id: account.user_id,
      platform_user_id: account.platform_user_id,
      // No access_token on purpose. Meta's attachment URL is already signed, and supplying a
      // token would hand the fetch to CloudGraphFetcher, which replays the page token to a
      // CDN host that never asked for it.
      account_metadata: account.account_metadata,
    },
    // Keys the per-sender sub-cap, so one Messenger user cannot spend the page's whole daily
    // media allowance.
    senderId,
    // Facebook and Instagram messages are not rows in whatsapp_messages, so there is nothing
    // to write the result back to -- the agent gets it directly.
    messageRowId: null,
    mediaUrl: readable.url,
    // Meta sends no mime; its own word for the attachment is all we have.
    kindHint: readable.kind,
    caption: inbound.caption,
    platform,
  }, {
    // Bounds which origins this fetch may reach. The generic URL fetcher would download from
    // anywhere, which is not what the spec promises for inbound media even when the URL
    // arrived over a verified webhook.
    fetchers: [new MetaMessagingFetcher()],
  });

  if (outcome.understood) return { text: outcome.agentText, languageHint: outcome.languageCode };
  logSkippedUnderstanding("fb-ig-webhook", outcome.reason);
  return { text: inbound.messageText, languageHint: undefined };
}
