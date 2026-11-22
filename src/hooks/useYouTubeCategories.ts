import { useCallback, useEffect, useState } from "react";
import { SupabaseYouTubeResourcesGateway } from "@/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway";
import type { YouTubeCategoryOption } from "@/features/youtube-management/domain/types";
import { youtubeCategoryOptions as bundledOptions } from "@/lib/youtubeVideoCategories";

export interface YouTubeCategoryCatalogState {
  categories: YouTubeCategoryOption[];
  loading: boolean;
  unavailable: boolean;
  region: string;
  retry: () => void;
}

const gateway = new SupabaseYouTubeResourcesGateway();

/**
 * Shared catalog loader for both editors. A failed or denied read is a
 * visible retry state with the bundled list kept as a fallback; the current
 * selection is never replaced by a different category.
 */
export function useYouTubeCategories(
  locale: "en" | "ar",
  accountId?: string | null,
  region = "US",
): YouTubeCategoryCatalogState {
  const [categories, setCategories] = useState<YouTubeCategoryOption[]>(() =>
    bundledOptions(null, locale).map((option) => ({
      id: option.id,
      name: option.name,
      label: option.label,
      assignable: option.assignable,
    })),
  );
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!accountId) {
      setUnavailable(true);
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    gateway.getCategories({ accountId, region, locale })
      .then((result) => {
        if (!active) return;
        setCategories(result.data.categories);
        setUnavailable(false);
      })
      .catch(() => {
        if (!active) return;
        setUnavailable(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [locale, region, accountId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { categories, loading, unavailable, region, retry };
}
