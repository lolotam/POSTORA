import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { TrendingUp } from "lucide-react";

interface PostsOverTimeData {
  date: string;
  posts: number;
  published: number;
  failed: number;
  successRate: number | null;
}

interface PostsOverTimeChartProps {
  data: PostsOverTimeData[];
}

export function PostsOverTimeChart({ data }: PostsOverTimeChartProps) {
  const { t } = useTranslation("analytics");
  return (
    <Card className="p-6 bg-card/50 border-border">
      <div className="flex items-center gap-2 mb-6">
        <TrendingUp className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">{t("charts.postsOverTime", "Posts Over Time")}</h3>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
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
            <Line
              type="monotone"
              dataKey="posts"
              stroke="hsl(199, 89%, 48%)"
              strokeWidth={2}
              dot={{ fill: "hsl(199, 89%, 48%)" }}
              name={t("charts.totalPosts", "Total Posts")}
            />
            <Line
              type="monotone"
              dataKey="published"
              stroke="hsl(142, 76%, 36%)"
              strokeWidth={2}
              dot={{ fill: "hsl(142, 76%, 36%)" }}
              name={t("charts.published", "Published")}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
