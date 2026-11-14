import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { OAUTH_PROVIDER_CODE } from "../_shared/aiOAuth/clients.ts";
import { readAiTextFlags } from "../_shared/aiOAuth/textFlags.ts";
import { resolveProviderKey } from "../_shared/providerKeys.ts";
import type { RowReader } from "../_shared/providerEndpoint.ts";
import { readCatalogue } from "./readCatalogue.ts";
import { buildChatListPolicy, ChatTierError, validateChatTier, type ChatPolicySnapshot } from "./chatListPolicy.ts";

export async function loadChatPolicySnapshot(admin: SupabaseClient, flags: ChatPolicySnapshot["flags"]): Promise<ChatPolicySnapshot> {
  const signal = AbortSignal.timeout(10_000);
  const [providers, catalogue, settings, statuses] = await Promise.all([
    admin.from("ai_providers").select("id,provider_code,name,is_active").order("name").abortSignal(signal),
    readCatalogue(admin),
    admin.from("system_settings").select("key,value").or("key.like.default_ai_model_chat%,key.like.model_catalog_synced_at_%").abortSignal(signal),
    admin.rpc("get_ai_oauth_statuses").abortSignal(signal),
  ]);
  if (providers.error || settings.error || statuses.error) throw new Error("Chat readiness read failed");
  const apiKeys = Object.fromEntries(await Promise.all((providers.data ?? []).map(async provider => [
    provider.provider_code, Boolean(await resolveProviderKey(admin as unknown as RowReader, provider.provider_code, signal)),
  ])));
  const registry = Object.fromEntries(Object.entries(OAUTH_PROVIDER_CODE).map(([oauthProvider, providerCode]) => [
    providerCode, getModels(oauthProvider as never).map(model => model.id),
  ]));
  // The shared catalogue reader preserves provider-specific columns. This seam
  // projects only non-secret fields needed by eligibility and the admin UI.
  return { flags, providers: providers.data ?? [], settings: settings.data ?? [], statuses: statuses.data ?? [], apiKeys, registry,
    models: [...catalogue.models, ...catalogue.oauthModels] as unknown as ChatPolicySnapshot["models"] };
}

export interface ChatActionDeps {
  isAdmin(): Promise<boolean>;
  flags(): Promise<ChatPolicySnapshot["flags"]>;
  snapshot(flags: ChatPolicySnapshot["flags"]): Promise<ChatPolicySnapshot>;
  persist(tier: ReturnType<typeof validateChatTier>): Promise<void>;
  logRefusal(reason: string): Promise<void>;
}

export async function runChatListAction(action: "chat-list-policy" | "set-chat-tier", body: unknown, deps: ChatActionDeps): Promise<Response> {
  try {
    if (!(await deps.isAdmin())) throw new ChatTierError("not_admin", 403);
    const flags = await deps.flags();
    if (!flags.feature_ai_text_auth_lists) {
      if (action === "chat-list-policy") return Response.json({ enabled: false });
      throw new ChatTierError("text_lists_disabled");
    }
    const snapshot = await deps.snapshot(flags);
    if (action === "chat-list-policy") return Response.json(buildChatListPolicy(snapshot));
    await deps.persist(validateChatTier(body, snapshot));
    return Response.json({ success: true });
  } catch (cause) {
    const reason = cause instanceof ChatTierError ? cause.code : "configuration_read_or_write_failed";
    await deps.logRefusal(reason);
    return Response.json({ error: reason }, { status: cause instanceof ChatTierError ? cause.status : 503 });
  }
}

export function chatActionDeps(admin: SupabaseClient, userId: string): ChatActionDeps {
  return {
    isAdmin: async () => {
      const { data, error } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
      if (error) throw new Error("Admin check failed");
      return Boolean(data);
    },
    flags: () => readAiTextFlags(admin),
    snapshot: flags => loadChatPolicySnapshot(admin, flags),
    persist: async tier => {
      const { data, error } = await admin.rpc("write_ai_chat_tier", { p_key: tier.key, p_value: tier.value, p_expected: tier.expected });
      if (error) throw new Error("Chat tier write failed");
      if (data !== true) throw new ChatTierError("configuration_changed_retry");
    },
    logRefusal: async reason => {
      const { error } = await admin.from("system_logs").insert({ level: "warn", category: "ai", source: "ai-config", message: "Chat configuration refused", user_id: userId, metadata: { reason } });
      if (error) console.warn({ event: "ai_chat_refusal_log_failed", reason });
    },
  };
}
