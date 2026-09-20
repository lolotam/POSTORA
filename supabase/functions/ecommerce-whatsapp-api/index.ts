import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { resolveWhatsAppTransport } from "../_shared/whatsappTransport.ts";
import { sha256Hex } from "../_shared/crypto.ts";

// Public, API-key authenticated endpoint that lets external e-commerce
// stores (Curemedkw, custom storefronts, etc.) send WhatsApp messages
// through the merchant's already-connected Postora WhatsApp account.
//
// Auth: header `x-api-key: <profiles.api_key>`
// Body: { action, ... } — see ACTIONS below.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRAPH_API = "https://graph.facebook.com/v22.0";
const POSTORA_CONNECT_URL = "https://postora.cloud/profiles";

// Per API key: 60 sends / minute
const RATE_LIMIT = { requests: 60, windowMs: 60_000 };

type EventName =
  | "order.created"
  | "order.paid"
  | "order.shipped"
  | "order.delivered"
  | "cart.abandoned"
  | "review.request";

// Default template names (must be approved in Meta Business Manager).
// Merchants can override per-event via the `template` field on the request.
const EVENT_TEMPLATES: Record<EventName, string> = {
  "order.created": "order_confirmation_v1",
  "order.paid": "order_invoice_v1",
  "order.shipped": "order_shipped_v1",
  "order.delivered": "order_delivered_v1",
  "cart.abandoned": "abandoned_cart_v1",
  "review.request": "review_request_v1",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string {
  // Strip everything except digits; Meta accepts E.164 without `+`.
  return String(raw || "").replace(/\D/g, "");
}

function buildBodyParams(values: Array<string | number>) {
  return values.map((v) => ({ type: "text", text: String(v) }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1. Authenticate via API key
    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) {
      return json(
        { success: false, error: "Missing x-api-key header" },
        401,
      );
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("api_key_hash", await sha256Hex(apiKey))
      .maybeSingle();

    if (!profile) {
      return json({ success: false, error: "Invalid API key" }, 401);
    }
    const userId = profile.id as string;

    // GET /ecommerce-whatsapp-api → diagnostic status endpoint.
    // Lets external stores check connection health without sending a message.
    if (req.method === "GET") {
      const { data: acct } = await admin
        .from("social_accounts")
        .select("id, platform_username, account_metadata, is_active")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .maybeSingle();

      return json({
        success: true,
        api_key_valid: true,
        whatsapp_connected: !!acct,
        account: acct
          ? {
              id: acct.id,
              username: acct.platform_username,
              display_name:
                (acct.account_metadata as Record<string, unknown> | null)
                  ?.display_name ?? null,
            }
          : null,
        connect_url: acct ? null : POSTORA_CONNECT_URL,
      });
    }

    // 2. Rate limit (60/min/key) via api_logs
    const windowStart = new Date(Date.now() - RATE_LIMIT.windowMs);
    const { count: recentCount } = await admin
      .from("api_logs")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("endpoint", "/ecommerce-whatsapp-api")
      .gte("created_at", windowStart.toISOString());

    const used = recentCount ?? 0;
    const remaining = Math.max(0, RATE_LIMIT.requests - used);
    const rateHeaders = {
      "X-RateLimit-Limit": String(RATE_LIMIT.requests),
      "X-RateLimit-Remaining": String(Math.max(0, remaining - 1)),
      "X-RateLimit-Reset": String(
        Math.floor((Date.now() + RATE_LIMIT.windowMs) / 1000),
      ),
    };

    await admin.from("api_logs").insert({
      user_id: userId,
      endpoint: "/ecommerce-whatsapp-api",
      method: "POST",
      status_code: used >= RATE_LIMIT.requests ? 429 : 200,
    });

    if (used >= RATE_LIMIT.requests) {
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "RATE_LIMIT_EXCEEDED",
          error: "Too many requests. Try again in a minute.",
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            ...rateHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const body = await req.json().catch(() => ({}));
    const {
      action,
      to: rawTo,
      social_account_id: explicitAccountId,
    } = body as {
      action?: string;
      to?: string;
      social_account_id?: string;
    };

    if (!action) {
      return json(
        { success: false, error: "Missing `action` (send_text|send_template|send_media|event)" },
        400,
      );
    }

    // 3. Resolve merchant's WhatsApp account
    let accountQuery = admin
      .from("social_accounts")
      .select("id, platform, platform_user_id, access_token, connection_mode, account_metadata, is_active")
      .eq("user_id", userId)
      .eq("platform", "whatsapp")
      .eq("is_active", true);

    if (explicitAccountId) accountQuery = accountQuery.eq("id", explicitAccountId);

    const { data: account } = await accountQuery.maybeSingle();
    if (!account) {
      return json(
        {
          success: false,
          error_code: "WHATSAPP_NOT_CONNECTED",
          error: "No active WhatsApp account found for this API key. Connect WhatsApp in Postora first.",
          connect_url: POSTORA_CONNECT_URL,
        },
        200,
      );
    }

    const phoneNumberId = account.platform_user_id as string;
    const token = account.access_token as string;
    if (!phoneNumberId || (account.connection_mode !== "evolution_qr" && !token)) {
      return json(
        {
          success: false,
          error_code: "WHATSAPP_TOKEN_MISSING",
          error: "WhatsApp account is missing credentials. Reconnect it in Postora.",
          connect_url: POSTORA_CONNECT_URL,
        },
        200,
      );
    }

    const to = rawTo ? normalizePhone(rawTo) : "";
    if (!to) {
      return json({ success: false, error: "`to` (recipient phone) is required" }, 400);
    }

    // 4. Build outbound payload per action
    let payload: Record<string, unknown> | null = null;
    let previewText = "";
    let messageType: "text" | "template" | "image" | "document" = "text";

    if (action === "send_text") {
      const text = String(body.text ?? "").trim();
      if (!text) {
        return json({ success: false, error: "`text` is required for send_text" }, 400);
      }
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      };
      previewText = text.slice(0, 200);
      messageType = "text";
    } else if (action === "send_template" || action === "event") {
      let templateName: string;
      let bodyParams: Array<string | number> = body.body_params ?? [];
      let headerMedia: { type: "image" | "document"; link: string; filename?: string } | undefined;

      if (action === "event") {
        const ev = body.event as EventName | undefined;
        if (!ev || !(ev in EVENT_TEMPLATES)) {
          return json(
            { success: false, error: `Unknown event. Use one of: ${Object.keys(EVENT_TEMPLATES).join(", ")}` },
            400,
          );
        }
        templateName = body.template ?? EVENT_TEMPLATES[ev];
        const d = (body.data ?? {}) as Record<string, string | number>;

        switch (ev) {
          case "order.created":
            bodyParams = [d.customer_name ?? "", d.order_number ?? "", d.total ?? "", d.items_count ?? ""];
            break;
          case "order.paid":
            bodyParams = [d.customer_name ?? "", d.order_number ?? "", d.total ?? ""];
            if (d.invoice_url) {
              headerMedia = { type: "document", link: String(d.invoice_url), filename: `invoice-${d.order_number ?? "order"}.pdf` };
            }
            break;
          case "order.shipped":
            bodyParams = [d.customer_name ?? "", d.order_number ?? "", d.tracking_url ?? ""];
            break;
          case "order.delivered":
            bodyParams = [d.customer_name ?? "", d.order_number ?? ""];
            break;
          case "cart.abandoned":
            bodyParams = [d.customer_name ?? "", d.cart_url ?? ""];
            break;
          case "review.request":
            bodyParams = [d.customer_name ?? "", d.product_name ?? "", d.review_url ?? ""];
            break;
        }
        previewText = `[${ev}] ${templateName}`;
      } else {
        templateName = String(body.template_name ?? "").trim();
        if (!templateName) {
          return json({ success: false, error: "`template_name` is required for send_template" }, 400);
        }
        headerMedia = body.header_media;
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
      if (bodyParams.length > 0) {
        components.push({ type: "body", parameters: buildBodyParams(bodyParams) });
      }

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
    } else if (action === "send_media") {
      const mediaUrl = String(body.media_url ?? "").trim();
      const mediaType = (body.media_type ?? "image") as "image" | "document" | "video";
      if (!mediaUrl) {
        return json({ success: false, error: "`media_url` is required for send_media" }, 400);
      }
      const mediaObj: Record<string, unknown> = { link: mediaUrl };
      if (body.caption) mediaObj.caption = body.caption;
      if (mediaType === "document" && body.filename) mediaObj.filename = body.filename;

      payload = {
        messaging_product: "whatsapp",
        to,
        type: mediaType,
        [mediaType]: mediaObj,
      };
      previewText = body.caption ? String(body.caption).slice(0, 200) : `[${mediaType}] ${mediaUrl}`;
      messageType = mediaType === "video" ? "text" : (mediaType as "image" | "document");
    } else {
      return json({ success: false, error: `Unknown action: ${action}` }, 400);
    }

    // 5. Send through the account's server-side transport
    let sendData: any;
    let sendOk = true;
    if (action !== "send_template" && action !== "event") {
      const transport = await resolveWhatsAppTransport(admin, account);
      sendData = (await (action === "send_text"
        ? transport.sendText({ recipientPhone: to, text: String(body.text ?? "") })
        : transport.sendMedia({
          recipientPhone: to,
          mediaUrl: String(body.media_url ?? ""),
          mediaType: (body.media_type ?? "image") as "image" | "document" | "video",
          caption: body.caption ? String(body.caption) : undefined,
          fileName: body.filename ? String(body.filename) : undefined,
        }))).raw;
    } else {
      if (account.connection_mode === "evolution_qr") {
        return json({ success: false, error: "Template messages are not supported in Direct QR mode" }, 400);
      }
      const url = `${GRAPH_API}/${phoneNumberId}/messages`;
      const sendRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      sendData = await sendRes.json().catch(() => ({}));
      sendOk = sendRes.ok;
    }

    if (!sendOk || sendData.error) {
      const err = sendData.error || {};
      console.error("[ecommerce-whatsapp-api] Send failed:", JSON.stringify(err));
      return new Response(
        JSON.stringify({
          success: false,
          error_code: "WHATSAPP_SEND_FAILED",
          error: err.error_user_msg || err.message || "WhatsApp send failed",
          details: err,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, ...rateHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const waMessageId = sendData.messages?.[0]?.id ?? sendData.key?.id ?? null;
    const conversationId = `wa_${phoneNumberId}_${to}`;

    // 6. Log into whatsapp_messages so it appears in Postora Inbox
    await admin.from("whatsapp_messages").insert({
      user_id: userId,
      social_account_id: account.id,
      conversation_id: conversationId,
      message_id: waMessageId,
      from_phone: phoneNumberId,
      from_name: "Store",
      to_phone: to,
      message_text: previewText,
      message_type: messageType,
      direction: "outbound",
      status: "sent",
      timestamp: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        wa_message_id: waMessageId,
        conversation_id: conversationId,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, ...rateHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("[ecommerce-whatsapp-api] error:", e);
    return json(
      { success: false, error: e instanceof Error ? e.message : "Unknown error" },
      500,
    );
  }
});
