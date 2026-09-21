import { Youtube, Settings2 } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";

interface PlatformSetting {
  code: string;
  type: string;
}

interface PlatformConfig {
  name: string;
  icon: React.ReactNode;
  bgClass: string;
  settings: PlatformSetting[];
  variant?: GradientKey;
}

const platforms: PlatformConfig[] = [
  {
    name: "YouTube",
    icon: <Youtube className="w-5 h-5 text-red-500" />,
    bgClass: "bg-gradient-to-br from-rose-400/20 to-pink-500/20",
    variant: "rose",
    settings: [
      { code: "youtube_privacy", type: "private | unlisted | public" },
      { code: "youtube_title", type: "string" },
      { code: "youtube_description", type: "string" },
      { code: "youtube_tags", type: "string[]" },
    ],
  },
  {
    name: "TikTok",
    icon: <span className="text-white text-lg">♪</span>,
    bgClass: "bg-gradient-to-br from-rose-500 via-fuchsia-500 to-cyan-500",
    variant: "rose",
    settings: [
      { code: "tiktok_title", type: "string (100 chars, optional)" },
      { code: "tiktok_privacy_level", type: "PUBLIC | FRIENDS | SELF_ONLY" },
      { code: "tiktok_disable_comment", type: "boolean" },
      { code: "tiktok_disable_duet", type: "boolean" },
      { code: "tiktok_disable_stitch", type: "boolean" },
      { code: "tiktok_brand_content_toggle", type: "boolean" },
    ],
  },
  {
    name: "Instagram",
    icon: <span className="text-white text-lg">📷</span>,
    bgClass: "bg-gradient-to-br from-amber-400 via-rose-500 to-fuchsia-500",
    variant: "rose",
    settings: [
      { code: "instagram_collaborators", type: "string[]" },
      { code: "instagram_location_id", type: "string" },
      { code: "instagram_share_to_feed", type: "boolean" },
    ],
  },
  {
    name: "Facebook",
    icon: <span className="text-white text-lg">f</span>,
    bgClass: "bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-500",
    variant: "sky",
    settings: [
      { code: "facebook_page_id", type: "string" },
      { code: "facebook_media_type", type: "REELS | STORIES" },
    ],
  },
  {
    name: "Pinterest",
    icon: <span className="text-white text-lg">📌</span>,
    bgClass: "bg-gradient-to-br from-rose-500 to-red-600",
    variant: "rose",
    settings: [
      { code: "pinterest_board_id", type: "string" },
      { code: "pinterest_title", type: "string" },
      { code: "pinterest_link", type: "string (URL)" },
    ],
  },
  {
    name: "LinkedIn",
    icon: <span className="text-white text-lg">in</span>,
    bgClass: "bg-gradient-to-br from-sky-500 via-blue-600 to-indigo-600",
    variant: "sky",
    settings: [
      { code: "linkedin_destination_ids", type: "string[]" },
      { code: "linkedin_page_id", type: "string (deprecated)" },
      { code: "linkedin_article_url", type: "string (URL)" },
    ],
  },
];

export function PlatformSettingsCards() {
  return (
    <section className="container mx-auto px-6 py-20 border-t border-border/40">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Settings2} variant="violet" size="md" />
          <GradientHeading as="h2" preset="violet-sky" size="lg">Platform-Specific Settings</GradientHeading>
          <p className="text-muted-foreground max-w-2xl">
            Each platform supports additional configuration options in your API requests.
          </p>
        </div>
      </Reveal>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {platforms.map((platform, idx) => (
          <Reveal key={platform.name} delay={(idx % 3) * 80}>
            <GradientRingCard variant={platform.variant || "violet"} ringIntensity="subtle">
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-11 h-11 rounded-xl ${platform.bgClass} flex items-center justify-center shadow-md ring-1 ring-white/30 relative overflow-hidden`}>
                  <span aria-hidden className="pointer-events-none absolute inset-x-1 top-1 h-1/2 rounded-t-xl bg-gradient-to-b from-white/40 to-transparent" />
                  <span className="relative drop-shadow">{platform.icon}</span>
                </div>
                <h3 className="font-semibold">{platform.name}</h3>
              </div>
              <div className="space-y-2 text-sm">
                {platform.settings.map((setting) => (
                  <div key={setting.code} className="flex justify-between gap-3 border-b border-border/40 last:border-b-0 py-1.5">
                    <code className="text-primary truncate">{setting.code}</code>
                    <span className="text-muted-foreground text-end">{setting.type}</span>
                  </div>
                ))}
              </div>
            </GradientRingCard>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
