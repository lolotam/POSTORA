import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { CompetitorReportOutlier } from "../domain/contracts";
import { formatOutlierScore } from "../domain/formatters";

export type CompetitorOutlierLabelProps = {
  outlier: CompetitorReportOutlier;
  className?: string;
};

/**
 * The outlier verdict of one media item.
 *
 * The verdict is the SERVER's: this component never scores anything.
 * A neutral verdict ("too early", "not enough earlier posts", "data
 * unavailable") is a reason, not a zero score, and it is never given a
 * success or a failure colour - the words carry the meaning (spec §3).
 */
export function CompetitorOutlierLabel({ outlier, className }: CompetitorOutlierLabelProps) {
  const { t } = useTranslation("analytics");

  const label = useMemo(() => {
    switch (outlier.label) {
      case "outlier":
        return t("competitors.outlier.outlier", "Outlier");
      case "above":
        return t("competitors.outlier.above", "Above usual");
      case "normal":
        return t("competitors.outlier.normal", "Normal");
      case "below":
        return t("competitors.outlier.below", "Below usual");
      case "too_early":
        return t("competitors.outlier.tooEarly", "Too early");
      case "small_baseline":
        return t("competitors.outlier.smallBaseline", "Not enough earlier posts");
      case "no_data":
      default:
        return t("competitors.outlier.noData", "Data unavailable");
    }
  }, [outlier.label, t]);

  const score = formatOutlierScore(outlier.score);

  const basis = useMemo(() => {
    if (outlier.metric_basis === null) return null;
    const basisText =
      outlier.metric_basis === "public_views"
        ? t("competitors.outlier.publicViews", "public views")
        : t("competitors.outlier.publicInteractions", "public interactions");
    return t("competitors.outlier.metricBasis", "Metric basis: {{basis}}", { basis: basisText });
  }, [outlier.metric_basis, t]);

  return (
    <span className={cn("flex flex-col gap-0.5 text-xs", className)}>
      <span className="font-medium text-foreground">{label}</span>
      {outlier.score !== null && (
        <span className="text-muted-foreground">{score}</span>
      )}
      {basis !== null && <span className="text-muted-foreground">{basis}</span>}
    </span>
  );
}
