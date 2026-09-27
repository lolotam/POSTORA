// Public, API-key authenticated endpoint that lets external e-commerce
// stores (Curemedkw, custom storefronts, etc.) send WhatsApp messages
// through the merchant's already-connected Postora WhatsApp account.
//
// Auth: header `x-api-key: <profiles.api_key>`
// Body: { action, ... } — send_text | send_template | send_media | event.
// Opt-out is checked after `to` is validated and before any provider call.
import { sha256Hex } from "../_shared/crypto.ts";
import { type SendRefusedInput } from "../_shared/optOutLookup.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const POSTORA_CONNECT_URL = "https://postora.cloud/profiles";
const RATE_LIMIT = { requests: 60, windowMs: 60_000 };
const SEND_ACTIONS = new Set(["send_text", "send_template", "send_media", "event"]);

type EventName =
  | "order.created"
  | "order.paid"
  | "order.shipped"
  | "order.delivered"
  | "cart.abandoned"
  | "review.request";

const EVENT_TEMPLATES: Record<EventName, string> = {
  "order.created": "order_confirmation_v1",
  "order.paid": "order_invoice_v1",
  "order.shipped": "order_shipped_v1",
  "order.delivered": "order_delivered_v1",
  "cart.abandoned": "abandoned_cart_v1",
  "review.request": "review_request_v1",
};

