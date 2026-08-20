import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CdnConfig, CdnProvider } from "@/lib/cdn";

export type CdnStorageConfig = CdnConfig & {
  write_policy: { providers: CdnProvider[]; required: CdnProvider[] };
};

export const DEFAULT_CDN_STORAGE_CONFIG: CdnStorageConfig = {
  write_policy: { providers: ["cloudinary"], required: ["cloudinary"] },
  read_preference: "cloudinary",
};

export function useCdnConfig() {
  return useQuery({
    queryKey: ["cdn-storage-config"],
    queryFn: async (): Promise<CdnStorageConfig> => {
      const { data, error } = await supabase.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
      if (error) throw error;
      if (!data?.value) return DEFAULT_CDN_STORAGE_CONFIG;
      let value: unknown;
      try { value = typeof data.value === "string" ? JSON.parse(data.value) : data.value; } catch { return DEFAULT_CDN_STORAGE_CONFIG; }
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
