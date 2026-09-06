import type { AiTier } from "./ai-fallback.ts";
import { AI_USER_KEY_INVALID, ProviderHttpError } from "./ai-routing-errors.ts";

interface DbResult {
  data: unknown;
  error: unknown;
}
interface Query extends PromiseLike<DbResult> {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  maybeSingle(): PromiseLike<DbResult>;
}
export interface AiRoutingAdmin {
  from(table: string): {
    select(columns: string): Query;
    update(values: Record<string, unknown>): Query;
  };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResult>;
}
export interface UserAiRoute {
  mode: "postora_only" | "user_first" | "user_only";
  userTier?: AiTier & { credentialSource: "user" };
  allowPlatformFallback: boolean;
  reason?: "flag_off" | "no_preference" | "user_key_missing";
  /** The key row's updated_at at read time; markUserKeyInvalid matches on it. */
  fetchedAt?: string;
}
function row(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI routing response");
  }
  return value as Record<string, unknown>;
}

export async function resolveUserAiRoute(
  admin: AiRoutingAdmin,
  userId: string,
  capability: "chat" | "agent",
): Promise<UserAiRoute> {
  const global = await admin.from("app_settings").select("value").eq(
    "key",
    "feature_byok_providers",
  ).maybeSingle();
  if (global.error) throw new Error("AI feature flag read failed");
  const override = await admin.from("user_feature_overrides").select(
    "enabled, expires_at",
  )
    .eq("user_id", userId).eq("feature_key", "feature_byok_providers")
    .maybeSingle();
  if (override.error) throw new Error("AI feature override read failed");
  const overrideRow = row(override.data);
  const unexpired = overrideRow &&
    (!overrideRow.expires_at ||
      Date.parse(String(overrideRow.expires_at)) > Date.now());
  // app_settings values have been written both as jsonb true and as the
  // string "true" (see useFeatureFlags.tsx); accept both, like the frontend.
  const globalValue = row(global.data)?.value;
  const enabled = unexpired
    ? overrideRow.enabled === true
    : globalValue === true || globalValue === "true";
  if (!enabled) {
    return {
      mode: "postora_only",
      allowPlatformFallback: false,
      reason: "flag_off",
    };
  }

  const preferences = await admin.from("user_ai_routing_preferences")
    .select(
      "capability, mode, preferred_provider_code, preferred_model_id, allow_platform_fallback",
    )
    .eq("user_id", userId).in("capability", [capability, "*"]);
  if (preferences.error) throw new Error("AI routing preference read failed");
  if (!Array.isArray(preferences.data)) {
    throw new Error("Invalid AI routing preferences response");
  }
  const rows = preferences.data.map(row);
  const preference = rows.find((entry) => entry?.capability === capability) ??
    rows.find((entry) => entry?.capability === "*");
  if (!preference) {
    return {
      mode: "postora_only",
      allowPlatformFallback: false,
      reason: "no_preference",
    };
  }
  const mode = preference.mode;
  if (mode === "postora_only") return { mode, allowPlatformFallback: false };
  if (mode !== "user_first" && mode !== "user_only") {
    throw new Error("Invalid AI routing mode");
  }
  if (mode === "user_first" && preference.allow_platform_fallback !== true) {
    throw new Error("AI platform fallback consent required");
  }
  const provider = preference.preferred_provider_code;
  const model = preference.preferred_model_id;
  if (
    typeof provider !== "string" ||
    !["openai", "claude", "gemini", "openrouter"].includes(provider) ||
    typeof model !== "string" || !model.trim()
  ) {
    throw new Error("Invalid AI routing preference");
  }
  // The key and its row version come from ONE statement, so they always
  // describe the same revision. markUserKeyInvalid matches on equality with
  // that updated_at; a replacement that commits later bumps it and can never
  // be invalidated by the old key's rejection. (Two statements, or a Deno
  // clock compared with <=, both race the replacement transaction.)
  const snapshot = await admin.rpc("get_user_ai_provider_key_snapshot", {
    p_user_id: userId,
    p_provider_code: provider,
  });
  if (snapshot.error) throw new Error("AI provider key read failed");
  const snapshotRows = Array.isArray(snapshot.data)
    ? snapshot.data
    : snapshot.data === null
    ? []
    : [snapshot.data];
  if (snapshotRows.length === 0) {
    return {
      mode,
      allowPlatformFallback: mode === "user_first",
      reason: "user_key_missing",
    };
  }
  const keyRow = row(snapshotRows[0]);
  if (
    !keyRow || typeof keyRow.api_key !== "string" ||
    typeof keyRow.updated_at !== "string" || !keyRow.updated_at
  ) {
    throw new Error("Invalid AI provider key response");
  }
  if (!keyRow.api_key.trim()) {
    return {
      mode,
      allowPlatformFallback: mode === "user_first",
      reason: "user_key_missing",
    };
  }
  return {
    mode,
    allowPlatformFallback: mode === "user_first",
    fetchedAt: keyRow.updated_at,
    userTier: {
      provider,
      model,
      credentialSource: "user",
      apiKey: keyRow.api_key,
    },
  };
}

export async function markUserKeyInvalid(
  admin: AiRoutingAdmin,
  userId: string,
  providerCode: string,
  fetchedAt: string,
): Promise<void> {
  const { error } = await admin.from("user_ai_provider_keys")
    .update({ status: "invalid", last_error_code: AI_USER_KEY_INVALID })
    .eq("user_id", userId).eq("provider_code", providerCode)
    .eq("updated_at", fetchedAt);
  if (error) throw new Error("AI provider key invalidation failed");
}

export function composeAiTiers(
  route: UserAiRoute,
  platformTiers: AiTier[],
): AiTier[] {
  return [
    ...(route.userTier ? [route.userTier] : []),
    ...(route.mode === "user_only" ? [] : platformTiers),
  ].slice(0, 3);
}

export async function invalidateRejectedUserTier(
  admin: AiRoutingAdmin,
  userId: string,
  route: UserAiRoute,
  error: unknown,
): Promise<void> {
  if (
    error instanceof ProviderHttpError && error.credentialSource === "user" &&
    [401, 403].includes(error.status)
  ) {
    if (!route.fetchedAt) throw new Error("AI credential read version missing");
    await markUserKeyInvalid(admin, userId, error.provider, route.fetchedAt);
  }
}
