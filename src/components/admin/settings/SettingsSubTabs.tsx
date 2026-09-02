import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface SettingsSubTab {
  /** Doubles as the panel's identity, so it is what a `?sub=` link carries. */
  label: string;
  content: ReactNode;
  /** Leading marker — a platform glyph, an icon. */
  icon?: ReactNode;
  /** Trailing marker — a status dot, a count. Include text for screen readers. */
  badge?: ReactNode;
  /**
   * Set false to drop the trigger while keeping the panel mounted — how a search hides
   * a sub-tab without discarding whatever was typed into it.
   */
  offered?: boolean;
}

/**
 * A strip of sub-tabs over one full-width panel.
 *
 * Built on Radix `Tabs` rather than a hand-rolled row of buttons: arrow-key navigation
 * and the trigger/panel wiring assistive tech needs come with it, and getting those
 * wrong is worse than not claiming the tab role at all.
 *
 * `forceMount` keeps every panel in the tree and CSS hides the inactive ones, so a
 * half-typed API key is still there when you come back. Radix would otherwise unmount
 * the panel you switched away from.
 */
export function SettingsSubTabs({
  items,
  active,
  onSelect,
}: {
  items: readonly SettingsSubTab[];
  active: string | null;
  onSelect: (label: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <Tabs value={active ?? undefined} onValueChange={onSelect} className="space-y-4">
      <TabsList className="flex h-auto flex-wrap justify-start gap-1">
        {items
          .filter((item) => item.offered !== false)
          .map((item) => (
            <TabsTrigger key={item.label} value={item.label} className="gap-1.5">
              {item.icon}
              {item.label}
              {item.badge}
            </TabsTrigger>
          ))}
      </TabsList>

      {items.map((item) => (
        <TabsContent
          key={item.label}
          value={item.label}
          forceMount
          className="mt-0 data-[state=inactive]:hidden"
        >
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
