import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { CommentManagerPanel } from "@/components/comments/CommentManagerPanel";
import { ThreadsRepliesTab } from "@/components/messaging/threads/replies/ThreadsRepliesTab";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { MessageCircle, Sparkles, ArrowRight, MessageSquare } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type CommentPlatform = "facebook" | "instagram" | "threads";

interface PlatformOption {
  id: CommentPlatform;
  label: string;
  colorPreset: "sky" | "rose" | "violet";
}

const PLATFORMS: PlatformOption[] = [
  { id: "facebook", label: "Facebook", colorPreset: "sky" },
  { id: "instagram", label: "Instagram", colorPreset: "rose" },
  { id: "threads", label: "Threads", colorPreset: "violet" },
];

export default function CommentManagerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const platformParam = searchParams.get("platform") as CommentPlatform;
  const platform: CommentPlatform = PLATFORMS.some((p) => p.id === platformParam) ? platformParam : "facebook";

  const { data: socialAccounts = [] } = useSocialAccounts();
  const threadsAccounts = socialAccounts.filter((a) => a.platform === "threads" && a.is_active);
  const selectedThreadsParam = searchParams.get("accountId");
  const activeThreadsAccountId = (selectedThreadsParam && threadsAccounts.some((a) => a.id === selectedThreadsParam))
    ? selectedThreadsParam
    : threadsAccounts[0]?.id || null;

  const selectedPlatformMeta = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];

  const handlePlatformChange = (nextPlatform: CommentPlatform) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("platform", nextPlatform);
      return next;
    }, { replace: true });
  };

  const handleThreadsAccountChange = (accountId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("accountId", accountId);
      return next;
    }, { replace: true });
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Icon3D icon={MessageCircle} variant="emerald" size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="emerald-cyan-sky" size="lg" as="h1">
                    Comment Manager
                  </GradientHeading>
                  <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
                    <MessageSquare className="w-3 h-3" /> Live Comments Feed
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Read, moderate, and manually reply to post comments across your connected channels
                </p>
              </div>
            </div>

            <Button asChild variant="outline" className="gap-2 border-primary/30 hover:bg-primary/10">
              <Link to={`/automation/comments?platform=${platform}`}>
                <Sparkles className="w-4 h-4 text-primary" />
                <span>Comments Automation</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </Reveal>

        <GradientDivider tone="emerald" />

        {/* Platform Selector Tabs */}
        <Reveal delay={40}>
          <div className="flex flex-wrap items-center gap-2 bg-card/60 backdrop-blur-md border border-border/50 rounded-2xl p-2 shadow-sm" role="tablist" aria-label="Comment Channels">
            {PLATFORMS.map((p) => {
              const isSelected = platform === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => handlePlatformChange(p.id)}
                  className={cn(
                    "flex items-center gap-2 py-2.5 px-4 rounded-xl border text-sm font-medium transition-all duration-200",
                    isSelected
                      ? "bg-primary/15 border-primary text-foreground shadow-sm ring-1 ring-primary/40 font-semibold"
                      : "bg-background/50 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  <PlatformIcon platform={p.id} className="w-4 h-4 shrink-0" />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Platform Comment Feed Panel */}
        <Reveal delay={60}>
          <GradientRingCard
            variant={selectedPlatformMeta.colorPreset}
            padded={false}
            hoverLift={false}
            ringIntensity="subtle"
            innerClassName="p-4 md:p-6"
          >
            {platform === "facebook" && <CommentManagerPanel platform="facebook" />}
            {platform === "instagram" && <CommentManagerPanel platform="instagram" />}
            {platform === "threads" && (
              <div className="space-y-4">
                {threadsAccounts.length === 0 ? (
                  <div className="text-center py-12 space-y-3 bg-muted/20 border border-dashed border-border rounded-xl">
                    <p className="text-sm text-muted-foreground">No active Threads account connected.</p>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/profiles">Connect Threads in Profiles</Link>
                    </Button>
                  </div>
                ) : (
                  <>
                    {threadsAccounts.length > 1 && (
                      <div className="flex items-center gap-2 pb-3 border-b border-border/40">
                        <span className="text-xs text-muted-foreground font-medium">Select Account:</span>
                        <div className="flex gap-2">
                          {threadsAccounts.map((acc) => (
                            <Button
                              key={acc.id}
                              size="sm"
                              variant={activeThreadsAccountId === acc.id ? "default" : "outline"}
                              onClick={() => handleThreadsAccountChange(acc.id)}
                              className="text-xs h-7"
                            >
                              @{acc.platform_username || "Threads"}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                    <ThreadsRepliesTab accountId={activeThreadsAccountId} />
                  </>
                )}
              </div>
            )}
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
