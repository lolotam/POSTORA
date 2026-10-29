import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from "@/lib/mediaTypes";
import { fetchUploadLimits, saveUploadLimits } from "../infrastructure/uploadLimitsRepository";

export const MEDIA_UPLOAD_LIMITS_QUERY_KEY = ["media-upload-limits"] as const;

/**
 * The limits the admin chose. Until they load, or if they cannot be read, the
 * defaults apply; the server enforces the real values either way.
 */
export function useMediaUploadLimits(): UploadLimits {
  const { data } = useQuery({
    queryKey: MEDIA_UPLOAD_LIMITS_QUERY_KEY,
    queryFn: fetchUploadLimits,
    staleTime: 5 * 60 * 1000,
  });
  return data ?? DEFAULT_UPLOAD_LIMITS;
}

export function useSaveMediaUploadLimits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveUploadLimits,
    onSuccess: (_result, limits) => queryClient.setQueryData(MEDIA_UPLOAD_LIMITS_QUERY_KEY, limits),
  });
}
