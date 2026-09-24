// deno-lint-ignore-file no-explicit-any
// Providers whose chat URL is hardcoded in getAiEndpoint. Everything else with
// api_type='openai' is reached through its ai_providers.api_endpoint.
export const BUILTIN_CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  "claude", "openai", "openrouter", "xai", "google", "gemini", "lovable",
]);

// Env fallbacks for data-driven providers (provider_api_keys is checked first).
export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  vercel: "AI_GATEWAY_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const cache = new Map<string, string | null>();

export function clearProviderEndpointCache(): void {
  cache.clear();
}

// callAiWithFallback (ai-email-assistant, analyze-log, suggest-best-times) calls
// callAiChain without a client. Rather than skipping data-driven providers there,
// read the provider row with a service-role client of our own. ai_providers holds
// no secrets.
async function serviceClient(): Promise<any> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function loadOpenAiCompatibleBase(admin: any | undefined, providerCode: string): Promise<string | null> {
  if (cache.has(providerCode)) return cache.get(providerCode)!;
  const db = admin ?? await serviceClient();
  const { data, error } = await db.from("ai_providers")
    .select("api_endpoint, api_type, is_active").eq("provider_code", providerCode).maybeSingle();
  if (error) throw new Error("AI provider read failed");
  const base = data && data.is_active && data.api_type === "openai" && typeof data.api_endpoint === "string"
    ? data.api_endpoint.replace(/\/+$/, "")
    : null;
  cache.set(providerCode, base);
  return base;
}
