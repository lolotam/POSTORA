import type { LucideIcon } from "lucide-react";

export type GradientKey =
  | "sky"
  | "violet"
  | "emerald"
  | "amber"
  | "rose"
  | "indigo"
  | "cyan"
  | "tiktok";

export const GRADIENTS: Record<
  GradientKey,
  { from: string; via: string; to: string; shadow: string; ringText: string }
> = {
  sky:     { from: "from-sky-400",     via: "via-blue-500",    to: "to-indigo-500",  shadow: "shadow-sky-500/40",     ringText: "text-sky-500" },
  violet:  { from: "from-violet-500",  via: "via-fuchsia-500", to: "to-pink-500",    shadow: "shadow-violet-500/40",  ringText: "text-violet-500" },
  emerald: { from: "from-emerald-400", via: "via-teal-400",    to: "to-cyan-500",    shadow: "shadow-emerald-500/40", ringText: "text-emerald-500" },
  amber:   { from: "from-amber-400",   via: "via-orange-400",  to: "to-rose-400",    shadow: "shadow-amber-500/40",   ringText: "text-amber-500" },
  rose:    { from: "from-rose-400",    via: "via-pink-500",    to: "to-fuchsia-500", shadow: "shadow-rose-500/40",    ringText: "text-rose-500" },
  indigo:  { from: "from-indigo-500",  via: "via-violet-500",  to: "to-purple-500",  shadow: "shadow-indigo-500/40",  ringText: "text-indigo-500" },
  cyan:    { from: "from-cyan-400",    via: "via-sky-500",     to: "to-blue-500",    shadow: "shadow-cyan-500/40",    ringText: "text-cyan-500" },
  tiktok:  { from: "from-tiktok-cyan", via: "via-black",       to: "to-tiktok-red",  shadow: "shadow-tiktok-red/40",  ringText: "text-tiktok-red" },
};

export type HeadingPreset =
  | "sky-violet-pink"
  | "sky-violet"
  | "emerald-cyan-sky"
  | "amber-rose-violet"
  | "violet-sky"
  | "tiktok";

export const HEADING_PRESETS: Record<HeadingPreset, string> = {
  "sky-violet-pink":   "from-sky-500 via-violet-500 to-pink-500",
  "sky-violet":        "from-sky-500 to-violet-500",
  "emerald-cyan-sky":  "from-emerald-500 via-cyan-500 to-sky-500",
  "amber-rose-violet": "from-amber-500 via-rose-500 to-violet-500",
  "violet-sky":        "from-violet-500 to-sky-500",
  // Turquoise is too light for text on a light page, so the heading runs black to red.
  "tiktok":            "from-black via-black to-tiktok-red",
};

export type IconLike = LucideIcon;