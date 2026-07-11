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

interface RequestSyncBody {
  action: "request_sync";
  social_account_id: string;
}

type SmbSyncType = "smb_app_state_sync" | "history";

interface SmbSyncResult {
  sync_type: SmbSyncType;
  success: boolean;
  request_id?: string;
  error?: string;
}

// Coexistence numbers never push phone data on their own: Meta only sends
// history / contact webhooks after an explicit smb_app_data request, and only
// within 24h of onboarding. If the business declined history sharing, the
// request still succeeds but Meta answers with a history webhook carrying
// error 2593109 instead of messages.
async function requestSmbAppDataSync(
  phoneNumberId: string,
  accessToken: string,
  syncType: SmbSyncType,
): Promise<SmbSyncResult> {
  try {
    const res = await fetch(`${GRAPH_API}/${phoneNumberId}/smb_app_data`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return { sync_type: syncType, success: true, request_id: data.request_id };
    }
    console.warn(`[whatsapp-oauth] ${syncType} sync request failed:`, data);
    return {
      sync_type: syncType,
      success: false,
      error: data.error?.message || JSON.stringify(data),
    };
  } catch (e) {
    console.warn(`[whatsapp-oauth] ${syncType} sync request threw:`, e);
    return { sync_type: syncType, success: false, error: (e as Error).message };
  }
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
    const body = (await req.json()) as ExchangeBody | DisconnectBody | RequestSyncBody;

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

    // ============ REQUEST_SYNC (coexistence chat history + contacts) ============
    if (body.action === "request_sync") {
      const { data: account } = await admin
        .from("social_accounts")
        .select("id, user_id, platform_user_id, access_token, account_metadata")
        .eq("id", body.social_account_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!account) return restrictedErrorResponse(req, "Account not found", 404);

      const meta = (account.account_metadata || {}) as Record<string, unknown>;
      if (meta.connection_mode !== "coexistence") {
        return restrictedErrorResponse(req, "Chat sync is only available for coexistence connections", 400);
      }
      if (!account.access_token) {
        return restrictedErrorResponse(req, "Account has no access token — reconnect first", 400);
      }

      const results = [
        await requestSmbAppDataSync(account.platform_user_id, account.access_token, "smb_app_state_sync"),
        await requestSmbAppDataSync(account.platform_user_id, account.access_token, "history"),
      ];
      return restrictedJsonResponse(req, {
        success: results.every((r) => r.success),
        results,
      });
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

    // App-level webhook fields (history/smb_*) are NOT subscribed here:
    // POST /{app-id}/subscriptions needs an APP access token (not this WABA
    // user token) and would overwrite the dashboard-configured callback URL.
    // They are configured once in the Meta App Dashboard and verified by
    // whatsapp-config-test's webhook_fields check.

    // Coexistence: ask Meta to push the phone's contacts and chat history.
    let syncRequests: SmbSyncResult[] | null = null;
    if (mode === "coexistence") {
      syncRequests = [
        await requestSmbAppDataSync(phone_number_id, accessToken, "smb_app_state_sync"),
        await requestSmbAppDataSync(phone_number_id, accessToken, "history"),
      ];
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
      sync_requests: syncRequests,
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
      sync_requests: syncRequests,
    });
  } catch (err) {
    console.error("[whatsapp-oauth] Error:", err);
    return restrictedErrorResponse(req, (err as Error).message, 500);
  }
});
