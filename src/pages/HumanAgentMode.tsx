import { useTranslation } from "react-i18next";
import "@/i18n";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Headphones, Bot, UserRound, MessageSquare, Clock, Settings, Inbox } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";
import { useWhatsAppAgents, useConversationAssignments, useAssignmentHistory } from "@/hooks/useWhatsAppAgents";
import { useMessagingAccounts, useConversations, type Conversation, type MessagingAccount } from "@/hooks/useMessaging";
import { AccountSelector } from "@/components/messaging/AccountSelector";
import { WaitingQueueFilter } from "@/components/messaging/human-agent/WaitingQueueFilter";
import { emptyQueueCopy, resolveQueueFilter, type Platform, type QueueFilter } from "@/components/messaging/human-agent/queueFilter";
import { useState } from "react";
import { formatDistanceToNow, isToday } from "date-fns";

// Conversations expose a different join key per platform: WhatsApp's own id is already stable,
// while Facebook/Instagram use assignment_key (see useMessaging.ts) since Meta's conversation id
// never appears in inbound webhook payloads.
function keyFor(conv: Conversation): string {
  return conv.assignment_key || conv.id;
}

export default function HumanAgentMode() {
  const { t } = useTranslation("automation");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { session } = useAuth();
  const { myAgent, registerAgent, updateStatus, updateMaxConversations } = useWhatsAppAgents();
  const { assignments, assignConversation, unassignConversation } = useConversationAssignments(myAgent?.workspace_id);
  const { data: history = [] } = useAssignmentHistory();
  const { accounts } = useMessagingAccounts();

  // Which connected account feeds each platform's queue below. Defaults to the
  // first connected account per platform, but a user with multiple Pages/IG
  // accounts can switch — otherwise the queue silently only ever showed
  // whichever account happened to be first, with no way to see the others.
  const [selectedAccountIds, setSelectedAccountIds] = useState<Partial<Record<Platform, string>>>({});
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");

  const accountFor = (platform: Platform): MessagingAccount | undefined => {
    const matchingAccounts = accounts.filter((a) => a.platform === platform);
    const selectedId = selectedAccountIds[platform];
    return matchingAccounts.find((a) => a.id === selectedId) || matchingAccounts[0];
  };

  const platformAccounts: Record<Platform, MessagingAccount | undefined> = {
    whatsapp: accountFor("whatsapp"),
    facebook: accountFor("facebook"),
    instagram: accountFor("instagram"),
  };
  const { data: waConversations = [] } = useConversations(platformAccounts.whatsapp?.id || null, "WHATSAPP", { silent: true });
  const { data: fbConversations = [] } = useConversations(platformAccounts.facebook?.id || null, "MESSENGER", { silent: true });
  const { data: igConversations = [] } = useConversations(platformAccounts.instagram?.id || null, "INSTAGRAM", { silent: true });

  const conversationsByPlatform: Record<Platform, Conversation[]> = {
    whatsapp: waConversations,
    facebook: fbConversations,
    instagram: igConversations,
  };
  const allConversations = (Object.keys(conversationsByPlatform) as Platform[]).flatMap((platform) =>
    conversationsByPlatform[platform].map((conv) => ({ platform, conv, key: keyFor(conv) }))
  );

  if (!flagsLoading && !flags.humanAgent) {
    return <Navigate to="/dashboard" replace />;
  }

  const isOnline = myAgent?.status === "online";
  const assignedKeys = new Set(assignments.map((a) => a.conversation_id));

  const myQueue = assignments
    .filter((a) => a.agent_id === myAgent?.id)
    .map((a) => ({ assignment: a, match: allConversations.find((c) => c.key === a.conversation_id) }));

  const waitingQueue = allConversations.filter((c) => !assignedKeys.has(c.key));

  // Waiting-queue platform filter. availablePlatforms keeps the account-selector
  // row's display order; counts stay derived from the unfiltered queue so the
  // chips and the "Waiting" stat card never disagree about the workload.
  const availablePlatforms = (["facebook", "instagram", "whatsapp"] as Platform[]).filter((platform) =>
    accounts.some((a) => a.platform === platform)
  );
  const activeFilter = resolveQueueFilter(queueFilter, availablePlatforms);
  const visibleQueue = activeFilter === "all"
    ? waitingQueue
    : waitingQueue.filter((c) => c.platform === activeFilter);
  const waitingCounts: Record<Platform, number> = { facebook: 0, instagram: 0, whatsapp: 0 };
  for (const { platform } of waitingQueue) {
    waitingCounts[platform] += 1;
  }
  const emptyCopy = emptyQueueCopy(activeFilter, waitingQueue.length);

  const resolvedToday = history.filter(
    (h) => h.action === "unassigned" && h.from_agent_id === myAgent?.id && isToday(new Date(h.created_at))
  ).length;

  const handleToggleOnline = async (checked: boolean) => {
    if (!myAgent) {
      if (!checked) return;
      const displayName = session?.user?.user_metadata?.full_name || session?.user?.email || "Agent";
      await registerAgent.mutateAsync({ display_name: displayName });
    } else {
      await updateStatus.mutateAsync(checked ? "online" : "offline");
    }
    toast({
      title: checked ? t("toast.nowOnline", "You're now online") : t("toast.nowOffline", "You're now offline"),
      description: checked
        ? t("toast.nowOnlineDesc", "You can now claim conversations from the queue.")
        : t("toast.nowOfflineDesc", "Auto-replies will handle incoming messages."),
    });
  };

  const handleClaim = (conversationKey: string) => {
    if (!myAgent) return;
    assignConversation.mutate(
      { conversationId: conversationKey, agentId: myAgent.id },
      {
        onSuccess: () => toast({ title: t("toast.claimed", "Conversation claimed") }),
        onError: (e) => toast({ title: t("toast.claimFailed", "Failed to claim conversation"), description: e.message, variant: "destructive" }),
      }
    );
  };

  const handleResolve = (conversationKey: string) => {
    unassignConversation.mutate(
      { conversationId: conversationKey },
      {
        onSuccess: () => toast({ title: t("toast.resolved", "Marked as resolved") }),
        onError: (e) => toast({ title: t("toast.resolveFailed", "Failed to resolve"), description: e.message, variant: "destructive" }),
      }
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="group flex items-center gap-4 min-w-0">
              <Icon3D icon={Headphones} variant="amber" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="amber-rose-violet" size="lg" as="h1">{t("header.humanAgent", "Human Agent Mode")}</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">{t("human.subtitle", "Take over conversations from auto-reply bots")}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-full border border-border/40 bg-card/60 backdrop-blur-md px-3 py-1.5">
              <span className="text-sm text-muted-foreground">{t("human.agentStatus", "Agent Status")}</span>
              <Switch checked={isOnline} onCheckedChange={handleToggleOnline} />
              <Badge className={isOnline
                ? "bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 text-white border-0"
                : "bg-card/60 border border-border/40 text-muted-foreground"}>
                {isOnline ? t("human.online", "Online") : t("human.offline", "Offline")}
              </Badge>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="rose" />

        {/* Account selectors: which connected Page/IG/WhatsApp account feeds the queue below */}
        {accounts.length > 0 && (
          <Reveal delay={40}>
            <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-4">
              {(["facebook", "instagram", "whatsapp"] as Platform[]).map((platform) => {
                if (!accounts.some((a) => a.platform === platform)) return null;
                return (
                  <div key={platform} className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-muted-foreground capitalize shrink-0">{platform}</span>
                    <AccountSelector
                      accounts={accounts}
                      platformFilter={platform}
                      selectedId={platformAccounts[platform]?.id || null}
                      onSelect={(id) => setSelectedAccountIds((prev) => ({ ...prev, [platform]: id }))}
                    />
                  </div>
                );
              })}
            </div>
          </Reveal>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {([
            { id: "active", label: t("human.stat.active", "My Active Chats"), value: myQueue.length, icon: MessageSquare, variant: "amber" as GradientKey },
            { id: "waiting", label: t("human.stat.waiting", "Waiting"), value: waitingQueue.length, icon: Clock, variant: "rose" as GradientKey },
            { id: "resolved", label: t("human.stat.resolved", "Resolved Today"), value: resolvedToday, icon: UserRound, variant: "violet" as GradientKey },
            { id: "avg", label: t("human.stat.avgResponse", "Avg Response"), value: "—", icon: Clock, variant: "sky" as GradientKey },
          ]).map((stat, i) => (
            <Reveal key={stat.id} delay={i * 60}>
              <div className="group rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-4 flex items-center gap-3 transition-transform hover:-translate-y-0.5">
                <Icon3D icon={stat.icon} variant={stat.variant} size="sm" />
                <div>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className="text-lg font-semibold">{stat.value}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        {/* My active chats */}
        <Reveal delay={120}>
          <GradientRingCard variant="amber" hoverLift={false} ringIntensity="subtle">
            <div className="space-y-1 mb-4">
              <div className="flex items-center gap-2 text-base font-semibold">
                <MessageSquare className="h-5 w-5 text-amber-500" />
                {t("human.activeTitle", "My Active Conversations")}
              </div>
              <p className="text-sm text-muted-foreground">
                {isOnline ? t("human.activeOnlineHint", "Conversations you're currently handling.") : t("human.activeOfflineHint", "Go online to claim conversations from the queue.")}
              </p>
            </div>
            {myQueue.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <div className="group inline-flex mb-3"><Icon3D icon={Bot} variant="amber" size="lg" /></div>
                <p className="font-medium mt-2">{t("empty.noActiveConversations", "No active conversations")}</p>
                <p className="text-sm mt-1">{t("empty.claimHint", "Claim a conversation from the waiting queue below to get started.")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {myQueue.map(({ assignment, match }) => (
                  <div key={assignment.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/40 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{match?.conv.participant_name || t("common:unknown", "Unknown")}</p>
                        {match && <Badge variant="outline" className="text-xs shrink-0">{match.platform}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{match?.conv.last_message || ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("human.claimedAgo", "Claimed {{time}}", { time: formatDistanceToNow(new Date(assignment.assigned_at), { addSuffix: true }) })}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => handleResolve(assignment.conversation_id)}>
                      {t("actions.resolve", "Resolve")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </GradientRingCard>
        </Reveal>

        {/* Waiting queue */}
        <Reveal delay={160}>
          <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle">
            <div className="space-y-1 mb-4">
              <div className="flex items-center gap-2 text-base font-semibold">
                <Inbox className="h-5 w-5 text-rose-500" />
                {t("human.waitingTitle", "Waiting Queue")}
              </div>
              <p className="text-sm text-muted-foreground">{t("human.waitingHint", "Unclaimed conversations across WhatsApp, Facebook, and Instagram, from the accounts selected above.")}</p>
            </div>
            <WaitingQueueFilter
              platforms={availablePlatforms}
              counts={waitingCounts}
              totalCount={waitingQueue.length}
              value={activeFilter}
              onChange={setQueueFilter}
            />
            {visibleQueue.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <p className="font-medium">{emptyCopy.title}</p>
                <p className="text-sm mt-1">{emptyCopy.subtitle}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleQueue.map(({ platform, conv, key }) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/40 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{conv.participant_name}</p>
                        <Badge variant="outline" className="text-xs shrink-0">{platform}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{conv.last_message}</p>
                    </div>
                    <Button size="sm" disabled={!isOnline || !myAgent} onClick={() => handleClaim(key)}>
                      {t("actions.claim", "Claim")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </GradientRingCard>
        </Reveal>

        {/* Settings */}
        <Reveal delay={200}>
          <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-6">
            <div className="flex items-center gap-2 text-base font-semibold mb-4">
              <Settings className="h-5 w-5 text-amber-500" />
              {t("human.settingsTitle", "Agent Settings")}
            </div>
            <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("form.maxChats", "Max concurrent chats")}</label>
              <Select
                value={String(myAgent?.max_conversations ?? 10)}
                onValueChange={(v) => updateMaxConversations.mutate(Number(v), {
                  onSuccess: () => toast({ title: t("toast.settingsSaved", "Settings saved") }),
                  onError: (e) => toast({ title: t("toast.saveFailed", "Failed to save"), description: e.message, variant: "destructive" }),
                })}
                disabled={!myAgent}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["3", "5", "10", "15", "20"].map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!myAgent && (
                <p className="text-xs text-muted-foreground">{t("human.goOnlineFirst", "Go online to register as an agent before adjusting this.")}</p>
              )}
            </div>
            </div>
          </div>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
