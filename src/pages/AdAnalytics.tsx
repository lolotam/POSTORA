import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate } from "react-router-dom";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useAdAccounts, useCampaigns, useAccountInsights } from "@/hooks/useAdAnalytics";
import { AdInsightsChart } from "@/components/ads/AdInsightsChart";
import { CampaignTable } from "@/components/ads/CampaignTable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { BarChart3, Loader2, TrendingUp, Eye, MousePointerClick, DollarSign } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";

const DATE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_14d", label: "Last 14 days" },
  { value: "last_30d", label: "Last 30 days" },
  { value: "last_90d", label: "Last 90 days" },
];

export default function AdAnalytics() {
  const { t } = useTranslation("analytics");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedAdAccountId, setSelectedAdAccountId] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState("last_30d");

  const { data: socialAccounts = [] } = useSocialAccounts();
  const fbAccounts = useMemo(
    () => socialAccounts.filter((a) => a.platform === "facebook" && a.is_active),
    [socialAccounts]
  );

  const activeAccountId = selectedAccountId || fbAccounts[0]?.id || null;
  const { data: adAccounts = [], isLoading: adAccountsLoading } = useAdAccounts(activeAccountId);
  const activeAdAccountId = selectedAdAccountId || adAccounts[0]?.id || null;
  const { data: campaigns = [], isLoading: campaignsLoading } = useCampaigns(activeAccountId, activeAdAccountId, datePreset);
  const { data: insights = [], isLoading: insightsLoading } = useAccountInsights(activeAccountId, activeAdAccountId, datePreset);

  // Summary metrics. This must stay ABOVE the feature-flag redirect below: hooks
  // run in call order, so a hook placed after an early return is skipped whenever
  // that branch is taken, and React throws "rendered fewer hooks than expected"
  // the moment the flag flips.
  const totals = useMemo(() => {
    return insights.reduce(
      (acc, d) => ({
        spend: acc.spend + parseFloat(d.spend || "0"),
        impressions: acc.impressions + parseFloat(d.impressions || "0"),
        clicks: acc.clicks + parseFloat(d.clicks || "0"),
        reach: acc.reach + parseFloat(d.reach || "0"),
      }),
      { spend: 0, impressions: 0, clicks: 0, reach: 0 }
    );
  }, [insights]);

  if (!flagsLoading && !flags.adAnalytics) {
    return <Navigate to="/dashboard" replace />;
  }

  const isLoading = adAccountsLoading || campaignsLoading || insightsLoading;

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        {/* Header */}
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={BarChart3} variant="sky" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="sky-violet" size="lg" as="h1">{t("ads.title", "Ad Analytics")}</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">{t("ads.subtitle", "Facebook & Instagram ad performance")}</p>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="sky" />

        {/* Controls */}
        <Reveal delay={80}>
        <GradientRingCard variant="sky" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {fbAccounts.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("ads.facebookAccount", "Facebook Account")}</span>
              <Select value={activeAccountId || ""} onValueChange={setSelectedAccountId}>
                <SelectTrigger className="w-[200px] h-9">
                  <SelectValue placeholder={t("ads.selectAccount", "Select account")} />
                </SelectTrigger>
                <SelectContent>
                  {fbAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.platform_username || a.platform_user_id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {adAccounts.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{t("ads.adAccount", "Ad Account")}</span>
              <Select value={activeAdAccountId || ""} onValueChange={setSelectedAdAccountId}>
                <SelectTrigger className="w-[220px] h-9">
                  <SelectValue placeholder={t("ads.selectAdAccount", "Select ad account")} />
                </SelectTrigger>
                <SelectContent>
                  {adAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name} ({a.id})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{t("ads.dateRange", "Date Range")}</span>
            <Select value={datePreset} onValueChange={setDatePreset}>
              <SelectTrigger className="w-[160px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.value === "today" ? t("header.today", "Today")
                      : d.value === "yesterday" ? t("header.yesterday", "Yesterday")
                      : d.value === "last_7d" ? t("header.date7", "Last 7 days")
                      : d.value === "last_14d" ? t("header.date14", "Last 14 days")
                      : d.value === "last_30d" ? t("header.date30", "Last 30 days")
                      : t("header.date90", "Last 90 days")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        </GradientRingCard>
        </Reveal>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 rounded-2xl border border-border/40 bg-card">
            <Loader2 className="h-8 w-8 animate-spin text-foreground" />
          </div>
        ) : fbAccounts.length === 0 ? (
          <Reveal delay={120}>
            <GradientRingCard variant="sky" hoverLift={false} ringIntensity="subtle">
              <div className="flex flex-col items-center text-center py-6 space-y-3">
                <div className="group"><Icon3D icon={BarChart3} variant="sky" size="lg" /></div>
                <p className="font-medium mt-1">{t("empty.noFacebook", "No Facebook accounts connected")}</p>
                <p className="text-sm text-muted-foreground">{t("ads.connectToView", "Connect a Facebook account to view ad analytics.")}</p>
              </div>
            </GradientRingCard>
          </Reveal>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {([
                { id: "spend", label: t("ads.totalSpend", "Total Spend"), value: `$${totals.spend.toFixed(2)}`, icon: DollarSign, variant: "emerald" as GradientKey },
                { id: "impressions", label: t("ads.impressions", "Impressions"), value: totals.impressions.toLocaleString(), icon: Eye, variant: "sky" as GradientKey },
                { id: "clicks", label: t("ads.clicks", "Clicks"), value: totals.clicks.toLocaleString(), icon: MousePointerClick, variant: "violet" as GradientKey },
                { id: "ctr", label: t("ads.avgCtr", "Avg CTR"), value: totals.impressions > 0 ? `${((totals.clicks / totals.impressions) * 100).toFixed(2)}%` : "0%", icon: TrendingUp, variant: "amber" as GradientKey },
              ]).map((m, i) => (
                <Reveal key={m.id} delay={i * 60}>
                  <div className="group rounded-2xl border border-border/40 bg-card p-4 flex items-center gap-3 transition-transform hover:-translate-y-0.5">
                    <Icon3D icon={m.icon} variant={m.variant} size="sm" />
                    <div>
                      <p className="text-xs text-muted-foreground">{m.label}</p>
                      <p className="text-lg font-semibold tabular-nums">{m.value}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>

            {/* Charts */}
            {insights.length > 0 && (
              <div className="grid md:grid-cols-2 gap-4">
                {(["spend", "impressions", "clicks", "ctr"] as const).map((metric, i) => (
                  <Reveal key={metric} delay={i * 60}>
                    <GradientRingCard variant="sky" padded={false} ringIntensity="subtle" innerClassName="p-4">
                      <AdInsightsChart insights={insights} metric={metric} />
                    </GradientRingCard>
                  </Reveal>
                ))}
              </div>
            )}

            {/* Campaign table */}
            <Reveal delay={200}>
              <GradientRingCard variant="sky" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <div className="flex items-center gap-2 text-base font-semibold mb-3">
                  <BarChart3 className="h-4 w-4 text-foreground" />
                  {t("ads.campaigns", "Campaigns")}
                </div>
                <CampaignTable campaigns={campaigns} />
              </GradientRingCard>
            </Reveal>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
