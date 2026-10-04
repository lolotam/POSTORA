import { cn } from "@/lib/utils";
import type { GradientKey, IconLike } from "./gradients";

/**
 * Icon tile. Historically a glossy coloured 3D badge; the flat design system renders a
 * neutral bordered tile so platform brand colours stay the only saturated colour on the
 * page. `variant` is still accepted so existing call sites compile unchanged.
 */
export function Icon3D({
  icon: Icon,
  size = "md",
  className,
}: {
  icon: IconLike;
  /** @deprecated No visual effect since the flat design system. */
  variant: GradientKey;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dims = size === "lg" ? "h-14 w-14" : size === "md" ? "h-11 w-11" : "h-9 w-9";
  const iconSize = size === "lg" ? "h-7 w-7" : size === "md" ? "h-5 w-5" : "h-[18px] w-[18px]";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground",
        dims,
        className,
      )}
    >
      <Icon className={iconSize} strokeWidth={1.8} />
    </span>
  );
}

export default Icon3D;
