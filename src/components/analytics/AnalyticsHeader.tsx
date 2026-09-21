import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "lucide-react";
import { GradientHeading } from "@/components/fx";

interface AnalyticsHeaderProps {
  timeRange: string;
  onTimeRangeChange: (value: string) => void;
}

export function AnalyticsHeader({ timeRange, onTimeRangeChange }: AnalyticsHeaderProps) {
  const { t } = useTranslation("analytics");

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <GradientHeading as="h1" preset="emerald-cyan-sky" size="lg">{t("header.analytics", "Analytics")}</GradientHeading>
        <p className="text-muted-foreground mt-1">
          {t("header.analyticsSubtitle", "Track your post performance across all platforms")}
        </p>
      </div>

      <Select value={timeRange} onValueChange={onTimeRangeChange}>
        <SelectTrigger className="w-[180px]">
          <Calendar className="w-4 h-4 me-2" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7">{t("header.date7", "Last 7 days")}</SelectItem>
          <SelectItem value="14">{t("header.date14", "Last 14 days")}</SelectItem>
          <SelectItem value="30">{t("header.date30", "Last 30 days")}</SelectItem>
          <SelectItem value="90">{t("header.date90", "Last 90 days")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
