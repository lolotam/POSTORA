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
    bgClass: "bg-gradient-to-br from-purple-500/10 via-pink-500/10 to-orange-400/10",
    borderClass: "border-pink-500/30",
    hoverBorderClass: "hover:border-pink-500/50",
    iconBgClass: "bg-gradient-to-br from-amber-400 via-rose-500 to-fuchsia-500",
    variant: "rose",
  },
  {
    id: "facebook",
    name: "Facebook API",
    description: "Posts, Reels, Stories",
    href: "/n8n/facebook",
    emoji: "📘",
    bgClass: "bg-gradient-to-br from-blue-600/10 to-blue-400/10",
    borderClass: "border-blue-500/30",
    hoverBorderClass: "hover:border-blue-500/50",
    iconBgClass: "bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-500",
    variant: "sky",
  },
  {
    id: "tiktok",
    name: "TikTok API",
    description: "Videos, Photo Carousels",
    href: "/n8n/tiktok",
    emoji: "🎵",
    bgClass: "bg-gradient-to-br from-pink-500/10 via-red-500/10 to-cyan-400/10",
    borderClass: "border-pink-500/30",
    hoverBorderClass: "hover:border-pink-500/50",
    iconBgClass: "bg-gradient-to-br from-rose-500 via-fuchsia-500 to-cyan-500",
    variant: "rose",
  },
  {
    id: "youtube",
    name: "YouTube API",
    description: "Videos, Shorts",
    href: "/n8n/youtube",
    emoji: "▶️",
    bgClass: "bg-gradient-to-br from-red-600/10 to-red-400/10",
    borderClass: "border-red-500/30",
    hoverBorderClass: "hover:border-red-500/50",
    iconBgClass: "bg-gradient-to-br from-rose-400 via-pink-500 to-fuchsia-500",
    variant: "rose",
  },
  {
    id: "twitter",
    name: "Twitter/X API",
    description: "Tweets, Replies, Threads",
    href: "/n8n/twitter",
    emoji: "𝕏",
    bgClass: "bg-gradient-to-br from-gray-800/10 to-black/10",
    borderClass: "border-gray-500/30",
    hoverBorderClass: "hover:border-gray-500/50",
    iconBgClass: "bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-500",
    variant: "indigo",
  },
  {
    id: "linkedin",
    name: "LinkedIn API",
    description: "Posts, Articles, Videos",
    href: "/n8n/linkedin",
    emoji: "🔗",
    bgClass: "bg-gradient-to-br from-blue-600/10 to-blue-400/10",
    borderClass: "border-blue-500/30",
    hoverBorderClass: "hover:border-blue-500/50",
    iconBgClass: "bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-500",
    variant: "sky",
  },
  {
    id: "pinterest",
    name: "Pinterest API",
    description: "Pins, Video Pins",
    href: "/n8n/pinterest",
    emoji: "📌",
    bgClass: "bg-gradient-to-br from-red-500/10 to-red-300/10",
    borderClass: "border-red-400/30",
    hoverBorderClass: "hover:border-red-400/50",
    iconBgClass: "bg-gradient-to-br from-rose-400 via-pink-500 to-fuchsia-500",
    variant: "rose",
  },
  {
    id: "threads",
    name: "Threads API",
    description: "Text, Images, Carousels",
    href: "/n8n/threads",
    emoji: "@",
    bgClass: "bg-gradient-to-br from-gray-900/10 to-black/10",
    borderClass: "border-gray-500/30",
    hoverBorderClass: "hover:border-gray-500/50",
    iconBgClass: "bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-500",
    variant: "indigo",
  },
  {
    id: "bluesky",
    name: "Bluesky API",
    description: "Posts, Images, Links",
    href: "/n8n/bluesky",
    emoji: "🦋",
    bgClass: "bg-gradient-to-br from-sky-500/10 to-blue-400/10",
    borderClass: "border-sky-500/30",
    hoverBorderClass: "hover:border-sky-500/50",
    iconBgClass: "bg-gradient-to-br from-cyan-400 via-sky-500 to-blue-500",
    variant: "cyan",
  },
  {
    id: "reddit",
    name: "Reddit API",
    description: "Text, Link, Image Posts",
    href: "/n8n/reddit",
    emoji: "🤖",
    bgClass: "bg-gradient-to-br from-orange-500/10 to-orange-400/10",
    borderClass: "border-orange-500/30",
    hoverBorderClass: "hover:border-orange-500/50",
    iconBgClass: "bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500",
    variant: "amber",
  },
  {
    id: "remove-background",
    name: "Remove Background",
    description: "AI Background Removal",
    href: "/n8n/remove-background",
    emoji: "🎭",
    bgClass: "bg-gradient-to-br from-violet-500/10 to-purple-400/10",
    borderClass: "border-violet-500/30",
    hoverBorderClass: "hover:border-violet-500/50",
    iconBgClass: "bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500",
    variant: "violet",
  },
  {
    id: "upscale",
    name: "Upscale Image",
    description: "AI Image Upscaling",
    href: "/n8n/upscale",
    emoji: "🔍",
    bgClass: "bg-gradient-to-br from-emerald-500/10 to-teal-400/10",
    borderClass: "border-emerald-500/30",
    hoverBorderClass: "hover:border-emerald-500/50",
    iconBgClass: "bg-gradient-to-br from-cyan-400 via-sky-500 to-blue-500",
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
              <div className="mt-5 flex items-center text-sm font-medium bg-clip-text text-transparent bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500">
                View Documentation
                <ChevronRight className="w-4 h-4 ms-1 text-fuchsia-500" />
              </div>
            </GradientRingCard>
          </Link>
        </Reveal>
      ))}
    </div>
  );
}
