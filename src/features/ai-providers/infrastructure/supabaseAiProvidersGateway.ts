import { supabase } from "@/integrations/supabase/client";
import {
  PROVIDERS,
  type AiProvidersGateway,
  type KeyStatus,
  type ProviderCode,
  type ProviderModel,
  type RoutingPreference,
} from "../application/ports";

function failure(code = "AI_PROVIDERS_REQUEST_FAILED"): Error {
  return Object.assign(new Error(code), { code });
}

function check(error: { code?: string } | null) {
  if (error) throw failure(error.code);
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("user-ai-providers", { body });
  if (error) {
    // FunctionsHttpError carries the JSON envelope on its Response, including on 400/503.
    const response = error.context;
    if (response instanceof Response) {
      const envelope = await response.clone().json().catch(() => null);
      throw failure(response.status === 429 ? "429" : envelope?.code);
    }
    throw failure();
  }
  if (!data?.ok) throw failure(data?.code);
  return data.data as T;
}

// Explicit projection keeps key material out of query and mutation results even if
// the endpoint accidentally adds fields to its response in the future.
function safeStatus(row: KeyStatus): KeyStatus {
  return {
    id: row.id, user_id: row.user_id, provider_code: row.provider_code,
    key_hint: row.key_hint?.slice(-4) ?? null, status: row.status,
    last_verified_at: row.last_verified_at, updated_at: row.updated_at,
  };
}

export function createSupabaseAiProvidersGateway(userId: string): AiProvidersGateway {
  return {
    async listKeys() {
      const data = await invoke<{ keys: KeyStatus[] }>({ action: "list" });
      return data.keys.map(safeStatus);
    },
    async saveKey(provider_code, api_key) {
      return safeStatus(await invoke<KeyStatus>({ action: "save_key", provider_code, api_key }));
    },
    async testKey(provider_code) {
      return safeStatus(await invoke<KeyStatus>({ action: "test_key", provider_code }));
    },
    async deleteKey(provider_code) {
      await invoke({ action: "delete_key", provider_code });
    },
    async joinWaitlist() {
      await invoke({ action: "join_waitlist", provider_code: "codex" });
    },
    async isOnWaitlist() {
      const { data, error } = await supabase.from("ai_provider_waitlist")
        .select("user_id").eq("user_id", userId).eq("provider_code", "codex").maybeSingle();
      check(error);
      return data !== null;
    },
    async getPreferences() {
      const { data, error } = await supabase.from("user_ai_routing_preferences")
        .select("capability, mode, preferred_provider_code, preferred_model_id, allow_platform_fallback, updated_at")
        .eq("user_id", userId);
      check(error);
      return (data ?? []) as RoutingPreference[];
    },
    async upsertPreference(pref) {
      if (pref.allow_platform_fallback !== (pref.mode === "user_first") ||
          (pref.mode !== "postora_only" && (!pref.preferred_provider_code || !pref.preferred_model_id))) {
        throw failure("AI_ROUTING_PREFERENCE_INVALID");
      }
      const { error } = await supabase.from("user_ai_routing_preferences").upsert({
        user_id: userId, capability: pref.capability, mode: pref.mode,
        preferred_provider_code: pref.mode === "postora_only" ? null : pref.preferred_provider_code,
        preferred_model_id: pref.mode === "postora_only" ? null : pref.preferred_model_id,
        allow_platform_fallback: pref.allow_platform_fallback,
      }, { onConflict: "user_id,capability" });
      check(error);
    },
    async deletePreference(capability) {
      const { error } = await supabase.from("user_ai_routing_preferences").delete()
        .eq("user_id", userId).eq("capability", capability);
      check(error);
    },
    async listModels() {
      // ai_providers is admin-only under RLS, so the catalog comes from the
      // Edge Function (service role) rather than a browser join.
      const data = await invoke<{ models: ProviderModel[] }>({ action: "list_models" });
      return data.models
        .filter(row => row.provider_code in PROVIDERS)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
