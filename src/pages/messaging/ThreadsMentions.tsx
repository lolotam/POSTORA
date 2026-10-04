import { useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
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
  Sparkles,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
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
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { ThreadsMentionCard } from "@/components/messaging/threads/ThreadsMentionCard";
import { ThreadsMentionsFilters } from "@/components/messaging/threads/ThreadsMentionsFilters";
import { ThreadsRepliesTab } from "@/components/messaging/threads/replies/ThreadsRepliesTab";
import { ThreadsAuthorAvatarProvider } from "@/components/messaging/threads/ThreadsAuthorAvatarContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNow } from "date-fns";
import { Icon3D, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";

interface ThreadsAccountOption {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface PlatformOption {
  id: "facebook" | "instagram" | "threads";
  label: string;
  /** When set, clicking this platform navigates to that path instead of loading inline content */
  externalPath?: string;
}

const PLATFORMS: PlatformOption[] = [
  // Facebook / Instagram comments live in the Comments Manager, which shares this
  // same persistent-logo layout — so switching keeps the header identical.
  { id: "facebook", label: "Facebook", externalPath: "/comments?platform=facebook" },
  { id: "instagram", label: "Instagram", externalPath: "/comments?platform=instagram" },
  { id: "threads", label: "Threads" },
];

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
  const { t } = useTranslation("inbox");
  const navigate = useNavigate();
  const { data: accounts = [], isLoading: accountsLoading } = useThreadsAccountOptions();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "replies" ? "replies" : "mentions";

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
      <div className="w-full space-y-6 pb-12">
        {/* Animated Gliding Title & 3D Social Media Channels — same style as Comments Manager */}
        <Reveal>
          <div className="flex flex-col items-center justify-center space-y-4 pt-1 pb-2">
            {/* Animated Title Track moving across the width of the social media section */}
            <div className="w-full max-w-3xl mx-auto overflow-hidden relative py-3 select-none">
              <motion.div
                className="flex items-center justify-center whitespace-nowrap"
                initial={{ x: "-15%" }}
                animate={{ x: ["-15%", "15%", "-15%"] }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              >
                <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-[0.35em] sm:tracking-[0.48em] md:tracking-[0.6em] drop-shadow-sm text-center text-foreground">
                  {t("threads.title", "Threads Mentions")}
                </h1>
              </motion.div>
            </div>

            <div
              className="flex items-center justify-center gap-6 sm:gap-8 md:gap-10 lg:gap-12 px-4 py-3 sm:py-4 flex-wrap bg-transparent"
              role="tablist"
              aria-label={t("threads.channelsAria", "Mention Channels")}
            >
              {PLATFORMS.map((p) => {
                const isSelected = p.id === "threads";
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => {
                      if (p.externalPath) navigate(p.externalPath);
                    }}
                    className="flex flex-col items-center gap-2 flex-shrink-0 transition-all duration-300 cursor-pointer group focus:outline-none"
                  >
                    <div
                      className={cn(
                        "relative w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-2xl sm:rounded-3xl flex items-center justify-center border transition-all duration-300 overflow-visible",
                        // 3D glass specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl sm:before:rounded-t-3xl before:pointer-events-none before:bg-white/40",
                        isSelected
                          ? "border-primary ring-4 ring-primary/40 shadow-[0_20px_40px_-8px_rgba(var(--primary-rgb,59,130,246),0.5),0_8px_16px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.9),inset_0_-3px_6px_rgba(0,0,0,0.25)] -translate-y-1.5 scale-105 bg-primary/25"
                          : "bg-card border-border/70 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.35),0_4px_10px_-2px_rgba(0,0,0,0.2),inset_0_1.5px_2px_rgba(255,255,255,0.7),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:border-primary/60 hover:shadow-[0_18px_36px_-8px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.9)] hover:-translate-y-1.5 hover:scale-105"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="2xl"
                        className="drop-shadow-[0_8px_10px_rgba(0,0,0,0.3)] transition-transform duration-300 group-hover:scale-110"
                      />
                      {/* External link indicator for platforms served elsewhere */}
                      {p.externalPath && (
                        <div className="absolute -top-2 -end-2 w-5 h-5 rounded-full bg-muted border border-border/60 flex items-center justify-center shadow-sm">
                          <ExternalLink className="w-2.5 h-2.5 text-muted-foreground" />
                        </div>
                      )}
                      {isSelected && (
                        <div className="absolute -top-2 -end-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg ring-2 ring-background animate-in zoom-in-50 duration-200">
                          <CheckCircle2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                        </div>
                      )}
                    </div>

                    <div className="text-center">
                      <span
                        className={cn(
                          "block text-xs sm:text-sm font-bold tracking-tight transition-colors",
                          isSelected
                            ? "text-foreground font-extrabold"
                            : "text-muted-foreground group-hover:text-foreground"
                        )}
                      >
                        {p.label}
                      </span>
                    </div>
                  </button>
                );
              })}
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
                  <h3 className="font-semibold">{t("threads.noAccount", "No Threads account connected")}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("threads.noAccountHint", "Connect a Threads account from Profiles to start tracking mentions.")}
                  </p>
                </div>
                <Button asChild className="text-primary-foreground bg-primary">
                  <Link to="/profiles">{t("threads.goProfiles", "Go to Profiles")}</Link>
                </Button>
              </div>
            </GradientRingCard>
          </Reveal>
        )}

        {/* Mentions panel below the persistent logos — same ring-card layout as Comments Manager */}
        {!noAccounts && (
          <Reveal delay={60}>
            <GradientRingCard
              variant="violet"
              padded={false}
              hoverLift={false}
              ringIntensity="subtle"
              innerClassName="p-4 md:p-6"
            >
              <ThreadsAuthorAvatarProvider accountId={selectedAccountId}>
                <AutomationHandlerCard
                  platform="threads"
                  accountId={selectedAccountId}
                  surface="comments"
                />
                <Tabs value={tab} onValueChange={(nextTab) => setSearchParams({ tab: nextTab })} className="w-full">
                  {/* Unified one-line banner: account selector + Mentions/Replies toggle + Refresh + AI settings */}
                  <div className="rounded-2xl border border-border/40 bg-card p-3 sm:p-4 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Select
                        value={selectedAccountId || ""}
                        onValueChange={(v) => setSelectedAccountId(v)}
                        disabled={accountsLoading || accounts.length === 0}
                      >
                        <SelectTrigger className="w-full sm:w-[220px]">
                            <SelectValue placeholder={t("accounts.selectThreads", "Select Threads account")}>
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
                        <Badge variant="default" className="shrink-0 text-white border-0 bg-neutral-900 dark:bg-neutral-800">
                          {t("threads.unreadCount", "{{count}} unread", { count: unreadCount })}
                        </Badge>
                      )}
                    </div>

                    <TabsList className="bg-muted rounded-lg p-1 h-auto">
                      <TabsTrigger value="mentions" className="rounded-lg">
                        <AtSign className="h-4 w-4 me-1.5" />
                        {t("threads.mentions", "Mentions")}
                      </TabsTrigger>
                      <TabsTrigger value="replies" className="rounded-lg">
                        <MessageCircle className="h-4 w-4 me-1.5" />
                        {t("threads.replies", "Replies")}
                      </TabsTrigger>
                    </TabsList>

                    <div className="flex items-center gap-2 sm:ms-auto flex-wrap">
                      <Button
                        onClick={handleRefresh}
                        disabled={!selectedAccountId || refresh.isPending}
                        size="sm"
                        className="text-white hover:opacity-90 bg-neutral-900 dark:bg-neutral-800"
                      >
                        {refresh.isPending ? (
                          <Loader2 className="h-4 w-4 me-2 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4 me-2" />
                        )}
                        {t("common:refresh", "Refresh")}
                      </Button>
                      {lastSyncedAt && (
                        <span className="text-xs text-muted-foreground hidden lg:inline">
                          {t("threads.lastSynced", "Last synced {{time}}", { time: formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true }) })}
                        </span>
                      )}
                      <Button asChild variant="outline" size="sm" className="gap-2 border-border hover:bg-muted">
                        <Link to="/automation/agents?platform=threads&surface=dms">
                          <Sparkles className="w-4 h-4 text-foreground" />
                          <span className="hidden sm:inline">{t("threads.aiSettings", "AI & Automation Settings")}</span>
                          <span className="sm:hidden">AI</span>
                        </Link>
                      </Button>
                    </div>
                  </div>

                    {/* MENTIONS TAB */}
                    <TabsContent value="mentions" className="mt-4 space-y-4">
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
                                {t("threads.failedLoad", "Failed to load mentions.")}
                              </p>
                              <Button variant="outline" size="sm" className="border-rose-500/40 hover:bg-rose-500/10" onClick={() => refetch()}>
                                {t("common:retry", "Retry")}
                              </Button>
                            </GradientRingCard>
                          )}

                          {!primed && (
                            <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
                              <div className="flex flex-col items-center text-center space-y-3 py-4">
                                <div className="group"><Icon3D icon={Inbox} variant="indigo" size="md" /></div>
                                <p className="text-sm font-medium">
                                  {t("threads.notLoaded", "Mentions are not loaded yet.")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  <Trans ns="inbox" i18nKey="threads.notLoadedHint" components={{ strong: <strong /> }}>
                                    Click <strong>Refresh</strong> to fetch the latest mentions from Threads. Results reset when you close the browser.
                                  </Trans>
                                </p>
                              </div>
                            </GradientRingCard>
                          )}

                          {primed && !isLoading && !error && mentions.length === 0 && (
                            <GradientRingCard variant="indigo" hoverLift={false} ringIntensity="subtle">
                              <div className="flex flex-col items-center text-center space-y-3 py-4">
                                <div className="group"><Icon3D icon={Inbox} variant="indigo" size="md" /></div>
                                <p className="text-sm font-medium">
                                  {t("threads.noMentions", "No mentions found for this Threads account yet.")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  <Trans ns="inbox" i18nKey="threads.noMentionsHint" components={{ strong: <strong /> }}>
                                    Click <strong>Refresh</strong> to fetch the latest mentions from Threads.
                                  </Trans>
                                </p>
                              </div>
                            </GradientRingCard>
                          )}

                          {!isLoading && !error && mentions.length > 0 && filteredMentions.length === 0 && (
                            <div className="rounded-2xl border border-border/40 bg-card p-6 text-center space-y-3">
                              <Inbox className="h-6 w-6 text-muted-foreground mx-auto" />
                              <p className="text-sm text-muted-foreground">
                                {t("threads.noMatch", "No mentions match your current filters.")}
                              </p>
                              <Button variant="outline" size="sm" className="border-input hover:bg-muted" onClick={reset}>
                                {t("threads.resetFilters", "Reset filters")}
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
                      <ThreadsRepliesTab accountId={selectedAccountId} />
                    </TabsContent>
                  </Tabs>
              </ThreadsAuthorAvatarProvider>
            </GradientRingCard>
          </Reveal>
        )}
      </div>
    </DashboardLayout>
  );
}
