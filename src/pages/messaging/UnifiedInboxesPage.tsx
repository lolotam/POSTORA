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

            {/* Right: Platform Square 3D Icon Selector & Action Button */}
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {/* Platform Selector Square 3D Bar */}
              <div
                className="flex items-center gap-2.5 p-1.5 rounded-2xl bg-card border border-border/80 shadow-sm"
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
                      title={`${p.label} - ${p.subLabel}`}
                      className={cn(
                        "relative w-13 h-13 sm:w-15 sm:h-15 md:w-16 md:h-16 rounded-2xl flex flex-col items-center justify-center border transition-all duration-300 cursor-pointer group focus:outline-none overflow-visible",
                        // 3D glass specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl before:bg-gradient-to-b before:from-white/35 before:via-white/10 before:to-transparent before:pointer-events-none",
                        isSelected
                          ? "bg-gradient-to-b from-primary/20 via-card to-card border-primary ring-2 ring-primary/40 shadow-[0_10px_20px_-4px_rgba(var(--primary-rgb,59,130,246),0.4),inset_0_1.5px_2px_rgba(255,255,255,0.8)] -translate-y-1 scale-105"
                          : "bg-secondary/80 hover:bg-secondary border-border/60 shadow-md hover:border-primary/50 hover:shadow-xl hover:scale-110 hover:-translate-y-1"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="xl"
                        className="drop-shadow-[0_4px_6px_rgba(0,0,0,0.25)] transition-transform duration-300 group-hover:scale-110"
                      />
                      {isSelected && (
                        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md ring-2 ring-background animate-in zoom-in-50 duration-200">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <Button asChild variant="outline" size="sm" className="h-10 gap-1.5 border-primary/30 hover:bg-primary/10 text-xs">
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
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-card border border-border/80 rounded-2xl p-4 shadow-sm">
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
