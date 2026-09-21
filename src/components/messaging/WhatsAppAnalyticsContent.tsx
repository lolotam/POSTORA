import { useTranslation } from "react-i18next";
import "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMessagingAccounts } from "@/hooks/useMessaging";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { MessageSquare, Send, Users, Clock, BarChart3, Loader2, ArrowDownLeft, ArrowUpRight } from "lucide-react";

export function WhatsAppAnalyticsContent() {
  const { t } = useTranslation("whatsapp");
  const { accounts } = useMessagingAccounts();
  const waAccount = accounts.find((a) => a.platform === "whatsapp");

  const { data: cacheStats, isLoading: cacheLoading } = useQuery({
    queryKey: ["whatsapp-analytics-cache", waAccount?.id],
    queryFn: async () => {
      if (!waAccount) return null;
      const { data, error } = await supabase
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", waAccount.id)
        .eq("platform", "whatsapp");
      if (error) throw error;

      const totalConversations = data?.length || 0;
      const totalUnread = data?.reduce((sum, c) => sum + (c.unread_count || 0), 0) || 0;
      const recentMessages = data?.filter(c => {
        const lastMsg = c.last_message_at ? new Date(c.last_message_at) : null;
        return lastMsg && (Date.now() - lastMsg.getTime()) < 24 * 60 * 60 * 1000;
      }).length || 0;

      const dayMap: Record<string, { date: string; conversations: number }> = {};
      data?.forEach(c => {
        if (c.last_message_at) {
          const day = new Date(c.last_message_at).toISOString().split("T")[0];
          if (!dayMap[day]) dayMap[day] = { date: day, conversations: 0 };
          dayMap[day].conversations++;
        }
      });
      const chartData = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);

      return { totalConversations, totalUnread, recentMessages, chartData };
    },
    enabled: !!waAccount,
  });

  // Enhanced analytics from whatsapp_messages
  const { data: msgStats, isLoading: msgLoading } = useQuery({
    queryKey: ["whatsapp-analytics-messages", waAccount?.id],
    queryFn: async () => {
      if (!waAccount) return null;
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("direction, timestamp, conversation_id")
        .eq("social_account_id", waAccount.id)
        .order("timestamp", { ascending: true });
      if (error) throw error;
      if (!data) return null;

      const inbound = data.filter(m => m.direction === "inbound");
      const outbound = data.filter(m => m.direction === "outbound");

      // Avg response time: for each inbound msg, find next outbound in same conversation
      const responseTimes: number[] = [];
      const outboundByConv: Record<string, typeof data> = {};
      outbound.forEach(m => {
        if (!outboundByConv[m.conversation_id]) outboundByConv[m.conversation_id] = [];
        outboundByConv[m.conversation_id].push(m);
      });

      inbound.forEach(msg => {
        const convOutbound = outboundByConv[msg.conversation_id];
        if (!convOutbound) return;
        const reply = convOutbound.find(o => new Date(o.timestamp) > new Date(msg.timestamp));
        if (reply) {
          const diff = new Date(reply.timestamp).getTime() - new Date(msg.timestamp).getTime();
          if (diff > 0 && diff < 24 * 60 * 60 * 1000) responseTimes.push(diff);
        }
      });

      const avgResponseMs = responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : null;

      // Format response time
      let avgResponseStr = "—";
      if (avgResponseMs !== null) {
        const mins = Math.round(avgResponseMs / 60000);
        if (mins < 60) avgResponseStr = `${mins}m`;
        else avgResponseStr = `${Math.round(mins / 60)}h ${mins % 60}m`;
      }

      // Peak hours
      const hourCounts: Record<number, number> = {};
      data.forEach(m => {
        const hour = new Date(m.timestamp).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      });
      const peakHoursData = Array.from({ length: 24 }, (_, h) => ({
        hour: `${h.toString().padStart(2, "0")}:00`,
        messages: hourCounts[h] || 0,
      }));

      return {
        inboundCount: inbound.length,
        outboundCount: outbound.length,
        avgResponseStr,
        peakHoursData,
      };
    },
    enabled: !!waAccount,
  });

  const isLoading = cacheLoading || msgLoading;

  if (!waAccount) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{t("empty.noAccount", "No WhatsApp Business account connected.")}</p>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <Users className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{cacheStats?.totalConversations || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.totalConversations", "Total Conversations")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <MessageSquare className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{cacheStats?.totalUnread || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.unread", "Unread Messages")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Send className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{cacheStats?.recentMessages || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.activeToday", "Active Today")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                <Clock className="h-5 w-5 text-purple-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{msgStats?.avgResponseStr || "—"}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.avgResponse", "Avg Response Time")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <ArrowDownLeft className="h-5 w-5 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{msgStats?.inboundCount || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.received", "Received")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-sky-500/10 flex items-center justify-center">
                <ArrowUpRight className="h-5 w-5 text-sky-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{msgStats?.outboundCount || 0}</p>
                <p className="text-sm text-muted-foreground">{t("analytics.sent", "Sent")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t("analytics.conversationsOverTime", "Conversations Over Time")}</CardTitle></CardHeader>
          <CardContent>
            {(cacheStats?.chartData?.length || 0) > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={cacheStats?.chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <Tooltip />
                  <Bar dataKey="conversations" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p>{t("analytics.noConversationData", "No conversation data yet.")}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("analytics.peakHours", "Peak Hours")}</CardTitle></CardHeader>
          <CardContent>
            {(msgStats?.peakHoursData?.some(d => d.messages > 0)) ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={msgStats?.peakHoursData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={2} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" />
                  <Tooltip />
                  <Bar dataKey="messages" fill="hsl(142, 71%, 45%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <p>{t("analytics.noMessageData", "No message data yet. Peak hours will show as messages flow in.")}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
