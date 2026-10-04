import { cn } from "@/lib/utils";
import type { HeadingPreset } from "./gradients";

/**
 * Big section heading.
 *
 * Historically rendered bg-clipped gradient text; the flat design system dropped that, so it
 * now renders solid foreground text in the display serif, which is reserved for large titles.
 * `preset` is still accepted so existing call sites compile unchanged, but has no effect.
 */
export function GradientHeading({
  children,
  as: Tag = "h2",
  className,
  size = "xl",
}: {
  children: React.ReactNode;
  /** @deprecated No visual effect since the flat design system. */
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
  return <Tag className={cn("font-display font-medium tracking-tight text-foreground", sizeCls, className)}>{children}</Tag>;
}

export default GradientHeading;
