import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sparkles, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface RateLimitIndicatorProps {
  limitPerHour: number;
  limitPerDay: number;
  remainingHour: number;
  remainingDay: number;
  resetTimeHour?: Date | null;
  resetTimeDay?: Date | null;
  label: string;
  compact?: boolean;
  className?: string;
}

export function RateLimitIndicator({
  limitPerHour,
  limitPerDay,
  remainingHour,
  remainingDay,
  resetTimeHour,
  resetTimeDay,
  label,
  compact = false,
  className,
}: RateLimitIndicatorProps) {
  const { t } = useTranslation("postpreview");

  if (limitPerHour === 0 && limitPerDay === 0) return null;

  // Use hourly as primary display, but show daily if hourly is depleted
  const isHourlyLimited = remainingHour === 0 && limitPerHour > 0;
  const isDailyLimited = remainingDay === 0 && limitPerDay > 0;
  const isEmpty = isHourlyLimited || isDailyLimited;
  
  // Calculate percentage based on the more restrictive limit
  const hourlyPercentage = limitPerHour > 0 ? ((limitPerHour - remainingHour) / limitPerHour) * 100 : 0;
  const dailyPercentage = limitPerDay > 0 ? ((limitPerDay - remainingDay) / limitPerDay) * 100 : 0;
  const usedPercentage = Math.max(hourlyPercentage, dailyPercentage);
  
  const isLow = remainingHour <= Math.ceil(limitPerHour * 0.2) || remainingDay <= Math.ceil(limitPerDay * 0.2);

  const getTimeUntilReset = (type: "hour" | "day") => {
    const resetTime = type === "hour" ? resetTimeHour : resetTimeDay;
    if (!resetTime) {
      return type === "hour" ? t("rateLimit.resetsEveryHour", "Resets every hour") : t("rateLimit.resetsDaily", "Resets daily");
    }
    const now = new Date();
    const diff = resetTime.getTime() - now.getTime();
    if (diff <= 0) return t("rateLimit.resettingSoon", "Resetting soon...");
    
    const minutes = Math.ceil(diff / (1000 * 60));
    if (minutes < 60) return t("rateLimit.resetsInMinutes", { count: minutes, defaultValue: `Resets in ${minutes}m` });
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return t("rateLimit.resetsInHours", { count: hours, defaultValue: `Resets in ${hours}h` });
    return t("rateLimit.resetsInDays", { count: Math.ceil(hours / 24), defaultValue: `Resets in ${Math.ceil(hours / 24)}d` });
  };

  if (compact) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium transition-colors",
                isEmpty
                  ? "bg-destructive/10 text-destructive"
                  : isLow
                    ? "bg-warning/10 text-warning"
                    : "bg-primary/10 text-primary",
                className
              )}
            >
              {isEmpty ? (
                <AlertTriangle className="w-3 h-3" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              <span>{remainingHour}/{limitPerHour}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1.5">
              <p className="font-medium">{label}</p>
              {limitPerHour > 0 && (
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">{t("rateLimit.hourly", "Hourly:")}</span>
                  <span className={cn(isHourlyLimited && "text-destructive")}>
                    {remainingHour}/{limitPerHour}
                  </span>
                </div>
              )}
              {limitPerDay > 0 && (
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">{t("rateLimit.daily", "Daily:")}</span>
                  <span className={cn(isDailyLimited && "text-destructive")}>
                    {remainingDay}/{limitPerDay}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3 h-3" />
                {getTimeUntilReset("hour")}
              </div>
              {isEmpty && (
                <p className="text-xs text-destructive">
                  {isHourlyLimited 
                    ? t("rateLimit.hourlyLimitReached", "Hourly limit reached. Please wait for it to reset.")
                    : t("rateLimit.dailyLimitReached", "Daily limit reached. Please wait until tomorrow.")}
                </p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          {isEmpty ? (
            <AlertTriangle className="w-4 h-4 text-destructive" />
          ) : isLow ? (
            <AlertTriangle className="w-4 h-4 text-warning" />
          ) : (
            <Sparkles className="w-4 h-4 text-primary" />
          )}
          <span className="font-medium">{label}</span>
        </div>
        <div className="text-xs font-medium space-x-2 rtl:space-x-reverse">
          {limitPerHour > 0 && (
            <span className={cn(isHourlyLimited ? "text-destructive" : "text-muted-foreground")}>
              {t("rateLimit.perHour", { remaining: remainingHour, limit: limitPerHour, defaultValue: `${remainingHour}/${limitPerHour}/hr` })}
            </span>
          )}
          {limitPerDay > 0 && (
            <span className={cn(isDailyLimited ? "text-destructive" : "text-muted-foreground")}>
              {t("rateLimit.perDay", { remaining: remainingDay, limit: limitPerDay, defaultValue: `${remainingDay}/${limitPerDay}/day` })}
            </span>
          )}
        </div>
      </div>
      <Progress
        value={usedPercentage}
        className={cn(
          "h-2",
          isEmpty ? "[&>div]:bg-destructive" : isLow ? "[&>div]:bg-warning" : ""
        )}
      />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="w-3 h-3" />
        {getTimeUntilReset("hour")}
      </div>
      {isEmpty && (
        <p className="text-xs text-destructive bg-destructive/10 px-2 py-1 rounded">
          {isHourlyLimited 
            ? t("rateLimit.hourlyLimitReached", "Hourly limit reached. Please wait for it to reset.")
            : t("rateLimit.dailyLimitReached", "Daily limit reached. Please wait until tomorrow.")}
        </p>
      )}
    </div>
  );
}