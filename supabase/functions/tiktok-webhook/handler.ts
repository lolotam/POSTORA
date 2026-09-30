/**
 * TikTok webhook adapter. Signature checks and the envelope parse live here;
 * index.ts only supplies env and the service-role client.
 *
 * `content` is a JSON string. A malformed body is acknowledged with 200 so
 * TikTok stops retrying garbage. Database failures return 500 so it retries.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  applyPendingWebhookEvents,
  type ApplyOutcomeResult,
} from "../_shared/tiktokPublishOutcome.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BODY_CHARS = 64 * 1024;
const MAX_ID_CHARS = 256;
const REPLAY_WINDOW_SECONDS = 300;

const PUBLISH_EVENTS = new Set([
  "post.publish.complete",
  "post.publish.failed",
  "post.publish.publicly_available",
  "post.publish.no_longer_publicaly_available",
  "post.publish.inbox_delivered",
]);

export interface TikTokWebhookDeps {
  clientSecret: string | null;
  webhookSecret: string | null;
  nowSeconds: () => number;
  admin: SupabaseClient | null;
  applyPending?: typeof applyPendingWebhookEvents;
  log: (message: string) => void;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/plain" },
  });
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyTikTokSignature(
  signatureHeader: string,
  rawBody: string,
  clientSecret: string,
  nowSeconds: number,
  maxAgeSeconds = REPLAY_WINDOW_SECONDS,
): Promise<boolean> {
  let timestamp = "";
  let signature = "";
  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const prefix = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (prefix === "t") timestamp = value;
    else if (prefix === "s") signature = value;
  }
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > maxAgeSeconds) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
  const computedHex = Array.from(mac).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(computedHex, signature.toLowerCase());
}

/** Opaque TikTok ids: any non-empty string up to 256 chars. Never used in a filter string. */
export function opaqueId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_ID_CHARS) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContent(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSafeCreateTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function recordPublishEvent(
  deps: TikTokWebhookDeps & { admin: SupabaseClient },
  row: {
    event: string;
    user_openid: string;
    publish_id: string;
    provider_post_id: string | null;
    reason: string | null;
    create_time: number;
  },
): Promise<"inserted" | "duplicate"> {
  const { data, error } = await deps.admin
    .from("tiktok_webhook_events")
    .upsert(row, {
      onConflict: "event,publish_id,create_time",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) {
    if (error.code === "23505") return "duplicate";
    throw new Error("tiktok_webhook_insert_failed");
  }
  const inserted = Array.isArray(data) ? data : [];
  return inserted.length > 0 ? "inserted" : "duplicate";
}

export async function handleTikTokWebhook(
  req: Request,
  deps: TikTokWebhookDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const challenge = url.searchParams.get("challenge");
      return text(challenge ?? "OK", 200);
    }
    if (req.method !== "POST") return text("Method not allowed", 405);

    if (!deps.clientSecret && !deps.webhookSecret) return json({ error: "Unauthorized" }, 401);

    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_CHARS) return json({ error: "Payload too large" }, 413);

    const signatureHeader = req.headers.get("TikTok-Signature") ??
      req.headers.get("Tiktok-Signature") ??
      "";
    const authorization = req.headers.get("Authorization") ?? "";

    let authenticated = false;
    if (signatureHeader && deps.clientSecret) {
      authenticated = await verifyTikTokSignature(
        signatureHeader,
        rawBody,
        deps.clientSecret,
        deps.nowSeconds(),
      );
    }
    if (!authenticated && deps.webhookSecret) {
      authenticated = constantTimeEqual(authorization, deps.webhookSecret);
    }
    if (!authenticated) return json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      deps.log("tiktok_webhook_malformed_body");
      return json({ success: true }, 200);
    }
    if (!isRecord(body)) {
      deps.log("tiktok_webhook_malformed_body");
      return json({ success: true }, 200);
    }

    const event = typeof body.event === "string" ? body.event : "";
    if (event === "authorize" || event === "deauthorize") {
      deps.log(`tiktok_webhook_event:${event}`);
      return json({ success: true }, 200);
    }
    if (!PUBLISH_EVENTS.has(event)) {
      deps.log("tiktok_webhook_event:ignored");
      return json({ success: true }, 200);
    }
    deps.log(`tiktok_webhook_event:${event}`);

    const content = parseContent(body.content);
    if (!content) {
      deps.log("tiktok_webhook_malformed_content");
      return json({ success: true }, 200);
    }

    const publishId = opaqueId(content.publish_id);
    const userOpenId = opaqueId(body.user_openid);
    if (!publishId || !userOpenId || !isSafeCreateTime(body.create_time)) {
      deps.log("tiktok_webhook_invalid_envelope");
      return json({ success: true }, 200);
    }

    const providerPostId = opaqueId(content.post_id);
    const reason = typeof content.reason === "string" ? content.reason : null;
    deps.log(`tiktok_webhook_publish:${publishId}`);
    if (!deps.admin) throw new Error("tiktok_webhook_unavailable");

    const recorded = await recordPublishEvent({ ...deps, admin: deps.admin }, {
      event,
      user_openid: userOpenId,
      publish_id: publishId,
      provider_post_id: providerPostId,
      reason,
      create_time: body.create_time,
    });
    if (recorded === "duplicate") return json({ success: true }, 200);

    const applyPending = deps.applyPending ?? applyPendingWebhookEvents;
    const result: ApplyOutcomeResult | "none" = await applyPending(deps.admin, publishId);
    deps.log(`tiktok_webhook_applied:${result}`);
    return json({ success: true }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    deps.log(message.startsWith("tiktok_") ? message : "tiktok_webhook_error");
    return json({ error: "Internal error" }, 500);
  }
}
