import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Filter, Loader2, Plus, Users, AlertCircle, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { SortableAccountItem } from "./SortableAccountItem";
import { platformWarnings } from "@/lib/platformConstants";
import { PlatformEligibility } from "@/lib/platformEligibility";
import { MediaAnalysis } from "@/lib/mediaAnalyzer";
import { Icon3D, GradientRingCard } from "@/components/fx";

interface AccountItem {
  id: string;
  platform: Platform;
  maxChars: number;
  username: string | null;
  avatarUrl: string | null;
  tokenExpired?: boolean;
}

interface AccountSelectionSidebarProps {
  availableAccounts: AccountItem[];
  accountsByPlatform: Record<string, AccountItem[]>;
  filteredAccountsForUploadMethod: Record<string, AccountItem[]>;
  allPlatforms: Platform[];
  selectedAccountIds: string[];
  selectedPlatforms: Platform[];
  platformFilter: Platform[];
  caption: string;
  hasOnlyImages: boolean;
  accountsLoading: boolean;
  onAccountToggle: (accountId: string, platform: Platform) => void;
  onSelectAllPlatform: (platform: Platform) => void;
  onPlatformFilterToggle: (platform: Platform) => void;
  onClearFilter: () => void;
  // NEW: Media eligibility props
  platformEligibility?: PlatformEligibility[];
  mediaAnalysis?: MediaAnalysis;
}

