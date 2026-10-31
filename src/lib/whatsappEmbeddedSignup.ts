// WhatsApp Embedded Signup helper
// Launches Meta's Embedded Signup popup for either Cloud API or Coexistence mode,
// captures the WABA + phone number ID, and returns the auth code for backend exchange.

import { loadFacebookSdk } from "./facebookSdk";
import { supabase } from "@/integrations/supabase/client";

export type WhatsAppConnectionMode = "cloud_api" | "coexistence" | "evolution_qr";

export interface WhatsAppSignupResult {
  code: string;
  waba_id: string;
  phone_number_id: string;
  business_id?: string;
  mode: WhatsAppConnectionMode;
}

interface WAEmbeddedSignupMessage {
  type: "WA_EMBEDDED_SIGNUP";
  event: "FINISH" | "CANCEL" | "ERROR" | string;
  data?: {
    waba_id?: string;
    phone_number_id?: string;
    business_id?: string;
    error_message?: string;
    current_step?: string;
  };
}

let configCache: { cloud_api: string; coexistence: string } | null = null;

async function fetchConfigIds(): Promise<{ cloud_api: string; coexistence: string }> {
  if (configCache && (configCache.cloud_api || configCache.coexistence)) return configCache;
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["META_WHATSAPP_CONFIG_ID", "META_WHATSAPP_COEXISTENCE_CONFIG_ID"]);
  if (error) throw error;
  const normalize = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
      return normalize((v as Record<string, unknown>).value);
    }
    try {
      return JSON.stringify(v).replace(/^"|"$/g, "").trim();
    } catch {
      return "";
    }
  };
  const map: Record<string, string> = {};
  for (const row of data || []) {
    const r = row as { key: string; value: unknown };
    map[r.key] = normalize(r.value);
  }
  configCache = {
    cloud_api: map["META_WHATSAPP_CONFIG_ID"] || "",
    coexistence: map["META_WHATSAPP_COEXISTENCE_CONFIG_ID"] || "",
  };
  return configCache;
}

