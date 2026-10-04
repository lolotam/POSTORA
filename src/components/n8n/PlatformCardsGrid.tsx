import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { GradientRingCard, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";

export interface PlatformCardConfig {
  id: string;
  name: string;
  description: string;
  href: string;
  emoji: string;
  bgClass: string;
  borderClass: string;
  hoverBorderClass: string;
  iconBgClass: string;
  variant?: GradientKey;
}

export const n8nPlatformCards: PlatformCardConfig[] = [
  {
    id: "instagram",
    name: "Instagram API",
    description: "Reels, Stories, Carousels",
    href: "/n8n/instagram",
    emoji: "📸",
    bgClass: "bg-muted",
    borderClass: "border-border",
    hoverBorderClass: "hover:border-input",
    iconBgClass: "bg-amber-400",
    variant: "rose",
  },
  {
    id: "facebook",
    name: "Facebook API",
    description: "Posts, Reels, Stories",
    href: "/n8n/facebook",
    emoji: "📘",
    bgClass: "bg-blue-600/10",
    borderClass: "border-blue-500/30",
    hoverBorderClass: "hover:border-blue-500/50",
    iconBgClass: "bg-neutral-900 dark:bg-neutral-800",
    variant: "sky",
  },
  {
    id: "tiktok",
    name: "TikTok API",
    description: "Videos, Photo Carousels",
    href: "/n8n/tiktok",
    emoji: "🎵",
    bgClass: "bg-muted",
    borderClass: "border-border",
    hoverBorderClass: "hover:border-input",
    iconBgClass: "bg-rose-500",
    variant: "rose",
  },
  {
    id: "youtube",
    name: "YouTube API",
    description: "Videos, Shorts",
    href: "/n8n/youtube",
    emoji: "▶️",
    bgClass: "bg-red-600/10",
    borderClass: "border-red-500/30",
    hoverBorderClass: "hover:border-red-500/50",
    iconBgClass: "bg-rose-400",
    variant: "rose",
  },
  {
    id: "twitter",
    name: "Twitter/X API",
    description: "Tweets, Replies, Threads",
    href: "/n8n/twitter",
    emoji: "𝕏",
    bgClass: "bg-gray-800/10",
    borderClass: "border-gray-500/30",
    hoverBorderClass: "hover:border-gray-500/50",
    iconBgClass: "bg-neutral-900 dark:bg-neutral-800",
    variant: "indigo",
  },
  {
    id: "linkedin",
    name: "LinkedIn API",
    description: "Posts, Articles, Videos",
    href: "/n8n/linkedin",
    emoji: "🔗",
    bgClass: "bg-blue-600/10",
    borderClass: "border-blue-500/30",
    hoverBorderClass: "hover:border-blue-500/50",
    iconBgClass: "bg-neutral-900 dark:bg-neutral-800",
    variant: "sky",
  },
  {
    id: "pinterest",
    name: "Pinterest API",
    description: "Pins, Video Pins",
    href: "/n8n/pinterest",
    emoji: "📌",
    bgClass: "bg-red-500/10",
    borderClass: "border-red-400/30",
    hoverBorderClass: "hover:border-red-400/50",
    iconBgClass: "bg-rose-400",
    variant: "rose",
  },
  {
    id: "threads",
    name: "Threads API",
    description: "Text, Images, Carousels",
    href: "/n8n/threads",
    emoji: "@",
    bgClass: "bg-gray-900/10",
    borderClass: "border-gray-500/30",
    hoverBorderClass: "hover:border-gray-500/50",
    iconBgClass: "bg-neutral-900 dark:bg-neutral-800",
    variant: "indigo",
  },
  {
    id: "bluesky",
    name: "Bluesky API",
    description: "Posts, Images, Links",
    href: "/n8n/bluesky",
    emoji: "🦋",
    bgClass: "bg-muted",
    borderClass: "border-border",
    hoverBorderClass: "hover:border-input",
    iconBgClass: "bg-cyan-400",
    variant: "cyan",
  },
  {
    id: "reddit",
    name: "Reddit API",
    description: "Text, Link, Image Posts",
    href: "/n8n/reddit",
    emoji: "🤖",
    bgClass: "bg-orange-500/10",
    borderClass: "border-orange-500/30",
    hoverBorderClass: "hover:border-orange-500/50",
    iconBgClass: "bg-amber-400",
    variant: "amber",
  },
  {
    id: "remove-background",
    name: "Remove Background",
    description: "AI Background Removal",
    href: "/n8n/remove-background",
    emoji: "🎭",
    bgClass: "bg-muted",
    borderClass: "border-border",
    hoverBorderClass: "hover:border-input",
    iconBgClass: "bg-neutral-900 dark:bg-neutral-800",
    variant: "violet",
  },
  {
    id: "upscale",
    name: "Upscale Image",
    description: "AI Image Upscaling",
    href: "/n8n/upscale",
    emoji: "🔍",
    bgClass: "bg-emerald-500/10",
    borderClass: "border-emerald-500/30",
    hoverBorderClass: "hover:border-emerald-500/50",
    iconBgClass: "bg-cyan-400",
    variant: "cyan",
  },
];

interface PlatformCardsGridProps {
  cards?: PlatformCardConfig[];
}

export function PlatformCardsGrid({ cards = n8nPlatformCards }: PlatformCardsGridProps) {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {cards.map((card, idx) => (
        <Reveal key={card.id} delay={(idx % 4) * 60}>
          <Link to={card.href} className="block h-full">
            <GradientRingCard variant={card.variant || "violet"} ringIntensity="normal">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-2xl ${card.iconBgClass} flex items-center justify-center shadow-lg ring-1 ring-white/30 relative overflow-hidden`}>
                  <span aria-hidden className="pointer-events-none absolute inset-x-1 top-1 h-1/2 rounded-t-2xl bg-gradient-to-b from-white/40 to-transparent" />
                  <span className="relative text-white text-2xl drop-shadow-md">{card.emoji}</span>
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold truncate">{card.name}</h3>
                  <p className="text-sm text-muted-foreground truncate">{card.description}</p>
                </div>
              </div>
              <div className="mt-5 flex items-center text-sm font-medium text-foreground">
                View Documentation
                <ChevronRight className="w-4 h-4 ms-1 text-foreground" />
              </div>
            </GradientRingCard>
          </Link>
        </Reveal>
      ))}
    </div>
  );
}