export function AccountSelectionSidebar({
  availableAccounts,
  accountsByPlatform,
  filteredAccountsForUploadMethod,
  allPlatforms,
  selectedAccountIds,
  selectedPlatforms,
  platformFilter,
  caption,
  hasOnlyImages,
  accountsLoading,
  onAccountToggle,
  onSelectAllPlatform,
  onPlatformFilterToggle,
  onClearFilter,
  platformEligibility = [],
  mediaAnalysis,
}: AccountSelectionSidebarProps) {
  const { t } = useTranslation("post");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent, platform: Platform) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const platformAccounts = accountsByPlatform[platform] || [];
      const oldIndex = platformAccounts.findIndex(acc => acc.id === active.id);
      const newIndex = platformAccounts.findIndex(acc => acc.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        arrayMove(platformAccounts, oldIndex, newIndex);
      }
    }
  };

  // Get ineligible platforms from the eligibility list
  const ineligiblePlatforms = platformEligibility.filter(e => !e.isEligible);
  
  // Get platforms with warnings
  const platformsWithWarnings = platformEligibility.filter(e => e.isEligible && e.warningReason);

  return (
    <GradientRingCard variant="emerald" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-4 sm:p-5">
      <div className="flex items-center justify-between mb-4 group">
        <div className="flex items-center gap-3">
          <Icon3D icon={Users} variant="emerald" size="sm" />
          <Label className="text-base font-semibold leading-tight text-foreground">
            {t("accountSidebar.visibility", "Post visibility")}
          </Label>
        </div>
        {allPlatforms.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-2 bg-card border-border/40 hover:border-emerald-400/60 hover:bg-card transition-all">
                <Filter className="w-3.5 h-3.5" />
                {platformFilter.length === 0
                  ? t("accountSidebar.allPlatforms", "All platforms")
                  : t("accountSidebar.platformsCount", "{{count}} platform(s)", { count: platformFilter.length })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>{t("accountSidebar.filterByPlatform", "Filter by platform")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allPlatforms.map(platform => (
                <DropdownMenuCheckboxItem
                  key={platform}
                  checked={platformFilter.includes(platform)}
                  onCheckedChange={() => onPlatformFilterToggle(platform)}
                >
                  <PlatformIcon platform={platform} size="sm" className="me-2" />
                  {getPlatformName(platform)}
                </DropdownMenuCheckboxItem>
              ))}
              {platformFilter.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={false} onCheckedChange={onClearFilter}>
                    {t("accountSidebar.clearFilter", "Clear filter")}
                  </DropdownMenuCheckboxItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {accountsLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
        </div>
      ) : availableAccounts.length === 0 ? (
        <div className="text-center py-8 px-4 group">
          <div className="inline-flex flex-col items-center gap-3">
            <Icon3D icon={Users} variant="emerald" size="md" />
            <h4 className="font-semibold text-sm text-foreground">
              {t("accountSidebar.noAccountsTitle", "No social accounts connected")}
            </h4>
            <p className="text-xs text-muted-foreground max-w-xs">{t("accountSidebar.noAccountsDesc", "Connect your social media accounts to start publishing.")}</p>
            <Button size="sm" asChild className="text-primary-foreground transition-all bg-primary">
              <a href="/profiles">
                <Plus className="w-4 h-4 me-2" />
                {t("accountSidebar.connectAccounts", "Connect Accounts")}
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(filteredAccountsForUploadMethod).map(([platform, accounts]) => {
            const platformAccountIds = accounts.map(acc => acc.id);
            const allSelected = platformAccountIds.every(id => selectedAccountIds.includes(id));
            const warningInfo = platformsWithWarnings.find(p => p.platform === platform);

            return (
              <div key={platform} className="space-y-2 rounded-xl border border-border/40 bg-card p-3 transition-all hover:border-emerald-400/40 hover:bg-card">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={platform as Platform} size="sm" />
                    <span className="text-sm font-medium">{getPlatformName(platform as Platform)}</span>
                    <span className="text-xs text-muted-foreground">({accounts.length})</span>
                    {warningInfo?.warningReason && (
                      <Badge className="text-xs bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-400/40">
                        {warningInfo.warningReason}
                      </Badge>
                    )}
                  </div>
                  {accounts.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300"
                      onClick={() => onSelectAllPlatform(platform as Platform)}
                    >
                      {allSelected ? t("accountSidebar.deselectAll", "Deselect All") : t("accountSidebar.selectAll", "Select All")}
                    </Button>
                  )}
                </div>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(e, platform as Platform)}>
                  <SortableContext items={accounts.map(acc => acc.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1.5 ps-1">
                      {accounts.map(({ id, platform: accPlatform, maxChars, username, avatarUrl, tokenExpired }) => (
                        <SortableAccountItem
                          key={id}
                          id={id}
                          platform={accPlatform}
                          username={username}
                          avatarUrl={avatarUrl}
                          maxChars={maxChars}
                          isSelected={selectedAccountIds.includes(id)}
                          isOverLimit={caption.length > maxChars}
                          isTokenExpired={!!tokenExpired}
                          onToggle={() => {
                            if (tokenExpired) return; // prevent selection
                            onAccountToggle(id, accPlatform);
                          }}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            );
          })}

          {/* Ineligible platforms section */}
          {ineligiblePlatforms.length > 0 && mediaAnalysis && !mediaAnalysis.isTextOnly && (
            <div className="pt-3 border-t border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <Icon3D icon={Ban} variant="amber" size="sm" className="!h-7 !w-7" />
                <p className="text-xs font-medium text-foreground">
                  {t("accountSidebar.unavailableMedia", "Unavailable for current media")}
                </p>
              </div>
              <div className="space-y-1.5">
                {ineligiblePlatforms.map(({ platform, reason }) => {
                  const accounts = accountsByPlatform[platform] || [];
                  if (accounts.length === 0) return null;
                  return (
                    <div key={platform} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-muted/30 opacity-70">
                      <PlatformIcon platform={platform} size="sm" />
                      <span className="text-xs">{getPlatformName(platform)}</span>
                      <Badge variant="outline" className="text-xs ms-auto">
                        {reason}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {selectedAccountIds.length === 0 && availableAccounts.length > 0 && (
        <div className="mt-4">
          <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-3">
            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300 text-sm font-medium">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {t("accountSidebar.selectAtLeastOne", "Select at least one account")}
            </div>
          </GradientRingCard>
        </div>
      )}

      {/* Platform warnings */}
      {selectedPlatforms.map((platform) => {
        const warning = platformWarnings[platform];
        if (!warning) return null;
        return (
          <div key={platform} className="mt-4">
            <GradientRingCard variant="amber" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-3">
              <div className="flex items-start gap-2 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0 text-amber-500 mt-0.5" />
                <div>
                  <p className="font-semibold text-foreground">{warning.title}</p>
                  <p className="text-muted-foreground text-xs mt-1">{warning.message}</p>
                </div>
              </div>
            </GradientRingCard>
          </div>
        );
      })}
    </GradientRingCard>
  );
}
