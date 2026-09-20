import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Activity } from "lucide-react";
import { getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { CHART_COLORS, PLATFORM_COLORS } from "@/lib/chartColors";

interface PlatformPerformanceChartProps {
  data: Record<string, any>[];
  platforms: string[];
}

export function PlatformPerformanceChart({
  data,
  platforms,
}: PlatformPerformanceChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <Activity className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.platformOverTime", "Posts by Platform Over Time")}</h3>
      </div>
      <div className="h-64">
        {platforms.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
              />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Legend />
              {platforms.map((platform, idx) => (
                <Area
                  key={platform}
                  type="monotone"
                  dataKey={platform}
                  stackId="1"
                  stroke={PLATFORM_COLORS[platform] || CHART_COLORS[idx % CHART_COLORS.length]}
                  fill={PLATFORM_COLORS[platform] || CHART_COLORS[idx % CHART_COLORS.length]}
                  fillOpacity={0.6}
                  name={getPlatformName(platform as Platform)}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {t("empty.noPlatformData", "No platform data available")}
          </div>
        )}
      </div>
    </Card>
  );
}
