import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";
import { Loader2, Zap, Bot, TrendingUp } from "lucide-react";

export function CannedResponseAnalytics() {
  const { t } = useTranslation("inbox");
  const { data: qrData, isLoading: qrLoading } = useQuery({
    queryKey: ["canned-response-analytics-qr"],
    queryFn: async () => {
      const { data: usage, error } = await supabase
        .from("whatsapp_quick_reply_usage")
        .select("quick_reply_id, used_at");
      if (error) throw error;

      const { data: replies } = await supabase
        .from("whatsapp_quick_replies")
        .select("id, shortcut, message");

      const replyMap = new Map((replies || []).map(r => [r.id, r]));
      const countMap: Record<string, number> = {};
      const dailyMap: Record<string, number> = {};

      (usage || []).forEach(u => {
        countMap[u.quick_reply_id] = (countMap[u.quick_reply_id] || 0) + 1;
        const day = new Date(u.used_at).toISOString().split("T")[0];
        dailyMap[day] = (dailyMap[day] || 0) + 1;
      });

      const topReplies = Object.entries(countMap)
        .map(([id, count]) => {
          const reply = replyMap.get(id);
          return { name: reply?.shortcut || id.slice(0, 8), count, message: reply?.message || "" };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyData = Object.entries(dailyMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);

      return { topReplies, dailyData, total: usage?.length || 0 };
    },
  });

  const { data: arData, isLoading: arLoading } = useQuery({
    queryKey: ["canned-response-analytics-ar"],
    queryFn: async () => {
      const { data: usage, error } = await supabase
        .from("whatsapp_auto_reply_usage")
        .select("auto_reply_rule_id, triggered_at");
      if (error) throw error;

      const { data: rules } = await supabase
        .from("whatsapp_auto_replies")
        .select("id, name, rule_type");

      const ruleMap = new Map((rules || []).map(r => [r.id, r]));
      const countMap: Record<string, number> = {};
      const dailyMap: Record<string, number> = {};

      (usage || []).forEach(u => {
        countMap[u.auto_reply_rule_id] = (countMap[u.auto_reply_rule_id] || 0) + 1;
        const day = new Date(u.triggered_at).toISOString().split("T")[0];
        dailyMap[day] = (dailyMap[day] || 0) + 1;
      });

      const topRules = Object.entries(countMap)
        .map(([id, count]) => {
          const rule = ruleMap.get(id);
          return { name: rule?.name || id.slice(0, 8), count, type: rule?.rule_type || "unknown" };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyData = Object.entries(dailyMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);

      return { topRules, dailyData, total: usage?.length || 0 };
    },
  });

  const isLoading = qrLoading || arLoading;

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Zap className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{qrData?.total || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.quickRepliesUsed", "Quick Replies Used")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Bot className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{arData?.total || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.autoRepliesTriggered", "Auto Replies Triggered")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{(qrData?.total || 0) + (arData?.total || 0)}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.totalAutomated", "Total Automated Responses")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t("analytics.topQuickReplies", "Top Quick Replies")}</CardTitle></CardHeader>
          <CardContent>
            {(qrData?.topReplies?.length || 0) > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={qrData?.topReplies} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" tick={{ fontSize: 12 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip formatter={(val: number) => [val, t("analytics.uses", "Uses")]} />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center py-12 text-muted-foreground">{t("analytics.noQuickReplyData", "No quick reply usage data yet.")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("analytics.topAutoRules", "Top Auto-Reply Rules")}</CardTitle></CardHeader>
          <CardContent>
            {(arData?.topRules?.length || 0) > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={arData?.topRules} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" tick={{ fontSize: 12 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip formatter={(val: number) => [val, t("analytics.triggers", "Triggers")]} />
                  <Bar dataKey="count" fill="hsl(142, 71%, 45%)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center py-12 text-muted-foreground">{t("analytics.noAutoReplyData", "No auto-reply usage data yet.")}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t("analytics.quickUsageOverTime", "Quick Reply Usage Over Time")}</CardTitle></CardHeader>
          <CardContent>
            {(qrData?.dailyData?.length || 0) > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={qrData?.dailyData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center py-8 text-muted-foreground">{t("analytics.noData", "No data yet.")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("analytics.autoTriggersOverTime", "Auto-Reply Triggers Over Time")}</CardTitle></CardHeader>
          <CardContent>
            {(arData?.dailyData?.length || 0) > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={arData?.dailyData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="count" stroke="hsl(142, 71%, 45%)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center py-8 text-muted-foreground">{t("analytics.noData", "No data yet.")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
