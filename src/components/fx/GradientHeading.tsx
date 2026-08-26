import { cn } from "@/lib/utils";
import { HEADING_PRESETS, type HeadingPreset } from "./gradients";

/** Big section heading with bg-clipped gradient text. */
export function GradientHeading({
  children,
  preset = "sky-violet-pink",
  as: Tag = "h2",
  className,
  size = "xl",
}: {
  children: React.ReactNode;
  preset?: HeadingPreset;
  as?: "h1" | "h2" | "h3";
  className?: string;
  size?: "lg" | "xl" | "2xl";
}) {
  const sizeCls =
    size === "2xl"
      ? "text-4xl md:text-7xl"
      : size === "xl"
        ? "text-3xl md:text-5xl"
        : "text-2xl md:text-4xl";
  const Comp = Tag as any;
  return (
    <Comp className={cn("font-bold tracking-tight", sizeCls, className)}>
      <span className={cn("bg-clip-text text-transparent bg-gradient-to-r", HEADING_PRESETS[preset] || HEADING_PRESETS["sky-violet-pink"] || "from-sky-500 via-violet-500 to-pink-500")}>
        {children}
      </span>
    </Comp>
  );
}

export default GradientHeading;