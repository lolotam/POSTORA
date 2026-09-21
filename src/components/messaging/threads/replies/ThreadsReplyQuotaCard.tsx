import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useReplyQuota } from "@/hooks/useThreadsReplies";

interface Props {
  accountId: string | null;
}

export function ThreadsReplyQuotaCard({ accountId }: Props) {
  const { t } = useTranslation("threads");
  const { data, isLoading, error } = useReplyQuota(accountId);

  const durationLabel = (() => {
    const seconds = data?.reply_config?.quota_duration;
    if (!seconds) return t("quota.rollingWindow", "rolling window");
    const h = Math.round(seconds / 3600);
    if (h >= 24) return t("quota.dayWindow", "{{count}} day window", { count: Math.round(h / 24) });
    return t("quota.hourWindow", "{{count}}h window", { count: h });
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" />
          {t("quota.title", "Reply Quota")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2 w-full" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            <span>{t("errors.quotaUnavailable", "Quota unavailable for this account.")}</span>
          </div>
        )}

        {!isLoading && !error && data && (() => {
          const used = data.reply_quota_usage ?? 0;
          const total = data.reply_config?.quota_total ?? 1000;
          const pct = Math.min(100, Math.round((used / total) * 100));
          return (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium">
                  {t("quota.usedOfTotal", "{{used}} / {{total}} replies", {
                    used: used.toLocaleString(),
                    total: total.toLocaleString(),
                  })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {durationLabel}
                </span>
              </div>
              <Progress value={pct} />
              <p className="text-xs text-muted-foreground">{t("quota.pctUsed", "{{pct}}% used", { pct })}</p>
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}