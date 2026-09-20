import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw, Image, Film, GalleryHorizontal, Clapperboard } from "lucide-react";
import type { BrandScrapeFilters } from "@/types/brand-intelligence";

interface FilterToolbarProps {
  filters: BrandScrapeFilters;
  onChange: (filters: BrandScrapeFilters) => void;
  maxEngagement: number;
}

const DEFAULT_FILTERS: BrandScrapeFilters = {
  sortBy: "engagement",
  mediaType: "all",
  period: "all",
  minEngagement: 0,
};

export function FilterToolbar({ filters, onChange, maxEngagement }: FilterToolbarProps) {
  const { t } = useTranslation("analytics");
  const activeCount = [
    filters.sortBy !== "engagement",
    filters.mediaType !== "all",
    filters.period !== "all",
    filters.minEngagement > 0,
  ].filter(Boolean).length;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={filters.sortBy}
        onValueChange={(v) => onChange({ ...filters, sortBy: v as BrandScrapeFilters["sortBy"] })}
      >
        <SelectTrigger className="w-[160px] h-9 text-xs">
          <SelectValue placeholder={t("filters.sortBy", "Sort by")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="engagement">{t("filters.engagementScore", "🔥 Engagement Score")}</SelectItem>
          <SelectItem value="likes">{t("filters.mostLiked", "❤️ Most Liked")}</SelectItem>
          <SelectItem value="comments">{t("filters.mostCommented", "💬 Most Commented")}</SelectItem>
          <SelectItem value="views">{t("filters.mostViewed", "▶️ Most Viewed")}</SelectItem>
          <SelectItem value="shares">{t("filters.mostShared", "🔄 Most Shared")}</SelectItem>
          <SelectItem value="saves">{t("filters.mostSaved", "🔖 Most Saved")}</SelectItem>
          <SelectItem value="newest">{t("filters.newest", "🆕 Newest")}</SelectItem>
          <SelectItem value="oldest">{t("filters.oldest", "📅 Oldest")}</SelectItem>
        </SelectContent>
      </Select>

      <ToggleGroup
        type="single"
        value={filters.mediaType}
        onValueChange={(v) => v && onChange({ ...filters, mediaType: v as BrandScrapeFilters["mediaType"] })}
        className="gap-0.5"
      >
        <ToggleGroupItem value="all" className="text-xs h-9 px-3">{t("common:all", "All")}</ToggleGroupItem>
        <ToggleGroupItem value="image" className="text-xs h-9 px-3 gap-1">
          <Image className="w-3 h-3" /> {t("filters.image", "Image")}
        </ToggleGroupItem>
        <ToggleGroupItem value="video" className="text-xs h-9 px-3 gap-1">
          <Film className="w-3 h-3" /> {t("filters.video", "Video")}
        </ToggleGroupItem>
      </ToggleGroup>

      <Select
        value={filters.period}
        onValueChange={(v) => onChange({ ...filters, period: v as BrandScrapeFilters["period"] })}
      >
        <SelectTrigger className="w-[130px] h-9 text-xs">
          <SelectValue placeholder={t("filters.period", "Period")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="30d">{t("filters.last30", "Last 30 days")}</SelectItem>
          <SelectItem value="3m">{t("filters.threeMonths", "3 months")}</SelectItem>
          <SelectItem value="6m">{t("filters.sixMonths", "6 months")}</SelectItem>
          <SelectItem value="1y">{t("filters.oneYear", "1 year")}</SelectItem>
          <SelectItem value="all">{t("filters.allTime", "All time")}</SelectItem>
        </SelectContent>
      </Select>

      <div className="hidden md:flex items-center gap-2 min-w-[180px]">
        <span className="text-xs text-muted-foreground whitespace-nowrap">{t("filters.minFire", "Min 🔥")}</span>
        <Slider
          value={[filters.minEngagement]}
          onValueChange={([v]) => onChange({ ...filters, minEngagement: v })}
          max={maxEngagement || 100000}
          step={100}
          className="flex-1"
        />
        <span className="text-xs font-mono w-12 text-right">
          {filters.minEngagement > 0 ? filters.minEngagement.toLocaleString() : "0"}
        </span>
      </div>

      {activeCount > 0 && (
        <>
          <Badge variant="secondary" className="text-xs">
            {t("filters.activeCount", "{{count}} filters active", { count: activeCount })}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs gap-1"
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            <RotateCcw className="w-3 h-3" /> {t("actions.reset", "Reset")}
          </Button>
        </>
      )}
    </div>
  );
}
