import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AtSign,
  RefreshCw,
  Loader2,
  Inbox,
  AlertTriangle,
  MessageCircle,
  Bot,
  UserCog,
  Sparkles,
} from "lucide-react";
import { useOwnedThreadsAccounts } from "@/hooks/useOwnedThreadsAccounts";
import {
  useThreadsMentions,
  useRefreshThreadsMentions,
  useUpdateThreadsMentionStatus,
  useUpdateThreadsMentionMeta,
  useReplyToThreadsMention,
  useThreadsMentionsFilters,
  useAvailableLabels,
  useMentionsSessionPrimed,
} from "@/hooks/useThreadsMentions";
import { ThreadsMentionCard } from "@/components/messaging/threads/ThreadsMentionCard";
import { ThreadsMentionsFilters } from "@/components/messaging/threads/ThreadsMentionsFilters";
import { ThreadsRepliesTab } from "@/components/messaging/threads/replies/ThreadsRepliesTab";
import { ThreadsAuthorAvatarProvider } from "@/components/messaging/threads/ThreadsAuthorAvatarContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNow } from "date-fns";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { AgentManager } from "@/components/messaging/AgentManager";
import { AiAgentManager } from "@/components/messaging/AiAgentManager";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { messagingTabFromSearch } from "@/lib/messagingTab";

