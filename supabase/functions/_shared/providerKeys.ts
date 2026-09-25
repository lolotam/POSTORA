import { type RowReader, serviceClient } from "./providerEndpoint.ts";

/**
 * The platform key for a provider: the admin-saved provider_api_keys row first,
 * then the env var its ai_providers row names, else null. The one resolver for
 * data-driven providers, so no vendor ever receives another vendor's key.
 * A failed read throws: an unreadable key table is not a missing key.
 */
export async function resolveProviderKey(db: RowReader | undefined, providerCode: string): Promise<string | null> {
  const client = db ?? await serviceClient();
  const saved = await client.from("provider_api_keys").select("api_key").eq("provider_code", providerCode).maybeSingle();
  if (saved.error) throw new Error("Provider key read failed");
  const key = (saved.data as { api_key?: unknown } | null)?.api_key;
  if (typeof key === "string" && key.trim()) return key;

  const provider = await client.from("ai_providers").select("api_key_env_var").eq("provider_code", providerCode).maybeSingle();
  if (provider.error) throw new Error("AI provider read failed");
  const envVar = (provider.data as { api_key_env_var?: unknown } | null)?.api_key_env_var;
  if (typeof envVar !== "string" || !envVar.trim()) return null;
  return Deno.env.get(envVar) || null;
}
