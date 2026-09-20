import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Platform } from "@/lib/types";
import { SchedulePicker } from "./SchedulePicker";
import { BestTimeSuggestions } from "./BestTimeSuggestions";
import { TimezoneSelector } from "./TimezoneSelector";
import { Icon3D, GradientRingCard, GradientDivider } from "@/components/fx";

interface SchedulingSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  scheduleEnabled: boolean;
  setScheduleEnabled: (enabled: boolean) => void;
  scheduledAt: Date | null;
  setScheduledAt: (date: Date | null) => void;
  scheduleTimezone: string;
  setScheduleTimezone: (tz: string) => void;
  selectedPlatforms: Platform[];
}

export function SchedulingSection({
  isOpen,
  onOpenChange,
  scheduleEnabled,
  setScheduleEnabled,
  scheduledAt,
  setScheduledAt,
  scheduleTimezone,
  setScheduleTimezone,
  selectedPlatforms,
}: SchedulingSectionProps) {
  const { t } = useTranslation("post");

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <GradientRingCard variant="amber" hoverLift={false} ringIntensity="subtle" padded={false}>
        <CollapsibleTrigger className="w-full p-4 sm:p-6 flex items-center justify-between group">
          <div className="flex items-center gap-3">
            <Icon3D icon={Clock} variant="amber" size="sm" />
            <div className="text-left">
              <h3 className="font-semibold leading-tight bg-clip-text text-transparent bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500">
                {t("scheduling.title", "Scheduling & auto-poster")}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("scheduling.subtitle", "Schedule posts to publish at specific times")}
              </p>
            </div>
          </div>
          <ChevronDown className={cn("w-5 h-5 text-amber-500 transition-transform", isOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
            <GradientDivider tone="rose" />
            <div className="flex items-center gap-3">
              <Checkbox
                id="schedule"
                checked={scheduleEnabled}
                onCheckedChange={(checked) => setScheduleEnabled(!!checked)}
              />
              <label htmlFor="schedule" className="text-sm cursor-pointer">
                {t("scheduling.enable", "Enable scheduled posting")}
              </label>
            </div>

            {scheduleEnabled && (
              <>
                <SchedulePicker scheduledAt={scheduledAt} onScheduleChange={setScheduledAt} />
                {selectedPlatforms.length > 0 && (
                  <BestTimeSuggestions
                    selectedPlatforms={selectedPlatforms}
                    onSelectTime={(date) => setScheduledAt(date)}
                  />
                )}
                <TimezoneSelector
                  value={scheduleTimezone}
                  onChange={setScheduleTimezone}
                  scheduledAt={scheduledAt}
                />
              </>
            )}
          </div>
        </CollapsibleContent>
      </GradientRingCard>
    </Collapsible>
  );
}
