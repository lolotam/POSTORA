import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { OwnerReportPeriodDays } from "../domain/types";

/** The periods the screen offers; the report also serves 7 and 14 days. */
const SELECTABLE_PERIODS: readonly OwnerReportPeriodDays[] = [1, 30, 90, 365, "all"];

export type PeriodSelectorProps = {
  selectedPeriod: OwnerReportPeriodDays;
  onSelectPeriod: (period: OwnerReportPeriodDays) => void;
  disabled?: boolean;
};

export function PeriodSelector({
  selectedPeriod,
  onSelectPeriod,
  disabled = false,
}: PeriodSelectorProps) {
  const { t } = useTranslation("analytics");
  const label = (period: OwnerReportPeriodDays) => period === "all"
    ? t("instagram.periodAllTime", "All time")
    : `${period}${t("instagram.periodDaysUnit", "d")}`;
  return (
    <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border/60">
      {SELECTABLE_PERIODS.map((days) => {
        const isActive = selectedPeriod === days;
        return (
          <Button
            key={days}
            type="button"
            size="sm"
            variant={isActive ? "secondary" : "ghost"}
            disabled={disabled}
            onClick={() => onSelectPeriod(days)}
            className={`h-7 px-2.5 text-xs font-medium rounded-md transition-all ${
              isActive
                ? "bg-background text-foreground shadow-xs font-semibold"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label(days)}
          </Button>
        );
      })}
    </div>
  );
}
