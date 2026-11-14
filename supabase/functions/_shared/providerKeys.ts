import { type RowReader, serviceClient, ProviderReadError } from "./providerEndpoint.ts";

/** Services can have credentials before they have an ai_providers row. */
export const STANDALONE_SERVICE_ENV: Readonly<Record<string, string>> = {
  firecrawl: "FIRECRAWL_API_KEY", apify: "APIFY_API_KEY",
};

/**
 * The platform key for a provider: the admin-saved provider_api_keys row first,
 * then the env var its ai_providers row names, else null. The one resolver for
 * data-driven providers, so no vendor ever receives another vendor's key.
 * A failed read throws: an unreadable key table is not a missing key.
 */
export async function resolveProviderKey(db: RowReader | undefined, providerCode: string, signal?: AbortSignal): Promise<string | null> {
  const client = db ?? await serviceClient();
  const read = async (table: string, columns: string) => {
    const query = client.from(table).select(columns).eq("provider_code", providerCode);
    if (signal && !query.abortSignal) throw new Error('Provider read cancellation is unavailable');
    return (signal ? query.abortSignal!(signal) : query).maybeSingle();
  };
  const saved = await read("provider_api_keys", "api_key");
  if (saved.error) throw new ProviderReadError("Provider key read failed");
  const key = (saved.data as { api_key?: unknown } | null)?.api_key;
  if (typeof key === "string" && key.trim()) return key;

  const provider = await read("ai_providers", "api_key_env_var");
  if (provider.error) throw new ProviderReadError("AI provider read failed");
  const envVar = (provider.data as { api_key_env_var?: unknown } | null)?.api_key_env_var;
  const configuredKey = typeof envVar === "string" && envVar.trim() ? Deno.env.get(envVar) : null;
  const serviceEnv = STANDALONE_SERVICE_ENV[providerCode];
  return configuredKey || (serviceEnv ? Deno.env.get(serviceEnv) : null) || null;
}
