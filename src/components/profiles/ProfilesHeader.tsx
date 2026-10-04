import { useState } from "react";
import { useBetaPlatforms } from "@/hooks/useBetaPlatforms";
import { Info, CheckCircle, Lock, Crown, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { useSubscription } from "@/hooks/useSubscription";
import { useUserRole } from "@/hooks/useUserRole";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Badge } from "@/components/ui/badge";
import { GradientHeading, GradientRingCard, Icon3D, Reveal } from "@/components/fx";
import { platformVariant } from "./platformVariant";
import { cn } from "@/lib/utils";
import type { Platform } from "@/lib/types";

interface ProfilesHeaderProps {
  profileCount: number; // Now represents total connected accounts
  isAdmin: boolean;
}

// Platform access requirements by plan - ONLY TikTok requires Pro+
export type PlatformAccessLevel = "free" | "pro" | "business";

export const PLATFORM_ACCESS_REQUIREMENTS: Record<string, PlatformAccessLevel> = {
  twitter: "free",
  bluesky: "free",
  threads: "free",
  facebook: "free",
  instagram: "free",
  linkedin: "free",
  pinterest: "free",
  tiktok: "pro", // Only TikTok requires Pro/Business
  youtube: "free",
  reddit: "free",
};

export function usePlatformAccess() {
  const { isPro, isBusiness, isFree } = useSubscription();
  const { isAdmin } = useUserRole();

  const hasPaidAccess = isPro || isBusiness || isAdmin;

  const hasPlatformAccess = (platform: string): boolean => {
    const requirement = PLATFORM_ACCESS_REQUIREMENTS[platform] || "free";

    if (isAdmin) return true;
    if (requirement === "free") return true;
    if (requirement === "pro" && (isPro || isBusiness)) return true;
    if (requirement === "business" && isBusiness) return true;

    return false;
  };

  // Check if platform is TikTok and user is free
  const isTikTokRestricted = (platform: string): boolean => {
    return platform === "tiktok" && isFree && !isAdmin;
  };

  return {
    hasPaidAccess,
    isFree,
    isPro,
    isBusiness,
    isAdmin,
    hasPlatformAccess,
    isTikTokRestricted,
  };
}

// Glassmorphism platform card for premium platforms
function PremiumPlatformCard({ platform, name, hasAccess }: { platform: string; name: string; hasAccess: boolean }) {
  const variant = platformVariant(platform as Platform);
  return (
    <GradientRingCard variant={variant} innerClassName="p-5">
      <div className="flex items-center gap-4">
        <Icon3D icon={Sparkles} variant={variant} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold text-primary uppercase tracking-wider">Premium</span>
          </div>
          <div className="flex items-center gap-2">
            <PlatformIcon platform={platform as any} size="md" />
            <h4 className="text-lg font-semibold truncate">{name}</h4>
          </div>
        </div>
        {hasAccess ? (
          <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 gap-1.5 px-3 py-1">
            <CheckCircle className="w-3.5 h-3.5" />
            Access Granted
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1.5 px-3 py-1">
            <Lock className="w-3.5 h-3.5" />
            Pro Required
          </Badge>
        )}
      </div>
    </GradientRingCard>
  );
}

// Glassmorphism platform card for standard/free platforms
function StandardPlatformCard({ platform, name, isBeta }: { platform: string; name: string; isBeta?: boolean }) {
  const variant = platformVariant(platform as Platform);
  return (
    <GradientRingCard variant={variant} padded={false} innerClassName="p-3" hoverLift={false}>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
          <PlatformIcon platform={platform as any} size="sm" />
        </span>
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm truncate block">{name}</span>
        </div>
        {isBeta && (
          <Badge className="bg-amber-500/20 text-amber-500 border-amber-500/30 text-[10px] px-1.5 py-0">
            Beta
          </Badge>
        )}
        <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 gap-1 text-xs px-2 py-0.5">
          <CheckCircle className="w-3 h-3" />
          Access
        </Badge>
      </div>
    </GradientRingCard>
  );
}

