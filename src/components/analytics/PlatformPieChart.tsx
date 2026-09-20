import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { CHART_COLORS } from "@/lib/chartColors";

interface PlatformData {
  name: string;
  platform: string;
  value: number;
}

interface PlatformPieChartProps {
  data: PlatformData[];
}

export function PlatformPieChart({ data }: PlatformPieChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <BarChart3 className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.postsByPlatform", "Posts by Platform")}</h3>
      </div>
      <div className="h-64">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                paddingAngle={5}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name} ${(percent * 100).toFixed(0)}%`
                }
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {t("empty.noPostsRange", "No posts in this time range")}
          </div>
        )}
      </div>
    </Card>
  );
}
