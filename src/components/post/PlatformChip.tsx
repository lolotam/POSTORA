import { forwardRef, ReactNode } from "react";
import { TabsTrigger } from "@/components/ui/tabs";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Per-platform brand gradient classes for the 3D chip surface.
 * Uses semantic tokens (`brand-<platform>` / `brand-<platform>-dark`) from
 * tailwind.config.ts so both light and dark themes stay correct.
 *
 * Instagram is the exception — it uses a multi-stop gradient that matches
 * the IG identity (purple → pink → orange).
 */
const brandGradients: Record<Platform, string> = {
  facebook: "bg-gradient-to-br from-brand-facebook to-brand-facebook-dark",
  instagram:
    "bg-[linear-gradient(135deg,#f9ce34_0%,#ee2a7b_45%,#6228d7_100%)]",
  tiktok: "bg-gradient-to-br from-brand-tiktok to-brand-tiktok-dark",
  twitter: "bg-gradient-to-br from-brand-twitter to-brand-twitter-dark",
  linkedin: "bg-gradient-to-br from-brand-linkedin to-brand-linkedin-dark",
  youtube: "bg-gradient-to-br from-brand-youtube to-brand-youtube-dark",
  pinterest: "bg-gradient-to-br from-brand-pinterest to-brand-pinterest-dark",
  threads: "bg-gradient-to-br from-brand-threads to-brand-threads-dark",
  bluesky: "bg-gradient-to-br from-brand-bluesky to-brand-bluesky-dark",
  reddit: "bg-gradient-to-br from-brand-reddit to-brand-reddit-dark",
  whatsapp: "bg-gradient-to-br from-brand-whatsapp to-brand-whatsapp-dark",
};

interface PlatformChipProps {
  platform: Platform;
  value: string;
  /** Optional content rendered below the chip (e.g. LinkedIn destination stack). */
  children?: ReactNode;
}

/**
 * 3D, brand-colored Tabs trigger for the Platform-specific Settings selector.
 *
 * Layout:
 *   ┌────────────┐
 *   │   [icon]   │  ← chip (brand gradient, layered highlight + shadow)
 *   └────────────┘
 *      Label       ← full platform name, never truncated
 *      [children]  ← optional (LinkedIn destination avatars)
 */
export const PlatformChip = forwardRef<HTMLDivElement, PlatformChipProps>(
  ({ platform, value, children }, ref) => {
    return (
      <div ref={ref} className="flex flex-col items-center gap-1.5">
        <TabsTrigger
          value={value}
          aria-label={getPlatformName(platform)}
          className={cn(
            // Reset shadcn defaults so the chip can render its own surface.
            "relative overflow-hidden p-0 w-14 h-14 sm:w-16 sm:h-16 rounded-2xl",
            "border border-white/10 text-primary-foreground",
            "transition-all duration-200 ease-out",
            // 3D shadow + lift on hover
            "shadow-[0_8px_18px_-8px_hsl(var(--foreground)/0.45),inset_0_1px_0_0_hsl(0_0%_100%/0.25)]",
            "hover:-translate-y-0.5 hover:shadow-[0_14px_28px_-10px_hsl(var(--foreground)/0.55),inset_0_1px_0_0_hsl(0_0%_100%/0.3)]",
            // Top glossy highlight
            "before:pointer-events-none before:absolute before:inset-x-2 before:top-1 before:h-1/3 before:rounded-t-xl before:bg-white/25 before:blur-sm",
            // Bottom inset shadow for depth
            "after:pointer-events-none after:absolute after:inset-x-3 after:bottom-1 after:h-1 after:rounded-full after:bg-black/30 after:blur-md",
            // Selected state
            "data-[state=active]:scale-105 data-[state=active]:ring-2 data-[state=active]:ring-primary data-[state=active]:ring-offset-2 data-[state=active]:ring-offset-background",
            // Brand surface
            brandGradients[platform]
          )}
        >
          <span className="relative z-10 flex items-center justify-center w-full h-full">
            <PlatformIcon
              platform={platform}
              size="lg"
              className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
            />
          </span>
        </TabsTrigger>
        <span className="text-[11px] font-medium text-foreground leading-none">
          {getPlatformName(platform)}
        </span>
        {children}
      </div>
    );
  }
);
PlatformChip.displayName = "PlatformChip";
