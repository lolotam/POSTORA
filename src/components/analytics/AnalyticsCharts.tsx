import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Target, Eye, Clock } from "lucide-react";
import { CHART_COLORS, PLATFORM_COLORS } from "@/lib/chartColors";

interface PlatformSuccessRate {
  platform: string;
  name: string;
  successRate: number;
  total: number;
  successful: number;
}

interface StatusData {
  name: string;
  value: number;
  color: string;
}

interface HourData {
  hour: string;
  posts: number;
}

interface PlatformSuccessChartProps {
  data: PlatformSuccessRate[];
}

export function PlatformSuccessChart({ data }: PlatformSuccessChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <Target className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.successByPlatform", "Success Rate by Platform")}</h3>
      </div>
      <div className="h-64">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                type="number"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="name"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                width={100}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value, name, props) => [
                  `${value}% (${props.payload.successful}/${props.payload.total})`,
                  t("charts.successRate", "Success Rate"),
                ]}
              />
              <Bar dataKey="successRate" radius={[0, 4, 4, 0]}>
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={PLATFORM_COLORS[entry.platform] || CHART_COLORS[index % CHART_COLORS.length]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {t("empty.noPlatformPerf", "No platform performance data yet")}
          </div>
        )}
      </div>
    </Card>
  );
}

interface StatusDistributionChartProps {
  data: StatusData[];
}

export function StatusDistributionChart({ data }: StatusDistributionChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <Eye className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.statusDistribution", "Status Distribution")}</h3>
      </div>
      <div className="h-64">
        {data.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} />
              <YAxis
                type="category"
                dataKey="name"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                width={80}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
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

interface PostingActivityChartProps {
  data: HourData[];
}

export function PostingActivityChart({ data }: PostingActivityChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <Clock className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.postsByHour", "Posting Activity by Hour")}</h3>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="hour"
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              interval={2}
            />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "8px",
              }}
            />
            <Bar
              dataKey="posts"
              fill="hsl(199, 89%, 48%)"
              radius={[4, 4, 0, 0]}
              name={t("charts.postsLabel", "Posts")}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
