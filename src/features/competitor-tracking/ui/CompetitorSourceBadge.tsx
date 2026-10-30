import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The source of an observation.
 *
 * `official` is the platform's own API, `apify` is the third-party
 * fallback, `graph_own` is the owner's OWN account - a different
 * population that never appears in a competitor report - and `unknown`
 * is an observation whose source was not recorded.
 */
export type CompetitorSourceValue = "official" | "apify" | "graph_own" | "unknown";

export type CompetitorSourceBadgeProps = {
  source: CompetitorSourceValue | null | undefined;
  className?: string;
};

/**
 * The source badge.
 *
 * The badge states the source in words: a colour alone would not be an
 * answer for somebody who cannot distinguish the two colours, and the
 * source decides how much the owner may trust the number next to it.
 */
export function CompetitorSourceBadge({ source, className }: CompetitorSourceBadgeProps) {
  const { t } = useTranslation("analytics");

  const label =
    source === "official"
      ? t("competitors.source.official", "Official")
      : source === "apify"
        ? t("competitors.source.apify", "Third-party")
        : source === "graph_own"
          ? t("competitors.source.graphOwn", "Own account")
          : t("competitors.source.unknown", "Source unknown");

  return (
    <Badge variant="outline" className={cn("shrink-0 font-medium", className)}>
      {label}
    </Badge>
  );
}
