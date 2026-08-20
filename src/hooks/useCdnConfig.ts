import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CdnConfig, CdnProvider } from "@/lib/cdn";

export interface CdnStorageConfig extends CdnConfig {
  write_policy: { providers: CdnProvider[]; required: CdnProvider[] };
}

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
      const value = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
      return {
        ...DEFAULT_CDN_STORAGE_CONFIG,
        ...value,
        write_policy: { ...DEFAULT_CDN_STORAGE_CONFIG.write_policy, ...(value.write_policy ?? {}) },
      };
    },
    staleTime: 5 * 60 * 1000,
  });
}
