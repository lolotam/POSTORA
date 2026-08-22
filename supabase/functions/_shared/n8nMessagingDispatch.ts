import { postWebhook } from "./webhookSecurity.ts";

export type MessagePlatform = "whatsapp" | "instagram" | "facebook";

export interface MessagingAccountSummary {
  id: string;
  platform: string;
  // Display label: the platform username (e.g. "danatfuture", "Xsellpoint") or, when the
  // platform gives none, the platform id (a WhatsApp number). Never null.
  name: string;
  username: string | null;
  // "@danatfuture" for handle-based platforms; null where a handle makes no sense (WhatsApp).
  handle: string | null;
}

export interface MessagingAccountSource {
  id: string;
  platform: string;
  platform_user_id?: string | null;
  platform_username?: string | null;
}

export function describeMessagingAccount(account: MessagingAccountSource): MessagingAccountSummary {
  const username = account.platform_username?.trim() || null;
  const handleable = account.platform === "instagram" || account.platform === "facebook" ||
    account.platform === "threads";
  return {
    id: account.id,
    platform: account.platform,
    name: username || account.platform_user_id || account.id,
    username,
    handle: handleable && username ? `@${username.replace(/^@/, "")}` : null,
  };
}

// Any envelope this module can deliver. `event` drives subscription matching; `platform`
// and `social_account_id` drive the optional per-subscription filters. Everything else a
// given event carries rides along untouched.
export interface N8nEnvelope {
  event: string;
  platform: string;
  social_account_id: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface MessagePayloadInput {
  platform: MessagePlatform;
  socialAccountId: string;
  account?: MessagingAccountSource;
  conversationId: string;
  sender: { id: string; name: string | null; phone: string | null };
  message: { id: string; text: string; type: string; attachments: unknown[] };
  timestamp?: string;
}

export interface MessagePayload extends N8nEnvelope {
  event: "message.received";
  platform: MessagePlatform;
  social_account_id: string;
  account: MessagingAccountSummary;
  conversation_id: string;
  sender: MessagePayloadInput["sender"];
  message: MessagePayloadInput["message"];
  timestamp: string;
}

export type CommentPlatform = "facebook" | "instagram" | "threads";
export type CommentKind = "comment" | "reply" | "mention";

export interface CommentPayloadInput {
  platform: CommentPlatform;
  socialAccountId: string;
  account?: MessagingAccountSource;
  comment: { id: string; kind: CommentKind; text: string; parentCommentId: string | null; mediaUrl: string | null };
  post: { id: string | null; url: string | null; caption: string | null };
  author: { id: string | null; name: string | null; username: string | null };
  timestamp?: string;
}

export interface CommentPayload extends N8nEnvelope {
  event: "comment.received";
  platform: CommentPlatform;
  social_account_id: string;
  account: MessagingAccountSummary;
  comment: { id: string; kind: CommentKind; text: string; parent_comment_id: string | null; media_url: string | null };
  post: CommentPayloadInput["post"];
  author: CommentPayloadInput["author"];
  timestamp: string;
}

export function shouldDispatchInboundMessage(input: {
  isEcho?: boolean;
  isStatus?: boolean;
  isHistory?: boolean;
}): boolean {
  return !input.isEcho && !input.isStatus && !input.isHistory;
}

interface DispatchOptions {
  fetcher?: typeof fetch;
  deadlineMs?: number;
}

interface Destination {
  registry: "settings" | "legacy";
  id: string;
  url: string;
  secret?: string;
  events: unknown;
  failureCount: number;
  isActive: boolean;
  // Optional per-subscription filters. Only the settings registry can carry them; a
  // destination that omits one accepts every value for it, which is what every
  // subscription registered before filters existed does.
  platform?: string;
  socialAccountId?: string;
  settingValue?: Record<string, unknown>;
}

const MAX_IN_FLIGHT = 5;
const WEBHOOK_TIMEOUT_MS = 5_000;
const DEFAULT_DEADLINE_MS = 10_000;

export function buildMessagePayload(input: MessagePayloadInput): MessagePayload {
  return {
    event: "message.received",
    platform: input.platform,
    social_account_id: input.socialAccountId,
    account: describeMessagingAccount(input.account ?? { id: input.socialAccountId, platform: input.platform }),
    conversation_id: input.conversationId,
    sender: input.sender,
    message: input.message,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

export function buildCommentPayload(input: CommentPayloadInput): CommentPayload {
  return {
    event: "comment.received",
    platform: input.platform,
    social_account_id: input.socialAccountId,
    account: describeMessagingAccount(input.account ?? { id: input.socialAccountId, platform: input.platform }),
    comment: {
      id: input.comment.id,
      kind: input.comment.kind,
      text: input.comment.text,
      parent_comment_id: input.comment.parentCommentId,
      media_url: input.comment.mediaUrl,
    },
    post: input.post,
    author: input.author,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

// Threads mentions predate the comment envelope and have live n8n subscribers, so the
// `data` body they receive is reproduced field for field. Only the routing fields the
// dispatcher needs are added around it.
// `event` is a plain string rather than a union: threads-mentions also emits
// threads.mention.sentiment_updated / .labeled / .assigned, which reach wildcard
// subscribers only (they are not in ALLOWED_WEBHOOK_EVENTS) but must keep flowing.
export function buildMentionEnvelope(
  event: string,
  socialAccountId: string,
  mention: any,
): N8nEnvelope {
  return {
    event,
    platform: "threads",
    social_account_id: socialAccountId,
    timestamp: new Date().toISOString(),
    data: {
      mention_id: mention.id,
      social_account_id: mention.social_account_id,
      platform: "threads",
      author_username: mention.mention_author_username,
      mention_text: mention.mention_text,
      mention_permalink: mention.mention_permalink,
      status: mention.status,
      sentiment: mention.sentiment,
      labels: mention.labels,
      assigned_to: mention.assigned_to,
      mentioned_at: mention.mentioned_at,
      source: mention.source,
    },
  };
}

export async function signMessagePayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function dispatchMessageEvent(
  adminClient: any,
  userId: string,
  payload: MessagePayload,
  options: DispatchOptions = {},
): Promise<void> {
  return dispatchN8nEvent(adminClient, userId, payload, options);
}

export async function dispatchN8nEvent(
  adminClient: any,
  userId: string,
  payload: N8nEnvelope,
  options: DispatchOptions = {},
): Promise<void> {
  const { configured, matching } = await loadDestinations(adminClient, userId, payload);
  const unique = dedupeDestinations(matching);
  // A webhook is registered against the API key owner, while dispatch is scoped to the
  // account that received the message. When those are different users the fan-out is empty,
  // and without this trace that mismatch leaves no sign in the function logs at all.
  //
  // Severity, not silence: this runs for every inbound message, so a user who simply has no
  // webhooks would otherwise warn on each one. Having webhooks but matching none is the
  // actionable case (inactive, blank url, or an events list that omits this platform).
  if (unique.length === 0) {
    if (configured > 0) {
      console.warn(
        `[n8n-dispatch] ${configured} webhook(s) configured for user ${userId} but none subscribed to ${aliasEvent(payload)}`,
      );
    } else {
      console.log(`[n8n-dispatch] no webhook destinations for user ${userId} platform ${payload.platform}`);
    }
    return;
  }
  const deadline = Date.now() + (options.deadlineMs || DEFAULT_DEADLINE_MS);
  let nextIndex = 0;
  let skipped = 0;

  // Workers are awaited rather than raced against a timer: a race would resolve
  // while deliveries are still in flight, turning them into exactly the detached
  // promises this module exists to avoid. The per-request timeout bounds each
  // hop, and the deadline stops us starting new ones.
  const deliver = async (): Promise<void> => {
    for (;;) {
      const destination = unique[nextIndex++];
      if (!destination) return;
      if (Date.now() >= deadline) {
        skipped++;
        continue;
      }
      await deliverToDestination(adminClient, destination, payload, options.fetcher || fetch);
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, unique.length) }, () => deliver()));
  if (skipped > 0) {
    console.error(`[n8n-dispatch] fan-out deadline hit; ${skipped}/${unique.length} destination(s) not delivered`);
  }
}

async function loadDestinations(
  adminClient: any,
  userId: string,
  payload: N8nEnvelope,
): Promise<{ configured: number; matching: Destination[] }> {
  const [settingsResult, legacyResult] = await Promise.all([
    adminClient.from("app_settings").select("key, value").like("key", `n8n_webhook_${userId}_%`),
    // Inactive rows are kept here on purpose so both registries count "configured" the same
    // way; the shared filter below drops them, as it already does for settings-registry rows.
    adminClient.from("whatsapp_webhooks").select("id, url, secret, events, failure_count, is_active").eq("user_id", userId),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (legacyResult.error) throw legacyResult.error;

  const settings = (settingsResult.data || []).map((row: any): Destination => ({
    registry: "settings",
    id: row.key,
    url: String(row.value?.webhook_url || ""),
    secret: row.value?.webhook_secret || row.value?.secret,
    events: row.value?.events,
    failureCount: Number(row.value?.failure_count || 0),
    isActive: row.value?.is_active === true,
    platform: typeof row.value?.platform === "string" && row.value.platform ? row.value.platform : undefined,
    socialAccountId: typeof row.value?.social_account_id === "string" && row.value.social_account_id
      ? row.value.social_account_id
      : undefined,
    settingValue: row.value || {},
  }));
  const legacy = (legacyResult.data || []).map((row: any): Destination => ({
    registry: "legacy",
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: row.events,
    failureCount: Number(row.failure_count || 0),
    isActive: row.is_active === true,
  }));
  const configuredDestinations = [...settings, ...legacy];
  return {
    configured: configuredDestinations.length,
    matching: configuredDestinations.filter((destination) =>
      destination.isActive && destination.url && matchesSubscription(destination, payload)
    ),
  };
}

// "message.received" on whatsapp also matches a "message.whatsapp" subscription, and
// "comment.received" on instagram also matches "comment.instagram".
function aliasEvent(payload: N8nEnvelope): string {
  const [family] = payload.event.split(".");
  return `${family}.${payload.platform}`;
}

function matchesSubscription(destination: Destination, payload: N8nEnvelope): boolean {
  const { events, registry } = destination;
  // whatsapp_webhooks predates the standardized envelope and its delivery path reshapes
  // the body as a message (toLegacyPayload reads sender/message). A comment or mention
  // envelope reaching it would throw mid-reshape, count as a delivery failure, and after
  // ten of them silently auto-disable a live WhatsApp webhook. Message events only.
  if (registry === "legacy" && !payload.event.startsWith("message.")) return false;
  if (destination.platform && destination.platform !== payload.platform) return false;
  if (destination.socialAccountId && destination.socialAccountId !== payload.social_account_id) return false;
  // whatsapp_webhooks rows with a null events column historically received every
  // event; narrowing that here would silently cut off existing subscribers.
  if (events === null || events === undefined) return registry === "legacy";
  if (!Array.isArray(events)) return false;
  return events.includes("*") || events.includes(payload.event) || events.includes(aliasEvent(payload));
}

function dedupeDestinations(destinations: Destination[]): Destination[] {
  const seen = new Set<string>();
  return destinations.filter((destination) => {
    if (seen.has(destination.url)) return false;
    seen.add(destination.url);
    return true;
  });
}

async function deliverToDestination(
  adminClient: any,
  destination: Destination,
  payload: N8nEnvelope,
  fetcher: typeof fetch,
): Promise<void> {
  // whatsapp_webhooks predates the standardized envelope and has live external
  // subscribers, so it keeps its original body and signature header. Only the
  // n8n registry gets the new schema.
  // Only message envelopes ever reach a legacy destination (see matchesSubscription).
  const legacy = destination.registry === "legacy";
  const body = JSON.stringify(legacy ? toLegacyPayload(payload as unknown as MessagePayload) : payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!legacy) {
    headers["X-Postora-Event"] = payload.event;
    headers["X-Postora-Timestamp"] = payload.timestamp;
  }
  if (destination.secret) {
    const signature = await signMessagePayload(body, destination.secret);
    if (legacy) headers["X-Webhook-Signature"] = signature;
    else headers["X-Postora-Signature"] = `sha256=${signature}`;
  }

  try {
    const response = await postWebhook(destination.url, { method: "POST", headers, body }, fetcher, WEBHOOK_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await updateDestination(adminClient, destination, 0, response.status);
  } catch (error) {
    const failureCount = destination.failureCount + 1;
    await updateDestination(adminClient, destination, failureCount, null);
    console.error(`[n8n-dispatch] ${destination.url} failed:`, error);
  }
}

function toLegacyPayload(payload: MessagePayload): Record<string, unknown> {
  return {
    event: payload.event,
    timestamp: payload.timestamp,
    data: {
      from: payload.sender.id,
      contact_name: payload.sender.name,
      message: payload.message.text,
      message_type: payload.message.type,
      conversation_id: payload.conversation_id,
      phone_number_id: payload.social_account_id,
    },
  };
}

async function updateDestination(adminClient: any, destination: Destination, failureCount: number, statusCode: number | null): Promise<void> {
  const active = statusCode !== null || failureCount < 10;
  if (destination.registry === "settings") {
    await adminClient.from("app_settings").update({
      value: { ...destination.settingValue, failure_count: failureCount, is_active: active },
    }).eq("key", destination.id);
    return;
  }
  await adminClient.from("whatsapp_webhooks").update({
    failure_count: failureCount,
    is_active: active,
    ...(statusCode !== null ? { last_triggered_at: new Date().toISOString(), last_status_code: statusCode } : {}),
  }).eq("id", destination.id);
}