export async function launchWhatsAppSignup(mode: WhatsAppConnectionMode): Promise<WhatsAppSignupResult> {
  if (mode === "evolution_qr") {
    throw new Error("Embedded Signup is not available for Direct QR mode.");
  }
  await loadFacebookSdk();

  const configs = await fetchConfigIds();
  const configId = mode === "coexistence" ? configs.coexistence : configs.cloud_api;
  if (!configId || !configId.trim()) {
    clearWhatsAppSignupConfigCache();
    throw new Error(
      mode === "coexistence"
        ? "WhatsApp Coexistence Config ID is not configured. Please go to Admin Settings → App Credentials and add the META_WHATSAPP_COEXISTENCE_CONFIG_ID value."
        : "WhatsApp Config ID is not configured. Please go to Admin Settings → App Credentials and add the META_WHATSAPP_CONFIG_ID value."
    );
  }

  return new Promise<WhatsAppSignupResult>((resolve, reject) => {
    const captured: { waba_id?: string; phone_number_id?: string; business_id?: string } = {};

    const messageHandler = (event: MessageEvent) => {
      // Meta sends messages from facebook.com origins
      if (typeof event.data !== "string" && typeof event.data !== "object") return;
      let payload: WAEmbeddedSignupMessage | null = null;
      try {
        payload = typeof event.data === "string" ? JSON.parse(event.data) : (event.data as WAEmbeddedSignupMessage);
      } catch {
        return;
      }
      if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;

      // Log every WA Embedded Signup event for debugging
      console.log("[WA Embedded Signup]", payload.event, payload.data);

      // Capture IDs from ANY event that contains them — Meta sends progressive
      // events (current_step, FINISH, etc.) and IDs may arrive before FINISH.
      if (payload.data) {
        const d = payload.data as Record<string, unknown> & {
          waba_id?: string;
          phone_number_id?: string;
          business_id?: string;
        };
        // Some SDK versions nest the IDs one level deeper under data.data
        const inner = (d as { data?: Record<string, unknown> }).data as
          | { waba_id?: string; phone_number_id?: string; business_id?: string }
          | undefined;
        const wabaId = d.waba_id || inner?.waba_id;
        const phoneId = d.phone_number_id || inner?.phone_number_id;
        const bizId = d.business_id || inner?.business_id;
        if (wabaId) captured.waba_id = wabaId;
        if (phoneId) captured.phone_number_id = phoneId;
        if (bizId) captured.business_id = bizId;
      }

      if (payload.event === "CANCEL") {
        cleanup();
        reject(new Error("Signup was cancelled."));
      } else if (payload.event === "ERROR") {
        cleanup();
        reject(new Error(payload.data?.error_message || "Signup failed."));
      }
    };

    const cleanup = () => window.removeEventListener("message", messageHandler);
    window.addEventListener("message", messageHandler);

    // Meta's official featureType values:
    // - Coexistence: "whatsapp_business_app_onboarding"
    //   (https://developers.facebook.com/docs/whatsapp/embedded-signup/coexistence)
    // - Cloud API:   "whatsapp_business_app"
    const featureType =
      mode === "coexistence" ? "whatsapp_business_app_onboarding" : "whatsapp_business_app";

    // Use FB.login with extended config for Embedded Signup
    // Note: typings on window.FB.login don't include all options; cast carefully.
    const loginOptions = {
      config_id: configId,
      response_type: "code",
      override_default_response_type: true,
      extras: {
        feature: "whatsapp_embedded_signup",
        setup: {},
        sessionInfoVersion: "3",
        featureType,
      },
    } as unknown as { scope?: string; auth_type?: string };

    // IMPORTANT: FB.login requires a SYNCHRONOUS callback. Newer versions of
    // Meta's JS SDK explicitly reject async callbacks with
    // "Expression is of type asyncfunction, not function". We wrap the async
    // logic in an IIFE inside the sync callback to preserve behavior.
    window.FB.login((response: unknown) => {
      void (async () => {
        const r = response as { authResponse?: { code?: string }; status?: string };
        const code = r?.authResponse?.code;

        // Wait up to 2.5s for any straggling postMessage events with IDs
        // (FB.login callback can fire before the final WA_EMBEDDED_SIGNUP message)
        const waitForIds = async () => {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            if (captured.waba_id && captured.phone_number_id) return;
            await new Promise((r) => setTimeout(r, 100));
          }
        };
        await waitForIds();
        cleanup();

        if (!code) {
          // No authResponse + no FINISH/CANCEL/ERROR message usually means Meta
          // silently blocked the popup — most commonly because the app is not
          // approved as a Tech Provider / BSP for Embedded Signup.
          if (!captured.waba_id && !captured.phone_number_id) {
            reject(
              new Error(
                "Meta closed the popup without returning data. Most common causes: (1) the Configuration ID was created under a different Meta App than the active FACEBOOK_APP_ID, (2) the app is not yet approved as a Tech Provider / BSP for Embedded Signup, or (3) the WhatsApp / Facebook Login for Business products are not enabled on the app. Go to Admin Settings → App Credentials → WhatsApp and click \"Test\" to see the exact mismatch."
              )
            );
            return;
          }
          reject(new Error("No authorization code returned from Meta."));
          return;
        }
        if (!captured.waba_id || !captured.phone_number_id) {
          reject(
            new Error(
              "Signup completed but WABA or phone number ID was not captured. Make sure you filled in your WhatsApp Business account name in the Meta popup before clicking Next, then try again."
            )
          );
          return;
        }
        resolve({
          code,
          waba_id: captured.waba_id,
          phone_number_id: captured.phone_number_id,
          business_id: captured.business_id,
          mode,
        });
      })();
    }, loginOptions);
  });
}

export function clearWhatsAppSignupConfigCache() {
  configCache = null;
}
