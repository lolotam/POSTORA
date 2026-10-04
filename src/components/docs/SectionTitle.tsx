import { cn } from "@/lib/utils";
import type { HeadingPreset } from "@/components/fx/gradients";

interface SectionTitleProps {
  children: React.ReactNode;
  id: string;
  /** @deprecated No visual effect since the flat design system. */
  preset?: HeadingPreset;
  className?: string;
}

export function SectionTitle({ children, id, className }: SectionTitleProps) {
  return (
    <h2
      id={id}
      className={cn(
        "relative ps-4 text-2xl md:text-3xl font-bold mb-4 scroll-mt-20 tracking-tight",
        className,
      )}
    >
      <span aria-hidden className="absolute start-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-border" />
      {children}
    </h2>
  );
}

interface SubSectionProps {
  children: React.ReactNode;
  id: string;
  /** @deprecated No visual effect since the flat design system. */
  preset?: HeadingPreset;
  className?: string;
}

export function SubSection({ children, id, className }: SubSectionProps) {
  return (
    <h3
      id={id}
      className={cn(
        "flex items-center gap-2 text-lg font-semibold mb-3 mt-8 scroll-mt-20",
        className,
      )}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
      />
      <span>{children}</span>
    </h3>
  );
}
