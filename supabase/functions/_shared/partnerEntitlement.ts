// Server-side entitlement for partner actions (section expansion spec §10).
// The browser's flag cache and admin elevation do not apply to partner keys.
import { logToDatabase } from "./logging.ts";
import { v1ErrorResponse } from "../partner-api/v1/errors.ts";

// Keys verified against useFeatureFlags.FLAG_KEYS / FLAG_KEY_MAP. Each action
// requires ALL listed keys; pairing and registration also require Direct QR.
export const ACTION_FEATURE_KEYS: Record<string, readonly string[]> = {
  // Manual inbox actions; comment_workflow gates the separate automation page.
  list_comments: ["feature_comment_manager"],
  get_comment: ["feature_comment_manager"],
  reply_comment: ["feature_comment_manager"],
  hide_comment: ["feature_comment_manager"],
  delete_comment: ["feature_comment_manager"],

  list_whatsapp_numbers: ["feature_msg_whatsapp"],
  get_whatsapp_number: ["feature_msg_whatsapp"],
  register_whatsapp_number: ["feature_msg_whatsapp", "feature_wa_evolution_qr_enabled"],
  create_whatsapp_pairing: ["feature_msg_whatsapp", "feature_wa_evolution_qr_enabled"],
  get_whatsapp_pairing: ["feature_msg_whatsapp", "feature_wa_evolution_qr_enabled"],
  end_whatsapp_session: ["feature_msg_whatsapp"],
  start_whatsapp_history_sync: ["feature_msg_whatsapp"],
  get_whatsapp_history_sync: ["feature_msg_whatsapp"],
  // Business profiles are a Cloud API capability, independent of the QR flag.
  get_whatsapp_profile: ["feature_msg_whatsapp"],
  update_whatsapp_profile: ["feature_msg_whatsapp"],
};

/** The authenticated workspace's provisioned owner is its entitlement subject.
 *  Returns a logged refusal, or null only when every required key is enabled. */
export async function assertEntitled(
  // Supabase client versions differ between Edge Functions (infrastructure seam).
  // deno-lint-ignore no-explicit-any
  admin: any,
  workspaceId: string,
  action: string,
  requestId: string,
): Promise<Response | null> {
  const refuse = async (
    code: "feature_not_entitled" | "internal_error",
    reason: string,
    missing?: string[],
  ): Promise<Response> => {
    await logToDatabase(admin, {
      level: code === "internal_error" ? "error" : "warn",
      category: "auth",
      source: "partner-api",
      message: "Partner feature entitlement refused",
      metadata: {
        event: "partner_entitlement_refused", workspace_id: workspaceId,
        action, request_id: requestId, error_code: code, reason,
        ...(missing ? { missing_feature_keys: missing } : {}),
      },
    });
    return v1ErrorResponse(code, requestId, missing
      ? { details: { missing_feature_keys: missing } }
      : {});
  };

  // Own-property lookup prevents Object.prototype names from becoming policy.
  const requiredKeys = Object.hasOwn(ACTION_FEATURE_KEYS, action) ? ACTION_FEATURE_KEYS[action] : [];
  if (requiredKeys.length === 0) return await refuse("internal_error", "missing_action_policy");

  let readStage = "provisioning";
  try {
    const { data: provisioning, error: provisioningError } = await admin
      .from("partner_provisioned_workspaces")
      .select("owner_user_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (provisioningError) return await refuse("internal_error", "provisioning_read_failed");
    if (!provisioning?.owner_user_id) return await refuse("feature_not_entitled", "missing_provisioned_owner");

    readStage = "global";
    const { data: globalRows, error: globalError } = await admin
      .from("app_settings")
      .select("key, value")
      .in("key", requiredKeys);
    if (globalError) return await refuse("internal_error", "global_read_failed");

    const state = new Map<string, boolean>();
    for (const row of globalRows ?? []) state.set(row.key, coerceFlag(row.value));

    readStage = "override";
    const { data: overrides, error: overrideError } = await admin
      .from("user_feature_overrides")
      .select("feature_key, enabled, expires_at")
      .eq("user_id", provisioning.owner_user_id)
      .in("feature_key", requiredKeys);
    if (overrideError) return await refuse("internal_error", "override_read_failed");

    const now = Date.now();
    for (const override of overrides ?? []) {
      // Invalid timestamps cannot establish an unexpired grant either.
      if (override.expires_at !== null && !(Date.parse(override.expires_at) > now)) continue;
      // An override may change an existing setting, but a missing global row
      // is a configuration gap and must still refuse, even with an override.
      if (state.has(override.feature_key)) state.set(override.feature_key, override.enabled === true);
    }

    const missing = requiredKeys.filter((key) => state.get(key) !== true);
    if (missing.length > 0) return await refuse("feature_not_entitled", "disabled_or_missing_flags", missing);
    return null;
  } catch {
    // Transport failures may throw instead of returning PostgREST's error.
    // Record the stage, never a raw exception or database response.
    return await refuse("internal_error", `${readStage}_read_threw`);
  }
}

/** Match useFeatureFlags: parse a string ONCE, then accept true or "true". */
function coerceFlag(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // The browser keeps an unparseable string unchanged.
    }
  }
  return value === true || value === "true";
}