interface ThreadsAccountOption {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

function useThreadsAccountOptions() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  return useQuery({
    queryKey: ["threads-accounts-options", userId],
    queryFn: async (): Promise<ThreadsAccountOption[]> => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, avatar_url")
        .eq("user_id", userId)
        .eq("platform", "threads")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (error) throw error;
      return (data || []) as ThreadsAccountOption[];
    },
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export default function ThreadsMentions() {
  const { data: accounts = [], isLoading: accountsLoading } = useThreadsAccountOptions();
  const { flags } = useFeatureFlags();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = messagingTabFromSearch(searchParams.toString(), "mentions", [
    "mentions",
    "replies",
    "auto-replies",
    "agents",
    "ai-agent",
  ]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) || null,
    [accounts, selectedAccountId],
  );

  const { primed, markPrimed } = useMentionsSessionPrimed();
  const { mentions, unreadCount, lastSyncedAt, isLoading, error, refetch } =
    useThreadsMentions(selectedAccountId, { enabled: primed });
  const refresh = useRefreshThreadsMentions();
  const updateStatus = useUpdateThreadsMentionStatus(selectedAccountId);
  const replyMutation = useReplyToThreadsMention(selectedAccountId);
  const metaMutation = useUpdateThreadsMentionMeta(selectedAccountId);

  const { filters, setFilters, reset, applyFilters } = useThreadsMentionsFilters();
  const availableLabels = useAvailableLabels(mentions);
  const filteredMentions = applyFilters(mentions);

  const handleRefresh = () => {
    if (!selectedAccountId) return;
    markPrimed();
    refresh.mutate(selectedAccountId);
  };

  const handleMarkRead = (id: string) => updateStatus.mutate({ id, status: "read" });
  const handleArchive = (id: string) => updateStatus.mutate({ id, status: "archived" });

  const noAccounts = !accountsLoading && accounts.length === 0;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <Reveal>
          <div className="group flex items-center gap-4">
            <Icon3D icon={AtSign} variant="indigo" size="md" />
            <div className="flex-1 min-w-0">
              <GradientHeading preset="violet-sky" size="lg" as="h1">Threads Inbox</GradientHeading>
              <p className="text-sm text-muted-foreground mt-1">
                View mentions and manage replies for your connected Threads accounts.
              </p>
            </div>
          </div>
        </Reveal>
        <GradientDivider tone="violet" />

        {/* No accounts state */}
        {noAccounts && (
          <Reveal delay={80}>
            <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
              <div className="flex flex-col items-center text-center space-y-4 py-6">
                <div className="group"><Icon3D icon={AtSign} variant="indigo" size="lg" /></div>
                <div>
                  <h3 className="font-semibold">No Threads account connected</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Connect a Threads account from Profiles to start tracking mentions.
                  </p>
                </div>
                <Button asChild className="bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500 text-white hover:opacity-90">
                  <Link to="/profiles">Go to Profiles</Link>
                </Button>
              </div>
            </GradientRingCard>
          </Reveal>
        )}

        {/* Account selector (shared by both tabs) */}
        {!noAccounts && (
          <Reveal delay={80}>
          <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Select
                  value={selectedAccountId || ""}
                  onValueChange={(v) => setSelectedAccountId(v)}
                  disabled={accountsLoading || accounts.length === 0}
                >
                  <SelectTrigger className="w-full sm:w-[260px]">
                    <SelectValue placeholder="Select Threads account">
                      {selectedAccount && (
                        <span className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={selectedAccount.avatar_url || ""} />
                            <AvatarFallback className="text-[10px]">
                              {(selectedAccount.platform_username || "?").slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate">@{selectedAccount.platform_username}</span>
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={a.avatar_url || ""} />
                            <AvatarFallback className="text-[10px]">
                              {(a.platform_username || "?").slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span>@{a.platform_username}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {selectedAccountId && unreadCount > 0 && (
                  <Badge variant="default" className="shrink-0 bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500 text-white border-0">
                    {unreadCount} unread
                  </Badge>
                )}
              </div>
          </div>
          </Reveal>
        )}

        {/* Tabs: Mentions | Replies */}
        {!noAccounts && (
          <ThreadsAuthorAvatarProvider accountId={selectedAccountId}>
          <Tabs value={tab} onValueChange={(nextTab) => setSearchParams({ tab: nextTab })} className="w-full">
            <TabsList className="bg-card/50 backdrop-blur-md border border-border/40 rounded-xl p-1 h-auto [&>[data-state=active]]:bg-gradient-to-r [&>[data-state=active]]:from-indigo-500 [&>[data-state=active]]:via-violet-500 [&>[data-state=active]]:to-purple-500 [&>[data-state=active]]:text-white [&>[data-state=active]]:shadow-md">
              <TabsTrigger value="mentions" className="rounded-lg">
                <AtSign className="h-4 w-4 mr-1.5" />
                Mentions
              </TabsTrigger>
              <TabsTrigger value="replies" className="rounded-lg">
                <MessageCircle className="h-4 w-4 mr-1.5" />
                Replies
              </TabsTrigger>
              <TabsTrigger value="auto-replies" className="rounded-lg">
                <Bot className="h-4 w-4 mr-1.5" />
                Auto Replies
              </TabsTrigger>
              {flags.humanAgent && (
                <TabsTrigger value="agents" className="rounded-lg">
                  <UserCog className="h-4 w-4 mr-1.5" />
                  Agents
                </TabsTrigger>
              )}
              <TabsTrigger value="ai-agent" className="rounded-lg">
                <Sparkles className="h-4 w-4 mr-1.5" />
                AI Agent
              </TabsTrigger>
            </TabsList>

            {/* MENTIONS TAB */}
            <TabsContent value="mentions" className="mt-4 space-y-4">
              {selectedAccountId && (
                <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-4 flex flex-wrap items-center gap-3">
                    <Button
                      onClick={handleRefresh}
                      disabled={!selectedAccountId || refresh.isPending}
                      size="sm"
                      className="bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500 text-white hover:opacity-90"
                    >
                      {refresh.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      Refresh
                    </Button>
                    {lastSyncedAt && (
                      <span className="text-xs text-muted-foreground">
                        Last synced{" "}
                        {formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}
                      </span>
                    )}
                </div>
              )}

              {selectedAccountId && !isLoading && mentions.length > 0 && (
                <ThreadsMentionsFilters
                  filters={filters}
                  setFilters={setFilters}
                  reset={reset}
                  availableLabels={availableLabels}
                />
              )}

              {selectedAccountId && (
                <div className="space-y-3">
                  {isLoading && (
                    <>
                      {[0, 1, 2, 3].map((i) => (
                        <Card key={i}>
                          <CardContent className="p-4 space-y-3">
                            <div className="flex items-center gap-3">
                              <Skeleton className="h-9 w-9 rounded-full" />
                              <div className="space-y-2 flex-1">
                                <Skeleton className="h-3 w-32" />
                                <Skeleton className="h-3 w-20" />
                              </div>
                            </div>
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                          </CardContent>
                        </Card>
                      ))}
                    </>
                  )}

                  {!isLoading && error && (
                    <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-6 text-center space-y-3">
                      <AlertTriangle className="h-6 w-6 text-rose-500 mx-auto" />
                      <p className="text-sm text-muted-foreground">
                        Failed to load mentions.
                      </p>
                      <Button variant="outline" size="sm" className="border-rose-500/40 hover:bg-rose-500/10" onClick={() => refetch()}>
                        Retry
                      </Button>
                    </GradientRingCard>
                  )}

                  {!primed && (
                    <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
                      <div className="flex flex-col items-center text-center space-y-3 py-4">
                        <div className="group"><Icon3D icon={Inbox} variant="indigo" size="md" /></div>
                        <p className="text-sm font-medium">
                          Mentions are not loaded yet.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Click <strong>Refresh</strong> to fetch the latest mentions from Threads. Results reset when you close the browser.
                        </p>
                      </div>
                    </GradientRingCard>
                  )}

                  {primed && !isLoading && !error && mentions.length === 0 && (
                    <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
                      <div className="flex flex-col items-center text-center space-y-3 py-4">
                        <div className="group"><Icon3D icon={Inbox} variant="indigo" size="md" /></div>
                        <p className="text-sm font-medium">
                          No mentions found for this Threads account yet.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Click <strong>Refresh</strong> to fetch the latest mentions from Threads.
                        </p>
                      </div>
                    </GradientRingCard>
                  )}

                  {!isLoading && !error && mentions.length > 0 && filteredMentions.length === 0 && (
                    <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-6 text-center space-y-3">
                      <Inbox className="h-6 w-6 text-muted-foreground mx-auto" />
                      <p className="text-sm text-muted-foreground">
                        No mentions match your current filters.
                      </p>
                      <Button variant="outline" size="sm" className="border-violet-500/40 hover:bg-violet-500/10" onClick={reset}>
                        Reset filters
                      </Button>
                    </div>
                  )}

                  {!isLoading && !error && filteredMentions.length > 0 && (
                    <>
                      {filteredMentions.map((m) => (
                        <ThreadsMentionCard
                          key={m.id}
                          mention={m}
                          isUpdating={updateStatus.isPending && updateStatus.variables?.id === m.id}
                          isReplying={replyMutation.isPending && replyMutation.variables?.id === m.id}
                          isMetaUpdating={metaMutation.isPending && metaMutation.variables?.id === m.id}
                          onMarkRead={handleMarkRead}
                          onArchive={handleArchive}
                          onReply={(id, text) => replyMutation.mutate({ id, text })}
                          onMetaChange={(id, patch) => metaMutation.mutate({ id, patch })}
                          onStatusChange={(id, status) => updateStatus.mutate({ id, status })}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </TabsContent>

            {/* REPLIES TAB */}
            <TabsContent value="replies" className="mt-4">
              <AutomationHandlerCard platform="threads" accountId={selectedAccountId} />
              <ThreadsRepliesTab accountId={selectedAccountId} />
            </TabsContent>

            <TabsContent value="auto-replies" className="mt-4">
              <GradientRingCard variant="indigo" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <AutomationHandlerCard platform="threads" accountId={selectedAccountId} />
                <AutoReplyManager platform="threads" />
              </GradientRingCard>
            </TabsContent>

            {flags.humanAgent && (
              <TabsContent value="agents" className="mt-4">
                <GradientRingCard variant="indigo" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                  <AgentManager platform="threads" />
                </GradientRingCard>
              </TabsContent>
            )}

            <TabsContent value="ai-agent" className="mt-4">
              <GradientRingCard variant="indigo" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
                <AiAgentManager platform="threads" />
              </GradientRingCard>
            </TabsContent>
          </Tabs>
          </ThreadsAuthorAvatarProvider>
        )}
      </div>
    </DashboardLayout>
  );
}
