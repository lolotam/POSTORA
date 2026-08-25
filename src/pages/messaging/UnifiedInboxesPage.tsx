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
      navigate("/messaging/whatsapp/conversations");
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
        {/* Main Upper Header */}
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Icon3D icon={MessageSquare} variant="indigo" size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="indigo-cyan" size="lg" as="h1">
                    Unified Inboxes
                  </GradientHeading>
                  <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 gap-1 text-xs">
                    <Radio className="w-3 h-3 text-emerald-400 animate-pulse" /> Live Multi-Channel Inbox
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Manage incoming customer conversations, direct messages, and post comments across all your connected channels
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button asChild variant="outline" size="sm" className="gap-2 border-primary/30 hover:bg-primary/10">
                <Link to={`/automation/messaging?platform=${platform}`}>
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span>Messaging Automation</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </Button>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="indigo" />

        {/* Secondary Header: Centered 3D Glossy Provider Cards */}
        <Reveal delay={30}>
          <div className="flex flex-col items-center space-y-4 py-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Select Inbox Channel
            </span>

            <div
              className="flex items-center justify-center gap-4 sm:gap-6 md:gap-8 flex-wrap"
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
                      "flex flex-col items-center gap-2.5 flex-shrink-0 transition-all duration-300 hover:scale-105 hover:-translate-y-1.5 cursor-pointer group focus:outline-none"
                    )}
                  >
                    <div
                      className={cn(
                        "relative w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-2xl sm:rounded-3xl backdrop-blur-2xl flex items-center justify-center border transition-all duration-300 overflow-visible",
                        // Ultra glossy 3D glass refraction and specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl sm:before:rounded-t-3xl before:bg-gradient-to-b before:from-white/40 before:via-white/15 before:to-transparent before:pointer-events-none",
                        isSelected
                          ? "bg-gradient-to-b from-primary/25 via-card/85 to-card/60 border-primary ring-4 ring-primary/40 shadow-[0_20px_40px_-8px_rgba(var(--primary-rgb,59,130,246),0.5),0_8px_16px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.9),inset_0_-3px_6px_rgba(0,0,0,0.25)] -translate-y-1.5 scale-105"
                          : "bg-gradient-to-b from-card/95 via-card/75 to-card/55 border-border/70 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.35),0_4px_10px_-2px_rgba(0,0,0,0.2),inset_0_1.5px_2px_rgba(255,255,255,0.7),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:border-primary/60 hover:shadow-[0_18px_36px_-8px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.9)]"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="2xl"
                        className="drop-shadow-[0_8px_10px_rgba(0,0,0,0.3)] transition-transform duration-300 group-hover:scale-110"
                      />
                      {isSelected && (
                        <div className="absolute -top-2 -right-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/50 ring-2 ring-background animate-in zoom-in-50 duration-200">
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
                      <span className="text-[10px] text-muted-foreground hidden sm:block">
                        {p.subLabel}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

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
