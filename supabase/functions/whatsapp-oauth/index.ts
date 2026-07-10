import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleRestrictedCorsOptions, restrictedJsonResponse, restrictedErrorResponse } from "../_shared/cors.ts";

const GRAPH_API = "https://graph.facebook.com/v22.0";

interface ExchangeBody {
  action: "exchange_signup";
  code: string;
  waba_id: string;
  phone_number_id: string;
  business_id?: string;
  mode: "cloud_api" | "coexistence";
}

interface DisconnectBody {
  action: "disconnect";
  social_account_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const appId = Deno.env.get("FACEBOOK_APP_ID");
    const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");

    // Auth: identify caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return restrictedErrorResponse(req, "Missing authorization header", 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return restrictedErrorResponse(req, "Invalid session", 401);
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = (await req.json()) as ExchangeBody | DisconnectBody;

    // ============ DISCONNECT ============
    if (body.action === "disconnect") {
      const { social_account_id } = body;
      const { data: account } = await admin
        .from("social_accounts")
        .select("id, user_id, access_token, account_metadata")
        .eq("id", social_account_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!account) return restrictedErrorResponse(req, "Account not found", 404);

      const meta = (account.account_metadata || {}) as Record<string, unknown>;
      const wabaId = meta.waba_id as string | undefined;
      const token = account.access_token as string | undefined;

      // Best-effort unsubscribe webhook from WABA
      if (wabaId && token) {
        try {
          await fetch(`${GRAPH_API}/${wabaId}/subscribed_apps`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (e) {
          console.warn("[whatsapp-oauth] unsubscribe failed (non-fatal):", e);
        }
      }

      await admin
        .from("social_accounts")
        .update({ is_active: false })
        .eq("id", social_account_id)
        .eq("user_id", userId);

      return restrictedJsonResponse(req, { success: true });
    }

    // ============ EXCHANGE_SIGNUP ============
    if (body.action !== "exchange_signup") {
      return restrictedErrorResponse(req, "Unknown action", 400);
    }

    if (!appId || !appSecret) {
      return restrictedErrorResponse(req, "FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not configured.", 500);
    }

    const { code, waba_id, phone_number_id, business_id, mode } = body;
    if (!code || !waba_id || !phone_number_id || !mode) {
      return restrictedErrorResponse(req, "Missing required fields: code, waba_id, phone_number_id, mode", 400);
    }

    // Server-side feature flag guard: block Cloud API connections when disabled
    if (mode === "cloud_api") {
      const { data: flagRow } = await admin
        .from("app_settings")
        .select("value")
        .eq("key", "feature_wa_cloud_api_enabled")
        .maybeSingle();
      let cloudApiEnabled = false;
      if (flagRow?.value !== undefined && flagRow?.value !== null) {
        let val: unknown = flagRow.value;
        if (typeof val === "string") {
          try { val = JSON.parse(val); } catch { /* keep string */ }
        }
        cloudApiEnabled = val === true || val === "true";
      }
      if (!cloudApiEnabled) {
        return restrictedErrorResponse(req, 
          "Cloud API connections are disabled. Please use Coexistence mode instead.",
          403,
        );
      }
    }

    // 1. Exchange code for system user access token (no redirect_uri for Embedded Signup)
    const tokenUrl =
      `${GRAPH_API}/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[whatsapp-oauth] Token exchange failed:", tokenData);
      return restrictedErrorResponse(req, 
        `Token exchange failed: ${tokenData.error?.message || JSON.stringify(tokenData)}`,
        400,
      );
    }
    const accessToken: string = tokenData.access_token;
    const expiresIn: number | undefined = tokenData.expires_in;

    // 2. Subscribe Postora to the WABA's webhooks
    const subscribeRes = await fetch(`${GRAPH_API}/${waba_id}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const subscribeData = await subscribeRes.json();
    if (!subscribeRes.ok) {
      console.warn("[whatsapp-oauth] Subscribe failed:", subscribeData);
      // Don't fail hard — user can still send messages even if webhook isn't subscribed
    }

    // 2b. Subscribe app-level coexistence webhook fields (required for
    // history/echoes/contact-sync delivery). These must be subscribed at the
    // app level, not per-WABA.
    const META_APP_ID = Deno.env.get("META_APP_ID") || Deno.env.get("FACEBOOK_APP_ID");
    const appVerifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") ||
      Deno.env.get("META_WEBHOOK_VERIFY_TOKEN");
    const appUrl = Deno.env.get("APP_URL") ||
      Deno.env.get("VITE_SUPABASE_URL") || "";

    if (META_APP_ID && appVerifyToken && appUrl) {
      const COEXISTENCE_FIELDS = [
        "messages", "history", "smb_message_echoes", "smb_app_state_sync",
        "account_update", "phone_number_name_update", "phone_number_quality_update",
        "message_template_status_update", "template_category_update",
      ];
      try {
        const subRes = await fetch(
          `${GRAPH_API}/${META_APP_ID}/subscriptions?access_token=${accessToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              object: "whatsapp_business_account",
              callback_url: `${appUrl.replace(/\/$/, "")}/functions/v1/whatsapp-webhook`,
              verify_token: appVerifyToken,
              fields: COEXISTENCE_FIELDS,
              include_values: true,
            }),
          },
        );
        const subData = await subRes.json();
        console.log("[whatsapp-oauth] App-level subscription result:", JSON.stringify(subData));
      } catch (subErr) {
        console.warn("[whatsapp-oauth] App-level subscription failed (non-fatal):", subErr);
      }
    } else {
      console.warn("[whatsapp-oauth] Missing META_APP_ID, WHATSAPP_WEBHOOK_VERIFY_TOKEN, or APP_URL — skipping app-level subscription");
    }

    // 3. For Cloud API mode, register the phone number. Skip for Coexistence.
    let registrationStatus: "registered" | "skipped_coexistence" | "failed" = "skipped_coexistence";
    if (mode === "cloud_api") {
      try {
        const pin = Deno.env.get("WHATSAPP_VERIFY_PIN") || "000000";
        const regRes = await fetch(`${GRAPH_API}/${phone_number_id}/register`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messaging_product: "whatsapp", pin }),
        });
        const regData = await regRes.json();
        if (regRes.ok) {
          registrationStatus = "registered";
        } else {
          console.warn("[whatsapp-oauth] Registration failed:", regData);
          registrationStatus = "failed";
        }
      } catch (e) {
        console.error("[whatsapp-oauth] Register threw:", e);
        registrationStatus = "failed";
      }
    }

    // 4. Fetch phone number display details
    let displayPhone = "";
    let verifiedName = "";
    try {
      const infoRes = await fetch(
        `${GRAPH_API}/${phone_number_id}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const infoData = await infoRes.json();
      displayPhone = infoData.display_phone_number || "";
      verifiedName = infoData.verified_name || "";
    } catch (e) {
      console.warn("[whatsapp-oauth] Phone info fetch failed (non-fatal):", e);
    }

    // 5. Upsert social_accounts row
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const { data: existing } = await admin
      .from("social_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("platform", "whatsapp")
      .eq("platform_user_id", phone_number_id)
      .maybeSingle();

    const accountMetadata = {
      waba_id,
      phone_number_id,
      business_id: business_id || null,
      business_name: verifiedName || null,
      display_phone_number: displayPhone || null,
      connection_mode: mode,
      registration_status: registrationStatus,
      subscribed: subscribeRes.ok,
    };

    if (existing) {
      await admin
        .from("social_accounts")
        .update({
          platform_username: displayPhone || verifiedName || phone_number_id,
          access_token: accessToken,
          token_expires_at: tokenExpiresAt,
          account_metadata: accountMetadata,
          is_active: true,
          needs_reauth: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await admin.from("social_accounts").insert({
        user_id: userId,
        platform: "whatsapp",
        platform_user_id: phone_number_id,
        platform_username: displayPhone || verifiedName || phone_number_id,
        access_token: accessToken,
        token_expires_at: tokenExpiresAt,
        account_metadata: accountMetadata,
        is_active: true,
      });
    }

    return restrictedJsonResponse(req, {
      success: true,
      mode,
      registration_status: registrationStatus,
      display_phone_number: displayPhone,
      verified_name: verifiedName,
    });
  } catch (err) {
    console.error("[whatsapp-oauth] Error:", err);
    return restrictedErrorResponse(req, (err as Error).message, 500);
  }
});
