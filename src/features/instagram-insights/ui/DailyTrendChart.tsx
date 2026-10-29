import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { TrendingUp } from "lucide-react";
import type { OwnerReportDailyRow } from "../domain/types";

export type DailyTrendChartProps = {
  daily: OwnerReportDailyRow[] | undefined;
};

export function DailyTrendChart({ daily = [] }: DailyTrendChartProps) {
  const { t } = useTranslation("analytics");

  const chartData = daily
    .filter((d) => d.status === "ok")
    .map((d) => ({
      date: d.metricDate.slice(5), // "MM-DD"
      reach: d.reach ?? 0,
      views: d.views ?? 0,
      interactions: d.totalInteractions ?? 0,
    }));

  if (chartData.length === 0) {
    return (
      <Card className="border border-border/70 bg-card/60 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-rose-500" />
            <span>{t("instagram.dailyTrends", "Daily Performance Trends")}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="h-64 flex items-center justify-center text-xs text-muted-foreground">
          {t("instagram.noDailyData", "No daily metric data recorded for this period yet.")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border border-border/70 bg-card/60 backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-rose-500" />
          <span>{t("instagram.dailyTrends", "Daily Performance Trends")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis
                dataKey="date"
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  borderColor: "hsl(var(--border))",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} />
              <Line
                type="monotone"
                dataKey="reach"
                name={t("instagram.reach", "Reach")}
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="views"
                name={t("instagram.views", "Views")}
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="interactions"
                name={t("instagram.interactions", "Interactions")}
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
