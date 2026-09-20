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
} from "recharts";
import { Target } from "lucide-react";

interface SuccessRateData {
  date: string;
  successRate: number | null;
}

interface SuccessRateChartProps {
  data: SuccessRateData[];
  overallSuccessRate: number;
}

export function SuccessRateChart({ data, overallSuccessRate }: SuccessRateChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <Target className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.successOverTime", "Success Rate Over Time")}</h3>
        <span className="ml-auto text-2xl font-bold text-emerald-500">
          {overallSuccessRate}%
        </span>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="successGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
            />
            <YAxis
              stroke="hsl(var(--muted-foreground))"
              fontSize={12}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
              formatter={(value) =>
                value !== null ? [`${value}%`, t("charts.successRate", "Success Rate")] : [t("charts.nA", "N/A"), t("charts.successRate", "Success Rate")]
              }
            />
            <Area
              type="monotone"
              dataKey="successRate"
              stroke="hsl(142, 76%, 36%)"
              strokeWidth={2}
              fill="url(#successGradient)"
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