export function ProfilesHeader({ profileCount, isAdmin }: ProfilesHeaderProps) {
  const { hasPaidAccess, hasPlatformAccess, isFree } = usePlatformAccess();
  const { flags } = useFeatureFlags();
  const { betaPlatforms } = useBetaPlatforms();
  const [showStandardPlatforms, setShowStandardPlatforms] = useState(false);

  // Only TikTok requires Pro+ access
  const proPlatforms = [
    { platform: "tiktok", name: "TikTok" },
  ];

  // All other platforms are free
  const freePlatforms = [
    { platform: "twitter", name: "X (Twitter)" },
    { platform: "bluesky", name: "Bluesky" },
    { platform: "threads", name: "Threads" },
    { platform: "youtube", name: "YouTube" },
    { platform: "instagram", name: "Instagram" },
    { platform: "facebook", name: "Facebook" },
    { platform: "linkedin", name: "LinkedIn" },
    { platform: "pinterest", name: "Pinterest" },
    { platform: "reddit", name: "Reddit" },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <GradientHeading as="h1" preset="violet-sky" size="lg">Account Management</GradientHeading>
        <p className="text-muted-foreground mt-1">
          Connect and manage your social media accounts across platforms. Each connected account can be used to publish content via the API or dashboard.
        </p>
      </div>

      {/* Info Boxes */}
      <div className="space-y-4">
        <GradientRingCard variant="sky" innerClassName="p-4">
          <div className="flex items-start gap-3">
            <Icon3D icon={Info} variant="sky" size="sm" />
            <p className="text-sm text-muted-foreground self-center">
              Want to let your own users connect their social media accounts? Check out the{" "}
              <a href="https://postora.cloud/docs" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                profile API integration guide
              </a>
              . You can test it below with the Share button.
            </p>
          </div>
        </GradientRingCard>

        {/* Platform Access Overview — Glassmorphism */}
        {flags.platformAccess && (
          <GradientRingCard variant="violet" innerClassName="p-6 space-y-6 overflow-hidden">
            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Icon3D icon={Crown} variant="violet" size="md" />
                <div>
                  <h3 className="font-semibold text-lg">Platform Access</h3>
                  <p className="text-xs text-muted-foreground">Manage your connected platform permissions</p>
                </div>
              </div>
              {hasPaidAccess ? (
                <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 gap-1.5 px-3 py-1">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Full Access
                </Badge>
              ) : (
                <a href="/pricing" className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 bg-primary/10 hover:bg-primary/15 border border-primary/20 rounded-lg px-3 py-1.5 transition-all">
                  <Crown className="w-3.5 h-3.5" />
                  Upgrade to Pro
                </a>
              )}
            </div>

            {isFree && (
              <p className="relative text-sm text-muted-foreground bg-card/60 rounded-lg p-3 border border-border/60">
                All platforms are free except TikTok. Upgrade to Pro or Business to unlock TikTok posting.
              </p>
            )}

            {/* Premium Platforms */}
            <div className="relative space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Premium Platforms</p>
              {proPlatforms.map(({ platform, name }, i) => (
                <Reveal key={platform} delay={i * 60}>
                  <PremiumPlatformCard
                    platform={platform}
                    name={name}
                    hasAccess={hasPlatformAccess(platform)}
                  />
                </Reveal>
              ))}
            </div>

            {/* Standard Platforms */}
            {flags.freePlatforms && (
              <div className="relative space-y-3">
                <button
                  onClick={() => setShowStandardPlatforms(!showStandardPlatforms)}
                  className="w-full flex items-center justify-between rounded-xl border border-border/60 bg-card px-4 py-3 hover:bg-card hover:-translate-y-0.5 transition-all duration-300 group"
                >
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Standard Platforms</p>
                    <span className="text-[10px] font-medium bg-muted text-muted-foreground border border-border/60 rounded-full px-2 py-0.5">
                      {freePlatforms.length}
                    </span>
                  </div>
                  {showStandardPlatforms ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
                </button>
                {showStandardPlatforms && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {freePlatforms.map(({ platform, name }, i) => (
                      <Reveal key={platform} delay={i * 50}>
                        <StandardPlatformCard
                          platform={platform}
                          name={name}
                          isBeta={!!betaPlatforms[platform]}
                        />
                      </Reveal>
                    ))}
                  </div>
                )}
              </div>
            )}
          </GradientRingCard>
        )}
      </div>
    </div>
  );
}
