// Providers whose chat URL is hardcoded in getAiEndpoint. Everything else with
// api_type='openai' is reached through its ai_providers.api_endpoint.
export const BUILTIN_CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  "claude", "openai", "openrouter", "xai", "google", "gemini", "lovable",
]);

/** The one read shape this module and providerKeys.ts need from a Supabase client. */
export interface RowReader {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

// Admins can edit ai_providers at runtime; a warm isolate re-reads after a minute.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: string | null; at: number }>();

export function clearProviderEndpointCache(): void {
  cache.clear();
}

// callAiWithFallback (ai-email-assistant, analyze-log, suggest-best-times) calls
// callAiChain without a client. Rather than skipping data-driven providers there,
// read the provider row with a service-role client of our own.
export async function serviceClient(): Promise<RowReader> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!) as unknown as RowReader;
}

export async function loadOpenAiCompatibleBase(admin: RowReader | undefined, providerCode: string): Promise<string | null> {
  const hit = cache.get(providerCode);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const db = admin ?? await serviceClient();
  const { data, error } = await db.from("ai_providers")
    .select("api_endpoint, api_type, is_active").eq("provider_code", providerCode).maybeSingle();
  if (error) throw new Error("AI provider read failed");
  const row = data as { api_endpoint?: unknown; api_type?: unknown; is_active?: unknown } | null;
  const base = row && row.is_active && row.api_type === "openai" && typeof row.api_endpoint === "string"
    ? row.api_endpoint.replace(/\/+$/, "")
    : null;
  cache.set(providerCode, { value: base, at: Date.now() });
  return base;
}
