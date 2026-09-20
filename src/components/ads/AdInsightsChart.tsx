import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DailyInsight } from "@/hooks/useAdAnalytics";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format, parseISO } from "date-fns";

interface AdInsightsChartProps {
  insights: DailyInsight[];
  metric: "spend" | "impressions" | "clicks" | "ctr";
}

const METRIC_CONFIG = {
  spend: { color: "hsl(var(--primary))", prefix: "$" },
  impressions: { color: "hsl(var(--accent))", prefix: "" },
  clicks: { color: "hsl(142 76% 36%)", prefix: "" },
  ctr: { color: "hsl(280 65% 60%)", prefix: "", suffix: "%" },
};

export function AdInsightsChart({ insights, metric }: AdInsightsChartProps) {
  const { t } = useTranslation("analytics");
  const config = METRIC_CONFIG[metric];
  const label =
    metric === "spend" ? t("charts.spend", "Spend")
    : metric === "impressions" ? t("charts.impressions", "Impressions")
    : metric === "clicks" ? t("charts.clicks", "Clicks")
    : t("charts.ctr", "CTR");
  const chartData = insights.map((d) => ({
    date: d.date_start,
    value: parseFloat(d[metric] || "0"),
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="date"
              tickFormatter={(v) => format(parseISO(v), "MMM d")}
              className="text-xs fill-muted-foreground"
              tick={{ fontSize: 11 }}
            />
            <YAxis className="text-xs fill-muted-foreground" tick={{ fontSize: 11 }} />
            <Tooltip
              labelFormatter={(v) => format(parseISO(v as string), "MMM d, yyyy")}
              formatter={(v: number) => [`${config.prefix || ""}${v.toFixed(2)}${(config as { suffix?: string }).suffix || ""}`, label]}
            />
            <Area type="monotone" dataKey="value" stroke={config.color} fill={config.color} fillOpacity={0.15} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
