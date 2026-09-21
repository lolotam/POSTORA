import { cn } from "@/lib/utils";
import { HEADING_PRESETS, type HeadingPreset } from "@/components/fx/gradients";

interface SectionTitleProps {
  children: React.ReactNode;
  id: string;
  /** Gradient preset for the title text. Defaults to violet→sky. */
  preset?: HeadingPreset;
  className?: string;
}

export function SectionTitle({ children, id, preset = "violet-sky", className }: SectionTitleProps) {
  return (
    <h2
      id={id}
      className={cn(
        "relative ps-4 text-2xl md:text-3xl font-bold mb-4 scroll-mt-20 tracking-tight",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute start-0 top-1.5 bottom-1.5 w-1 rounded-full bg-gradient-to-b",
          HEADING_PRESETS[preset],
        )}
      />
      <span className={cn("bg-clip-text text-transparent bg-gradient-to-r", HEADING_PRESETS[preset])}>
        {children}
      </span>
    </h2>
  );
}

interface SubSectionProps {
  children: React.ReactNode;
  id: string;
  preset?: HeadingPreset;
  className?: string;
}

export function SubSection({ children, id, preset = "violet-sky", className }: SubSectionProps) {
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
        className={cn(
          "h-2 w-2 rounded-full bg-gradient-to-br shadow-[0_0_8px]",
          HEADING_PRESETS[preset],
          "shadow-violet-500/40",
        )}
      />
      <span>{children}</span>
    </h3>
  );
}
