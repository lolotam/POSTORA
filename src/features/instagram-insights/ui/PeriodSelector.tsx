import { Button } from "@/components/ui/button";
import { OWNER_REPORT_PERIOD_DAYS, type OwnerReportPeriodDays } from "../domain/types";

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
  return (
    <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border/60">
      {OWNER_REPORT_PERIOD_DAYS.map((days) => {
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
            {days}d
          </Button>
        );
      })}
    </div>
  );
}
