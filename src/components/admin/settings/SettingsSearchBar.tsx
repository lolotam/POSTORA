import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SETTINGS_TAB_LABELS, type SettingsTab } from "@/lib/settingsSearch";

interface SettingsSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Match counts per tab, so a hit outside the open tab is still visible. */
  counts: Record<SettingsTab, number>;
  totalMatches: number;
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
}

export function SettingsSearchBar({
  query,
  onQueryChange,
  counts,
  totalMatches,
  activeTab,
  onSelectTab,
}: SettingsSearchBarProps) {
  const isSearching = query.trim().length > 0;
  const otherTabsWithHits = (Object.keys(counts) as SettingsTab[])
    .filter((tab) => tab !== activeTab && counts[tab] > 0);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search settings — try “logo”, “tiktok”, or “model”"
          aria-label="Search settings"
          className="pl-9 pr-9"
        />
        {isSearching && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {isSearching && (
        <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground" aria-live="polite">
          {totalMatches === 0 ? (
            <span>No settings match “{query}”.</span>
          ) : (
            <>
              <span>
                {totalMatches} {totalMatches === 1 ? "section" : "sections"} match
                {counts[activeTab] === 0 && ", none in this tab"}
              </span>
              {otherTabsWithHits.map((tab) => (
                <Button
                  key={tab}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => onSelectTab(tab)}
                >
                  {counts[tab]} in {SETTINGS_TAB_LABELS[tab]}
                </Button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
