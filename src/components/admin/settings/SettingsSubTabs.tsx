import { cn } from "@/lib/utils";

/**
 * The strip of sub-tabs above a settings panel.
 *
 * Deliberately a row of buttons rather than Radix `Tabs`: the panels below stay mounted
 * whichever one is showing, so a half-typed API key survives a glance at another
 * sub-tab. `TabsContent` unmounts the inactive panel and would throw that away.
 */
export function SettingsSubTabs({
  labels,
  active,
  onSelect,
  icons,
  badges,
}: {
  labels: readonly string[];
  active: string | null;
  onSelect: (label: string) => void;
  /** Optional leading marker per label — a platform glyph, an icon. */
  icons?: Record<string, React.ReactNode>;
  /** Optional trailing marker per label — a status dot, a count. */
  badges?: Record<string, React.ReactNode>;
}) {
  if (labels.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1"
    >
      {labels.map((label) => {
        const isActive = label === active;
        return (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(label)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            {icons?.[label]}
            {label}
            {badges?.[label]}
          </button>
        );
      })}
    </div>
  );
}
