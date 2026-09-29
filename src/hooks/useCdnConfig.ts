import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CdnConfig, CdnProvider } from "@/lib/mediaUrl";

export type CdnStorageConfig = CdnConfig & {
  write_policy: { providers: CdnProvider[]; required: CdnProvider[] };
};

/**
 * Used when the `cdn_storage` setting is missing or unreadable. Openinary is the
 * primary provider, so it is what a failed read falls back to: defaulting to
 * Cloudinary meant a transient settings error silently reinstated a provider the
 * admin had turned off, against a cloud account that answers 401.
 */
export const DEFAULT_CDN_STORAGE_CONFIG: CdnStorageConfig = {
  write_policy: { providers: ["openinary"], required: ["openinary"] },
  read_preference: "openinary",
};

/**
 * cdn_storage is admin-only under RLS, so a non-admin's read returns no row.
 * Admins get the full stored value (the settings editor saves it back whole);
 * everyone else gets the non-secret subset from get_cdn_public_config.
 */
async function readCdnStorageValue(): Promise<unknown> {
  const { data, error } = await supabase.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
  if (error) throw error;
  if (data?.value) return data.value;
  const { data: publicConfig, error: rpcError } = await supabase.rpc("get_cdn_public_config");
  if (rpcError) throw rpcError;
  return publicConfig;
}

export function useCdnConfig() {
  return useQuery({
    queryKey: ["cdn-storage-config"],
    queryFn: async (): Promise<CdnStorageConfig> => {
      const stored = await readCdnStorageValue();
      if (!stored) return DEFAULT_CDN_STORAGE_CONFIG;
      let value: unknown;
      try { value = typeof stored === "string" ? JSON.parse(stored) : stored; } catch { return DEFAULT_CDN_STORAGE_CONFIG; }
      if (!value || typeof value !== "object") return DEFAULT_CDN_STORAGE_CONFIG;
      const candidate = value as Record<string, unknown>;
      const writePolicy = candidate.write_policy;
      if (!writePolicy || typeof writePolicy !== "object") return DEFAULT_CDN_STORAGE_CONFIG;
      const providers = (writePolicy as Record<string, unknown>).providers;
      const required = (writePolicy as Record<string, unknown>).required;
      if (!Array.isArray(providers) || !Array.isArray(required) || !providers.every((p) => p === "cloudinary" || p === "openinary") || !required.every((p) => p === "cloudinary" || p === "openinary")) return DEFAULT_CDN_STORAGE_CONFIG;
      return {
        ...DEFAULT_CDN_STORAGE_CONFIG,
        ...value,
        write_policy: { providers, required },
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
