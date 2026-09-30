import { useQuery } from "@tanstack/react-query";
import { fetchCdnStorageConfig } from "@/lib/cdnConfig";

export { DEFAULT_CDN_STORAGE_CONFIG } from "@/lib/cdnConfig";
export type { CdnStorageConfig } from "@/lib/cdnConfig";

export function useCdnConfig() {
  return useQuery({
    queryKey: ["cdn-storage-config"],
    queryFn: fetchCdnStorageConfig,
    staleTime: 5 * 60 * 1000,
  });
}
