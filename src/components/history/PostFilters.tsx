import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import {
  Search,
  Filter,
  MousePointer,
  Zap,
  CheckCircle2,
  Clock,
  XCircle,
  ListFilter,
} from "lucide-react";
import { GradientRingCard, Icon3D } from "@/components/fx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

const ALL_PLATFORMS: Platform[] = ["instagram", "facebook", "tiktok", "twitter", "linkedin", "pinterest"];
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

interface PostFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  selectedFilter: "all" | "completed" | "failed" | "pending";
  onFilterChange: (filter: "all" | "completed" | "failed" | "pending") => void;
  sourceFilter: "all" | "manual" | "api";
  onSourceFilterChange: (filter: "all" | "manual" | "api") => void;
  platformFilter: Platform | "all";
  onPlatformFilterChange: (platform: Platform | "all") => void;
  itemsPerPage: number;
  onItemsPerPageChange: (count: number) => void;
}

export function PostFilters({
  search,
  onSearchChange,
  selectedFilter,
  onFilterChange,
  sourceFilter,
  onSourceFilterChange,
  platformFilter,
  onPlatformFilterChange,
  itemsPerPage,
  onItemsPerPageChange,
}: PostFiltersProps) {
  const { t } = useTranslation("history");

  const statusOptions = [
    { value: "all" as const, icon: ListFilter, label: t("filters.allStatuses", "All statuses") },
    { value: "completed" as const, icon: CheckCircle2, label: t("common:status.completed", "Completed") },
    { value: "pending" as const, icon: Clock, label: t("common:status.pending", "Pending") },
    { value: "failed" as const, icon: XCircle, label: t("common:status.failed", "Failed") },
  ];

  const activeStatus = statusOptions.find((s) => s.value === selectedFilter) ?? statusOptions[0];
  const StatusIcon = activeStatus.icon;

  const sourceOptions = [
    { value: "all" as const, label: t("common:all", "All"), icon: null },
    { value: "manual" as const, label: t("source.manual", "Manual"), icon: MousePointer },
    { value: "api" as const, label: "API", icon: Zap },
  ];

  return (
    <GradientRingCard variant="cyan" padded={false} innerClassName="p-4">
      <div className="flex flex-col gap-3" data-testid="post-filters">
      {/* Search bar */}
      <div className="flex items-center gap-3">
        <Icon3D icon={Search} variant="cyan" size="sm" />
        <div className="relative w-full">
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("filters.searchPlaceholder", "Search posts...")}
            className="h-10 rounded-xl bg-card/50 border-border/60 focus-visible:ring-2 focus-visible:ring-primary/30"
            data-testid="search-input"
          />
        </div>
      </div>

      {/* Unified filter toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-2 rounded-xl border border-border/60 bg-card/40 backdrop-blur-sm">
        {/* Status filter (consolidated) */}
        <Select value={selectedFilter} onValueChange={(v) => onFilterChange(v as typeof selectedFilter)}>
          <SelectTrigger
            className="h-9 w-auto min-w-[160px] gap-2 rounded-lg border-border/60 bg-background/60"
            data-testid="filter-status-trigger"
          >
            <StatusIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map(({ value, label, icon: Icon }) => (
              <SelectItem key={value} value={value} data-testid={`filter-status-${value}`}>
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="h-6 w-px bg-border/60 mx-1 hidden sm:block" />

        {/* Source segmented control */}
        <div
          className="inline-flex items-center rounded-lg bg-muted/50 p-0.5 gap-0.5"
          data-testid="source-filters"
        >
          {sourceOptions.map(({ value, label, icon: Icon }) => {
            const isActive = sourceFilter === value;
            return (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                onClick={() => onSourceFilterChange(value)}
                noAnimation
                className={`h-8 px-3 rounded-md gap-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-transparent"
                }`}
                data-testid={`filter-source-${value}`}
              >
                {Icon && <Icon className="w-3 h-3" />}
                {label}
              </Button>
            );
          })}
        </div>

        <div className="h-6 w-px bg-border/60 mx-1 hidden sm:block" />

        {/* Platform filter */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-lg border-border/60 bg-background/60"
              data-testid="platform-filter-trigger"
            >
              {platformFilter === "all" ? (
                <>
                  <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                  {t("filters.allPlatforms", "All Platforms")}
                </>
              ) : (
                <>
                  <PlatformIcon platform={platformFilter} size="sm" />
                  {getPlatformName(platformFilter)}
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="platform-filter-content">
            <DropdownMenuLabel>{t("filters.filterByPlatform", "Filter by platform")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onPlatformFilterChange("all")} data-testid="filter-platform-all">
              {t("filters.allPlatforms", "All Platforms")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {ALL_PLATFORMS.map((platform) => (
              <DropdownMenuItem
                key={platform}
                onClick={() => onPlatformFilterChange(platform)}
                className="gap-2"
                data-testid={`filter-platform-${platform}`}
              >
                <PlatformIcon platform={platform} size="sm" />
                {getPlatformName(platform)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Items per page */}
        <div className="flex items-center gap-2 ms-auto" data-testid="items-per-page">
          <span className="text-xs text-muted-foreground hidden sm:inline">{t("filters.show", "Show")}</span>
          <Select
            value={itemsPerPage.toString()}
            onValueChange={(value) => onItemsPerPageChange(Number(value))}
          >
            <SelectTrigger
              className="w-[78px] h-9 rounded-lg border-border/60 bg-background/60"
              data-testid="items-per-page-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="items-per-page-content">
              {ITEMS_PER_PAGE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option.toString()} data-testid={`items-per-page-${option}`}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      </div>
    </GradientRingCard>
  );
}