export interface EcommerceAccount {
  id: string;
  platform_user_id: string | null;
  access_token: string | null;
  connection_mode: string | null;
  platform_username?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface EcommerceDeps {
  lookupUser(apiKeyHash: string): Promise<{ id: string } | null>;
  recentPostCount(userId: string, sinceIso: string): Promise<number>;
  insertApiLog(row: { user_id: string; endpoint: string; method: string; status_code: number }): Promise<void>;
  loadHealth(userId: string): Promise<EcommerceAccount | null>;
  loadSendAccount(userId: string, explicitAccountId?: string): Promise<EcommerceAccount | null>;
  optedOutPhones(userId: string, phones: string[]): Promise<Set<string>>;
  logSendRefused(input: SendRefusedInput): Promise<void>;
  sendText(account: EcommerceAccount, to: string, text: string): Promise<unknown>;
  sendMedia(account: EcommerceAccount, input: {
    to: string;
    mediaUrl: string;
    mediaType: "image" | "document" | "video";
    caption?: string;
    fileName?: string;
  }): Promise<unknown>;
  postGraph(phoneNumberId: string, token: string, payload: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }>;
  insertMessage(row: Record<string, unknown>): Promise<void>;
  now(): number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function rated(body: unknown, status: number, rateHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...rateHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string {
  return String(raw || "").replace(/\D/g, "");
}

function buildBodyParams(values: Array<string | number>) {
  return values.map((value) => ({ type: "text", text: String(value) }));
}

export async function handleEcommerceWhatsApp(req: Request, deps: EcommerceDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) return json({ success: false, error: "Missing x-api-key header" }, 401);

    const profile = await deps.lookupUser(await sha256Hex(apiKey));
    if (!profile) return json({ success: false, error: "Invalid API key" }, 401);
    const userId = profile.id;

    if (req.method === "GET") {
      const account = await deps.loadHealth(userId);
      return json({
        success: true,
        api_key_valid: true,
        whatsapp_connected: !!account,
        account: account
          ? {
            id: account.id,
            username: account.platform_username,
            display_name: account.account_metadata?.display_name ?? null,
          }
          : null,
        connect_url: account ? null : POSTORA_CONNECT_URL,
      });
    }

    const windowStart = new Date(deps.now() - RATE_LIMIT.windowMs);
    const used = await deps.recentPostCount(userId, windowStart.toISOString());
    const remaining = Math.max(0, RATE_LIMIT.requests - used);
    const rateHeaders = {
      "X-RateLimit-Limit": String(RATE_LIMIT.requests),
      "X-RateLimit-Remaining": String(Math.max(0, remaining - 1)),
      "X-RateLimit-Reset": String(Math.floor((deps.now() + RATE_LIMIT.windowMs) / 1000)),
    };

    await deps.insertApiLog({
      user_id: userId,
      endpoint: "/ecommerce-whatsapp-api",
      method: "POST",
      status_code: used >= RATE_LIMIT.requests ? 429 : 200,
    });

    if (used >= RATE_LIMIT.requests) {
      return rated({
        success: false,
        error_code: "RATE_LIMIT_EXCEEDED",
        error: "Too many requests. Try again in a minute.",
      }, 429, rateHeaders);
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const explicitAccountId = typeof body.social_account_id === "string" ? body.social_account_id : undefined;
    if (!action) {
      return json({ success: false, error: "Missing `action` (send_text|send_template|send_media|event)" }, 400);
    }

    const account = await deps.loadSendAccount(userId, explicitAccountId);
    if (!account) {
      return json({
        success: false,
        error_code: "WHATSAPP_NOT_CONNECTED",
        error: "No active WhatsApp account found for this API key. Connect WhatsApp in Postora first.",
        connect_url: POSTORA_CONNECT_URL,
      }, 200);
    }

    const phoneNumberId = account.platform_user_id ?? "";
    const token = account.access_token ?? "";
    if (!phoneNumberId || (account.connection_mode !== "evolution_qr" && !token)) {
      return json({
        success: false,
        error_code: "WHATSAPP_TOKEN_MISSING",
        error: "WhatsApp account is missing credentials. Reconnect it in Postora.",
        connect_url: POSTORA_CONNECT_URL,
      }, 200);
    }

    const to = body.to ? normalizePhone(String(body.to)) : "";
    if (!to) return json({ success: false, error: "`to` (recipient phone) is required" }, 400);

    if (!SEND_ACTIONS.has(action)) return json({ success: false, error: `Unknown action: ${action}` }, 400);

    let optedOut: Set<string>;
    try {
      optedOut = await deps.optedOutPhones(userId, [to]);
    } catch {
      await deps.logSendRefused({
        source: "ecommerce-whatsapp-api",
        userId,
        reason: "opt_out_lookup_failed",
        metadata: { action },
      });
      return rated({ success: false, error_code: "OPT_OUT_LOOKUP_FAILED" }, 500, rateHeaders);
    }
    if (optedOut.has(to)) {
      await deps.logSendRefused({
        source: "ecommerce-whatsapp-api",
        userId,
        reason: "opted_out",
        metadata: { action },
      });
      return rated({
        success: false,
        error_code: "RECIPIENT_OPTED_OUT",
        error: "This customer has opted out of WhatsApp messages",
      }, 200, rateHeaders);
    }

    let payload: Record<string, unknown> | null = null;
    let previewText = "";
    let messageType: "text" | "template" | "image" | "document" = "text";

    if (action === "send_text") {
      const text = String(body.text ?? "").trim();
      if (!text) return json({ success: false, error: "`text` is required for send_text" }, 400);
      payload = { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
      previewText = text.slice(0, 200);
      messageType = "text";
    } else if (action === "send_template" || action === "event") {
      let templateName: string;
      let bodyParams: Array<string | number> = Array.isArray(body.body_params) ? body.body_params as Array<string | number> : [];
      let headerMedia: { type: "image" | "document"; link: string; filename?: string } | undefined;

      if (action === "event") {
        const ev = body.event as EventName | undefined;
        if (!ev || !(ev in EVENT_TEMPLATES)) {
          return json({ success: false, error: `Unknown event. Use one of: ${Object.keys(EVENT_TEMPLATES).join(", ")}` }, 400);
        }
        templateName = typeof body.template === "string" ? body.template : EVENT_TEMPLATES[ev];
        const data = (body.data ?? {}) as Record<string, string | number>;
        switch (ev) {
          case "order.created":
            bodyParams = [data.customer_name ?? "", data.order_number ?? "", data.total ?? "", data.items_count ?? ""];
            break;
          case "order.paid":
            bodyParams = [data.customer_name ?? "", data.order_number ?? "", data.total ?? ""];
            if (data.invoice_url) {
              headerMedia = { type: "document", link: String(data.invoice_url), filename: `invoice-${data.order_number ?? "order"}.pdf` };
            }
            break;
          case "order.shipped":
            bodyParams = [data.customer_name ?? "", data.order_number ?? "", data.tracking_url ?? ""];
            break;
          case "order.delivered":
            bodyParams = [data.customer_name ?? "", data.order_number ?? ""];
            break;
          case "cart.abandoned":
            bodyParams = [data.customer_name ?? "", data.cart_url ?? ""];
            break;
          case "review.request":
            bodyParams = [data.customer_name ?? "", data.product_name ?? "", data.review_url ?? ""];
            break;
        }
        previewText = `[${ev}] ${templateName}`;
      } else {
        templateName = String(body.template_name ?? "").trim();
        if (!templateName) return json({ success: false, error: "`template_name` is required for send_template" }, 400);
        headerMedia = body.header_media as typeof headerMedia;
        previewText = `[Template: ${templateName}]`;
      }

      const components: unknown[] = [];
      if (headerMedia) {
        components.push({
          type: "header",
          parameters: [
            headerMedia.type === "image"
              ? { type: "image", image: { link: headerMedia.link } }
              : { type: "document", document: { link: headerMedia.link, filename: headerMedia.filename || "document.pdf" } },
          ],
        });
      }
      if (bodyParams.length > 0) components.push({ type: "body", parameters: buildBodyParams(bodyParams) });
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: body.template_language ?? "en_US" },
          components,
        },
      };
      messageType = "template";
    } else {
      const mediaUrl = String(body.media_url ?? "").trim();
      const mediaType = (body.media_type ?? "image") as "image" | "document" | "video";
      if (!mediaUrl) return json({ success: false, error: "`media_url` is required for send_media" }, 400);
      const mediaObj: Record<string, unknown> = { link: mediaUrl };
      if (body.caption) mediaObj.caption = body.caption;
      if (mediaType === "document" && body.filename) mediaObj.filename = body.filename;
      payload = { messaging_product: "whatsapp", to, type: mediaType, [mediaType]: mediaObj };
      previewText = body.caption ? String(body.caption).slice(0, 200) : `[${mediaType}] ${mediaUrl}`;
      messageType = mediaType === "video" ? "text" : mediaType;
    }

    let sendData: Record<string, unknown>;
    let sendOk = true;
    if (action !== "send_template" && action !== "event") {
      const raw = action === "send_text"
        ? await deps.sendText(account, to, String(body.text ?? ""))
        : await deps.sendMedia(account, {
          to,
          mediaUrl: String(body.media_url ?? ""),
          mediaType: (body.media_type ?? "image") as "image" | "document" | "video",
          caption: body.caption ? String(body.caption) : undefined,
          fileName: body.filename ? String(body.filename) : undefined,
        });
      sendData = (raw ?? {}) as Record<string, unknown>;
    } else {
      if (account.connection_mode === "evolution_qr") {
        return json({ success: false, error: "Template messages are not supported in Direct QR mode" }, 400);
      }
      const sent = await deps.postGraph(phoneNumberId, token, payload!);
      sendData = sent.data;
      sendOk = sent.ok;
    }

    const sendError = sendData.error as { error_user_msg?: string; message?: string } | undefined;
    if (!sendOk || sendError) {
      console.error("[ecommerce-whatsapp-api] Send failed");
      return rated({
        success: false,
        error_code: "WHATSAPP_SEND_FAILED",
        error: sendError?.error_user_msg || sendError?.message || "WhatsApp send failed",
        details: sendError ?? {},
      }, 200, rateHeaders);
    }

    const messages = sendData.messages as Array<{ id?: string }> | undefined;
    const key = sendData.key as { id?: string } | undefined;
    const waMessageId = messages?.[0]?.id ?? key?.id ?? null;
    await deps.insertMessage({
      user_id: userId,
      social_account_id: account.id,
      conversation_id: `wa_${phoneNumberId}_${to}`,
      message_id: waMessageId,
      from_phone: phoneNumberId,
      from_name: "Store",
      to_phone: to,
      message_text: previewText,
      message_type: messageType,
      direction: "outbound",
      status: "sent",
      timestamp: new Date(deps.now()).toISOString(),
    });

    return rated({ success: true, wa_message_id: waMessageId, conversation_id: `wa_${phoneNumberId}_${to}` }, 200, rateHeaders);
  } catch (e) {
    console.error("[ecommerce-whatsapp-api] error");
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
}
