import { Progress } from "@/components/ui/progress";
import { quotaPercent, quotaTone, type QuotaTone } from "@/features/partner-hub";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<QuotaTone, string> = {
  ok: "[&>div]:bg-primary",
  warning: "[&>div]:bg-amber-500",
  critical: "[&>div]:bg-destructive",
};

interface QuotaUsageBarProps {
  used: number;
  limit: number | null;
}

/** "used / limit" with a tone-coloured bar; unlimited quotas get a count only. */
export function QuotaUsageBar({ used, limit }: QuotaUsageBarProps) {
  const percent = quotaPercent(used, limit);
  if (percent === null) {
    return <span className="text-sm text-muted-foreground">{used} · unlimited</span>;
  }
  const tone = quotaTone(percent);
  return (
    <div className="min-w-[160px] space-y-1">
      <div className="flex justify-between text-xs">
        <span>{used} / {limit}</span>
        <span className={cn(tone === "critical" && "text-destructive", tone === "warning" && "text-amber-600")}>{percent}%</span>
      </div>
      <Progress data-testid="quota-bar" data-tone={tone} value={percent} className={cn("h-2", TONE_CLASS[tone])} />
    </div>
  );
}
