import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, BadgeCheck, Camera, AtSign, Facebook, Video, Instagram } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCountUp } from "@/hooks/useCountUp";
import type { BrandProfile } from "@/types/brand-intelligence";

interface ProfileCardProps {
  profile: BrandProfile;
  isLoading: boolean;
}

function StatItem({ label, value, emoji }: { label: string; value: number; emoji: string }) {
  const animated = useCountUp(value);
  return (
    <div className="text-center">
      <p className="text-lg font-bold">{emoji} {animated.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

const platformConfig: Record<string, { icon: typeof Camera; label: string; profileUrl: (u: string) => string }> = {
  instagram: { icon: Camera, label: "Instagram", profileUrl: (u) => `https://www.instagram.com/${u}/` },
  threads: { icon: AtSign, label: "Threads", profileUrl: (u) => `https://www.threads.net/@${u}` },
  facebook: { icon: Facebook, label: "Facebook", profileUrl: (u) => `https://www.facebook.com/${u}` },
  tiktok: { icon: Video, label: "TikTok", profileUrl: (u) => `https://www.tiktok.com/@${u}` },
};

function PlatformLogoButton({
  href,
  label,
  kind,
}: {
  href: string;
  label: string;
  kind: "threads" | "instagram";
}) {
  const isThreads = kind === "threads";
  const Icon = isThreads ? AtSign : Instagram;
  const gradient = isThreads
    ? "bg-zinc-800"
    : "bg-[radial-gradient(circle_at_30%_110%,#fdf497_0%,#fdf497_5%,#fd5949_45%,#d6249f_60%,#285AEB_90%)]";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          className={`relative inline-flex items-center justify-center w-9 h-9 rounded-full ${gradient} text-white shadow-md ring-1 ring-white/15 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-xl hover:brightness-110 active:translate-y-0 active:shadow-md overflow-hidden`}
        >
          <span className="absolute inset-0 rounded-full bg-gradient-to-b from-white/25 via-transparent to-transparent pointer-events-none" />
          <Icon className="w-4 h-4 relative z-10" strokeWidth={2.25} />
        </a>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ProfileCard({ profile, isLoading }: ProfileCardProps) {
  const { t } = useTranslation("analytics");
  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center gap-4">
            <Skeleton className="w-20 h-20 rounded-full" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
          <div className="flex justify-around">
            <Skeleton className="h-12 w-20" />
            <Skeleton className="h-12 w-20" />
            <Skeleton className="h-12 w-20" />
          </div>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!profile) return null;

  const initials = profile.fullName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const config = platformConfig[profile.platform] || platformConfig.instagram;
  const PlatformIcon = config.icon;

  return (
    <Card className="overflow-hidden animate-[fadeSlideDown_0.5s_ease-out] relative border-0 bg-muted">
      <div className="absolute inset-0 rounded-lg border border-border" />
      <CardContent className="p-6 relative">
        <Badge variant="secondary" className="absolute top-4 end-4 gap-1">
          <PlatformIcon className="w-3 h-3" />
          {profile.platform === "instagram" ? t("brand.instagram", "Instagram")
            : profile.platform === "threads" ? t("brand.threads", "Threads")
            : profile.platform === "facebook" ? t("brand.facebook", "Facebook")
            : t("brand.tiktok", "TikTok")}
        </Badge>

        <div className="flex items-center gap-4 mb-4">
          <div className="relative">
            <Avatar className="w-20 h-20 border-2 border-border">
              <AvatarImage
                src={profile.avatarUrl}
                alt={profile.username}
                referrerPolicy="no-referrer"
              />
              <AvatarFallback className="text-lg text-primary-foreground bg-neutral-900 dark:bg-neutral-800">
                {initials}
              </AvatarFallback>
            </Avatar>
            {profile.isVerified && (
              <BadgeCheck className="absolute -bottom-1 -end-1 w-6 h-6 text-primary fill-primary" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-lg truncate">{profile.fullName}</h3>
            <p className="text-sm text-muted-foreground">@{profile.username}</p>
          </div>
        </div>

        <div className="flex justify-around py-3 border-y border-border/50 mb-4 flex-wrap gap-2">
          <StatItem label={t("profile.followers", "Followers")} value={profile.followersCount} emoji="👥" />
          <StatItem label={t("profile.following", "Following")} value={profile.followingCount} emoji="👤" />
          <StatItem label={t("profile.posts", "Posts")} value={profile.postsCount} emoji="📝" />
          {profile.platform === "tiktok" && typeof profile.totalHearts === "number" && (
            <StatItem label={t("profile.hearts", "Hearts")} value={profile.totalHearts} emoji="❤️" />
          )}
        </div>

        {profile.bio && (
          <p className="text-sm text-muted-foreground line-clamp-3 mb-3">{profile.bio}</p>
        )}

        <div className="flex items-center gap-2">
          {profile.website && (
            <Button variant="outline" size="sm" asChild>
              <a href={profile.website} target="_blank" rel="noopener noreferrer">
                {t("profile.website", "🔗 Website")}
              </a>
            </Button>
          )}
          {profile.platform === "threads" ? (
            <TooltipProvider delayDuration={150}>
              <div className="flex items-center gap-2">
                <PlatformLogoButton
                  href={`https://www.threads.net/@${profile.username}`}
                  label={t("profile.openThreads", "Open on Threads")}
                  kind="threads"
                />
                <PlatformLogoButton
                  href={`https://www.instagram.com/${profile.username}/`}
                  label={t("profile.openInstagram", "Open on Instagram")}
                  kind="instagram"
                />
              </div>
            </TooltipProvider>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <a
                href={config.profileUrl(profile.username)}
                target="_blank"
                rel="noopener noreferrer"
                className="gap-1"
              >
                {t("profile.viewProfile", "View Profile")} <ExternalLink className="w-3 h-3" />
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
