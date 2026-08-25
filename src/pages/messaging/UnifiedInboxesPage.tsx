import { useState, useEffect, useMemo } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { CommentManagerPanel } from "@/components/comments/CommentManagerPanel";
import { AccountSelector } from "@/components/messaging/AccountSelector";
import { useMessagingAccounts } from "@/hooks/useMessaging";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Icon3D, GradientHeading, GradientDivider, Reveal } from "@/components/fx";
import { PlatformIcon, type Platform } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  MessageSquare,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  PlusCircle,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type InboxPlatform = "whatsapp" | "facebook" | "instagram" | "threads";

interface PlatformTabOption {
  id: InboxPlatform;
  label: string;
  subLabel: string;
  flagKey: "msgWhatsapp" | "msgFacebook" | "msgInstagram" | "msgThreads";
  colorPreset: "emerald" | "sky" | "rose" | "violet";
}

const INBOX_PLATFORMS: PlatformTabOption[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    subLabel: "Business Chats",
    flagKey: "msgWhatsapp",
    colorPreset: "emerald",
  },
  {
    id: "facebook",
    label: "Facebook",
    subLabel: "Messenger DMs",
    flagKey: "msgFacebook",
    colorPreset: "sky",
  },
  {
    id: "instagram",
    label: "Instagram",
    subLabel: "Direct Messages",
    flagKey: "msgInstagram",
    colorPreset: "rose",
  },
  {
    id: "threads",
    label: "Threads",
    subLabel: "Mentions & Replies",
    flagKey: "msgThreads",
    colorPreset: "violet",
  },
];

export default function UnifiedInboxesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();

  const platformParam = searchParams.get("platform") as InboxPlatform;
  const platform: InboxPlatform = INBOX_PLATFORMS.some((p) => p.id === platformParam)
    ? platformParam
    : "whatsapp";

  const selectedPlatformMeta =
    INBOX_PLATFORMS.find((p) => p.id === platform) || INBOX_PLATFORMS[0];

  const handlePlatformChange = (nextPlatform: InboxPlatform) => {
    if (nextPlatform === "whatsapp") {
      navigate("/messaging/whatsapp");
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("platform", nextPlatform);
        return next;
      },
      { replace: true }
    );
  };

  // Connected accounts query
  const { accounts: messagingAccounts = [], isLoading: accountsLoading } = useMessagingAccounts();
  const { data: socialAccounts = [] } = useSocialAccounts();

  // Current platform accounts
  const platformMessagingAccounts = useMemo(() => {
    return messagingAccounts.filter((a) => a.platform === platform);
  }, [messagingAccounts, platform]);

  const platformSocialAccounts = useMemo(() => {
    return socialAccounts.filter((a) => a.platform === platform && a.is_active);
  }, [socialAccounts, platform]);

  const hasConnectedAccounts =
    platform === "threads"
      ? platformSocialAccounts.length > 0
      : platformMessagingAccounts.length > 0;

  return (
    <DashboardLayout>
      <div className="w-full space-y-6 pb-12">
        {/* Unified Upper Header: Title on Left, 3D Platform Selector on Right */}
        <Reveal>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            {/* Left: Title & Status */}
            <div className="flex items-center gap-3.5">
              <Icon3D icon={MessageSquare} variant="indigo" size="md" />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <GradientHeading preset="indigo-cyan" size="lg" as="h1">
                    Unified Inboxes
                  </GradientHeading>
                  <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 gap-1 text-[11px] h-5 py-0">
                    <Radio className="w-2.5 h-2.5 text-emerald-400 animate-pulse" /> Live Multi-Channel
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                  Manage customer conversations, direct messages, and post comments
                </p>
              </div>
            </div>

            {/* Right: Platform Icon Selector Banner & Action Button */}
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {/* Platform Selector Pill Bar */}
              <div
                className="flex items-center gap-1.5 p-1 rounded-2xl bg-card/80 backdrop-blur-xl border border-border/60 shadow-sm"
                role="tablist"
                aria-label="Inbox Channels"
              >
                {INBOX_PLATFORMS.map((p) => {
                  const isSelected = platform === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => handlePlatformChange(p.id)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 cursor-pointer focus:outline-none",
                        isSelected
                          ? "bg-primary text-primary-foreground shadow-md shadow-primary/25 font-bold scale-[1.02]"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      )}
                    >
                      <PlatformIcon platform={p.id} size="sm" className="shrink-0" />
                      <span>{p.label}</span>
                    </button>
                  );
                })}
              </div>

              <Button asChild variant="outline" size="sm" className="h-9 gap-1.5 border-primary/30 hover:bg-primary/10 text-xs">
                <Link to={`/automation/messaging?platform=${platform}`}>
                  <Sparkles className="w-3.5 h-3.5 text-primary" />
                  <span className="hidden sm:inline">Automation</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="indigo" />

        {/* Active Platform Inbox View */}
        <Reveal delay={60}>
          <div className="space-y-4">
            {platform === "whatsapp" && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card/60 backdrop-blur-md border border-border/50 rounded-2xl p-4 shadow-sm">
                  <div>
                    <h3 className="font-bold text-sm sm:text-base text-foreground flex items-center gap-2">
                      <PlatformIcon platform="whatsapp" size="sm" />
                      <span>WhatsApp Business Inbox</span>
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Full conversation management, real-time replies, and automated AI assistance
                    </p>
                  </div>
                  <Button asChild size="sm" className="bg-[#25D366] hover:bg-[#128C7E] text-white shadow-sm gap-1.5">
                    <Link to="/messaging/whatsapp/conversations">
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open Full WhatsApp Studio</span>
                    </Link>
                  </Button>
                </div>

                <MessagingInbox platform="whatsapp" />
              </div>
            )}

            {platform === "facebook" && (
              <div className="space-y-4">
                <MessagingInbox platform="facebook" />
              </div>
            )}

            {platform === "instagram" && (
              <div className="space-y-4">
                <MessagingInbox platform="instagram" />
              </div>
            )}

            {platform === "threads" && (
              <div className="space-y-4">
                <CommentManagerPanel platform="threads" />
              </div>
            )}
          </div>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
