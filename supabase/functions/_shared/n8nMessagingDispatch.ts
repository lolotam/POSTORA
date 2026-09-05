import { postWebhook } from "./webhookSecurity.ts";
import { recordN8nDispatch } from "./automationDispatchLog.ts";

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
  // May carry ig_username (written by instagram-business-oauth); read via metadataString.
  account_metadata?: unknown;
}

// One username rule for both account and sender derivation (spec R3): every candidate runs
// through this before any branching, so trim and @-stripping cannot differ between paths.
export function normalizeHandleUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/^\s+|\s+$/gu, "");
  const stripped = trimmed.replace(/^@+/, "");
  if (!stripped) return null;
  // Space-free input passes through unchanged, case preserved: subscribers may compare
  // account.username case-sensitively, so lowercasing is confined to the slug branch.
  if (!/\s/u.test(stripped)) return stripped;
  // Fabricated-slug branch: a display name with spaces ("Danat Future Company") becomes a
  // space-free handle. The result may not resolve to a real account on-platform — an
  // accepted trade-off — and it only fires for values already changing shape.
  return stripped.replace(/\s+/gu, "_").toLowerCase();
}

// Mirrors commentAuthor.ts's module-private metadataString (that file is out of scope here):
// reads one key from account_metadata without trusting its shape.
function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function isHandlePlatform(platform: string): boolean {
  return platform === "instagram" || platform === "facebook" || platform === "threads";
}

export function describeMessagingAccount(account: MessagingAccountSource): MessagingAccountSummary {
  // ig_username is instagram-only: a Facebook or WhatsApp row carrying stale ig_username
  // metadata must not be labelled with an unrelated Instagram handle. A malformed value
  // falls through to platform_username rather than yielding null.
  const igUsername = account.platform === "instagram"
    ? metadataString(account.account_metadata, "ig_username")
    : null;
  const username = normalizeHandleUsername(igUsername) ?? normalizeHandleUsername(account.platform_username);
  // `name` keeps today's exact behaviour: the TRIMMED platform_username — a display name,
  // internal spaces intact — falling back to platform_user_id, then id. Pinned by test.
  const displayName = account.platform_username?.trim() || null;
  return {
    id: account.id,
    platform: account.platform,
    name: displayName || account.platform_user_id || account.id,
    username,
    handle: isHandlePlatform(account.platform) && username ? `@${username}` : null,
  };
}

// The five-field identity every message sender carries. Deliberately a different shape from
// MessagingAccountSummary: account carries `platform` and no phone, sender carries phone and
// no platform. username/handle are null until a real username source exists — never derived
// from a display name, because slugging a member of the public's name can produce a handle
// that belongs to a different real person.
export interface MessagingPersonSummary {
  id: string;
  name: string | null;
  username: string | null;
  handle: string | null;
  phone: string | null;
}

// Builds the sender through the same username rule as the account summary (normalizeHandleUsername),
// so a future username source cannot leak spaces into sender.username/handle.
export function buildMessagingSender(input: {
  platform: MessagePlatform;
  id: string;
  name?: string | null;
  username?: string | null;
  phone?: string | null;
}): MessagingPersonSummary {
  const username = normalizeHandleUsername(input.username);
  return {
    id: input.id,
    name: typeof input.name === "string" && input.name.trim() ? input.name : null,
    username,
    handle: isHandlePlatform(input.platform) && username ? `@${username}` : null,
    phone: input.phone || null,
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
  sender: MessagingPersonSummary;
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

export type CommentPlatform = "facebook" | "instagram" | "threads" | "youtube";
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
    // Logged even with nowhere to send: "routed to n8n, nothing was listening" is the
    // answer to "why did no one reply", and it is invisible without a row.
    await recordN8nDispatch(adminClient, userId, payload, 0);
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
  // Destinations actually attempted, not merely matched: the fan-out deadline can leave
  // some unreached, and counting those would report a hand-off that never left the box.
  await recordN8nDispatch(adminClient, userId, payload, unique.length - skipped);
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
    const response = await postWebhook(destination.url, { method: "POST", headers, body }, fetcher, {
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
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
