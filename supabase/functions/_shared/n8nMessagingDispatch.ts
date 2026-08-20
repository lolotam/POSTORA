import { postWebhook } from "./webhookSecurity.ts";

export type MessagePlatform = "whatsapp" | "instagram" | "facebook";

export interface MessagePayloadInput {
  platform: MessagePlatform;
  socialAccountId: string;
  conversationId: string;
  sender: { id: string; name: string | null; phone: string | null };
  message: { id: string; text: string; type: string; attachments: unknown[] };
  timestamp?: string;
}

export interface MessagePayload {
  event: "message.received";
  platform: MessagePlatform;
  social_account_id: string;
  conversation_id: string;
  sender: MessagePayloadInput["sender"];
  message: MessagePayloadInput["message"];
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
    conversation_id: input.conversationId,
    sender: input.sender,
    message: input.message,
    timestamp: input.timestamp || new Date().toISOString(),
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

export async function dispatchMessageEvent(
  adminClient: any,
  userId: string,
  payload: MessagePayload,
  options: DispatchOptions = {},
): Promise<void> {
  const destinations = await loadDestinations(adminClient, userId, payload.platform);
  const unique = dedupeDestinations(destinations);
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

async function loadDestinations(adminClient: any, userId: string, platform: MessagePlatform): Promise<Destination[]> {
  const [settingsResult, legacyResult] = await Promise.all([
    adminClient.from("app_settings").select("key, value").like("key", `n8n_webhook_${userId}_%`),
    adminClient.from("whatsapp_webhooks").select("id, url, secret, events, failure_count").eq("user_id", userId).eq("is_active", true),
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
    settingValue: row.value || {},
  }));
  const legacy = (legacyResult.data || []).map((row: any): Destination => ({
    registry: "legacy",
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: row.events,
    failureCount: Number(row.failure_count || 0),
    isActive: true,
  }));
  return [...settings, ...legacy].filter((destination) =>
    destination.isActive && destination.url &&
    matchesSubscription(destination.events, payloadEvent(platform), destination.registry)
  );
}

function payloadEvent(platform: MessagePlatform): string {
  return `message.${platform}`;
}

function matchesSubscription(events: unknown, platformEvent: string, registry: Destination["registry"]): boolean {
  // whatsapp_webhooks rows with a null events column historically received every
  // event; narrowing that here would silently cut off existing subscribers.
  if (events === null || events === undefined) return registry === "legacy";
  if (!Array.isArray(events)) return false;
  return events.includes("*") || events.includes("message.received") || events.includes(platformEvent);
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
  payload: MessagePayload,
  fetcher: typeof fetch,
): Promise<void> {
  // whatsapp_webhooks predates the standardized envelope and has live external
  // subscribers, so it keeps its original body and signature header. Only the
  // n8n registry gets the new schema.
  const legacy = destination.registry === "legacy";
  const body = JSON.stringify(legacy ? toLegacyPayload(payload) : payload);
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
