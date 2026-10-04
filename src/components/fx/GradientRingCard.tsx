import { cn } from "@/lib/utils";
import type { GradientKey } from "./gradients";

/**
 * Content card. Historically a glass card with a coloured gradient halo; the flat design
 * system renders it as a bordered surface whose border darkens on hover or when `active`.
 * `variant`, `hoverLift` and `ringIntensity` are still accepted so existing call sites
 * compile unchanged, but no longer affect the output.
 */
export function GradientRingCard({
  children,
  className,
  innerClassName,
  active = false,
  padded = true,
}: {
  /** @deprecated No visual effect since the flat design system. */
  variant: GradientKey;
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  /** @deprecated No visual effect since the flat design system. */
  hoverLift?: boolean;
  /** @deprecated No visual effect since the flat design system. */
  ringIntensity?: "subtle" | "normal" | "strong";
  /** Selected state: the border switches to the foreground colour. */
  active?: boolean;
  /** When false, do not apply default p-6 md:p-8 padding (caller controls). */
  padded?: boolean;
}) {
  return (
    <div className={cn("group relative h-full", className)}>
      <div
        className={cn(
          "relative h-full rounded-lg border bg-card text-card-foreground transition-colors",
          active ? "border-foreground" : "border-border group-hover:border-input",
          padded && "p-6 md:p-8",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default GradientRingCard;
