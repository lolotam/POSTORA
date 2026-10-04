import { cn } from "@/lib/utils";

/**
 * Horizontal hairline for separating sections. `tone` predates the flat design system and
 * no longer affects the output.
 */
export function GradientDivider({
  className,
}: {
  className?: string;
  /** @deprecated No visual effect since the flat design system. */
  tone?: "primary" | "sky" | "violet" | "emerald" | "rose";
}) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

export default GradientDivider;
