import type { Platform } from "@/lib/types";
import type { GradientKey, HeadingPreset } from "@/components/fx";

export const platformVariant = (platform: Platform): GradientKey => {
  switch (platform) {
    case "facebook":
    case "linkedin":
      return "sky";
    case "instagram":
    case "tiktok":
    case "youtube":
    case "pinterest":
      return "rose";
    case "threads":
      return "violet";
    case "twitter":
    case "bluesky":
      return "cyan";
    case "reddit":
      return "amber";
    case "whatsapp":
      return "emerald";
    default:
      return "violet";
  }
};

export const platformHeadingPreset = (platform: Platform): HeadingPreset => {
  switch (platform) {
    case "facebook":
    case "linkedin":
    case "twitter":
    case "bluesky":
      return "sky-violet";
    case "threads":
      return "violet-sky";
    case "whatsapp":
      return "emerald-cyan-sky";
    default:
      return "amber-rose-violet";
  }
};

/**
 * Static Tailwind class strings for the active-state gradient on a platform tab.
 * Strings are written in full so Tailwind JIT can pick them up.
 */
export const PLATFORM_TAB_ACTIVE: Record<GradientKey, string> = {
  sky:     "data-[state=active]:from-sky-400 data-[state=active]:via-blue-500 data-[state=active]:to-indigo-500 data-[state=active]:shadow-sky-500/40",
  violet:  "data-[state=active]:from-violet-500 data-[state=active]:via-fuchsia-500 data-[state=active]:to-pink-500 data-[state=active]:shadow-violet-500/40",
  emerald: "data-[state=active]:from-emerald-400 data-[state=active]:via-teal-400 data-[state=active]:to-cyan-500 data-[state=active]:shadow-emerald-500/40",
  amber:   "data-[state=active]:from-amber-400 data-[state=active]:via-orange-400 data-[state=active]:to-rose-400 data-[state=active]:shadow-amber-500/40",
  rose:    "data-[state=active]:from-rose-400 data-[state=active]:via-pink-500 data-[state=active]:to-fuchsia-500 data-[state=active]:shadow-rose-500/40",
  indigo:  "data-[state=active]:from-indigo-500 data-[state=active]:via-violet-500 data-[state=active]:to-purple-500 data-[state=active]:shadow-indigo-500/40",
  cyan:    "data-[state=active]:from-cyan-400 data-[state=active]:via-sky-500 data-[state=active]:to-blue-500 data-[state=active]:shadow-cyan-500/40",
  tiktok:  "data-[state=active]:from-tiktok-cyan data-[state=active]:via-black data-[state=active]:to-tiktok-red data-[state=active]:shadow-tiktok-red/40",
};

