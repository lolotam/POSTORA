import { useMemo } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { AccountAvatar } from "@/components/AccountAvatar";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface SelectableAccount {
  id: string;
  platform: Platform;
  platform_username?: string | null;
  avatar_url?: string | null;
}

interface PlatformAccountMultiSelectProps {
  accounts: SelectableAccount[];
  selectedPlatforms: Platform[];
  selectedAccountIds: string[];
  onPlatformsChange: (platforms: Platform[]) => void;
  onAccountsChange: (ids: string[]) => void;
}

/**
 * Two coupled multi-selects:
 * 1. Platforms (multi)
 * 2. Accounts grouped by selected platform (multi)
 *
 * Selected items render above as `AccountAvatar` chips so the user
 * sees their picks at a glance before they hit save.
 */
export function PlatformAccountMultiSelect({
  accounts,
  selectedPlatforms,
  selectedAccountIds,
  onPlatformsChange,
  onAccountsChange,
}: PlatformAccountMultiSelectProps) {
  const availablePlatforms = useMemo(() => {
    const set = new Set<Platform>();
    accounts.forEach((a) => set.add(a.platform));
    return Array.from(set);
  }, [accounts]);

  const accountsByPlatform = useMemo(() => {
    const map = new Map<Platform, SelectableAccount[]>();
    accounts.forEach((a) => {
      if (!selectedPlatforms.includes(a.platform)) return;
      const arr = map.get(a.platform) ?? [];
      arr.push(a);
      map.set(a.platform, arr);
    });
    return map;
  }, [accounts, selectedPlatforms]);

  const selectedAccounts = accounts.filter((a) => selectedAccountIds.includes(a.id));

  const togglePlatform = (p: Platform) => {
    if (selectedPlatforms.includes(p)) {
      onPlatformsChange(selectedPlatforms.filter((x) => x !== p));
      // also drop accounts for this platform
      onAccountsChange(
        selectedAccountIds.filter(
          (id) => accounts.find((a) => a.id === id)?.platform !== p,
        ),
      );
    } else {
      onPlatformsChange([...selectedPlatforms, p]);
    }
  };

  const toggleAccount = (id: string) => {
    if (selectedAccountIds.includes(id)) {
      onAccountsChange(selectedAccountIds.filter((x) => x !== id));
    } else {
      onAccountsChange([...selectedAccountIds, id]);
    }
  };

  return (
    <div className="space-y-3">
      {/* Selected chips preview (above caption / inputs) */}
      {selectedAccounts.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
          {selectedAccounts.map((a) => (
            <AccountAvatar
              key={a.id}
              platform={a.platform}
              avatarUrl={a.avatar_url}
              name={a.platform_username}
              size="sm"
              title={`@${a.platform_username ?? ""} (${getPlatformName(a.platform)})`}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Platforms dropdown */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Platforms
          </label>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full justify-between font-normal">
                <span className="truncate">
                  {selectedPlatforms.length === 0
                    ? "Select platforms"
                    : `${selectedPlatforms.length} platform${selectedPlatforms.length > 1 ? "s" : ""}`}
                </span>
                <ChevronDown className="w-4 h-4 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-1 max-h-64 overflow-y-auto" align="start">
              {availablePlatforms.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">
                  No connected accounts.
                </div>
              )}
              {availablePlatforms.map((p) => {
                const checked = selectedPlatforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent",
                      checked && "bg-accent/60",
                    )}
                  >
                    <Checkbox checked={checked} className="pointer-events-none" />
                    <PlatformIcon platform={p} size="sm" />
                    <span className="flex-1 text-left">{getPlatformName(p)}</span>
                    {checked && <Check className="w-3.5 h-3.5 text-primary" />}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
        </div>

        {/* Accounts dropdown */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Accounts
          </label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between font-normal"
                disabled={selectedPlatforms.length === 0}
              >
                <span className="truncate">
                  {selectedAccountIds.length === 0
                    ? selectedPlatforms.length === 0
                      ? "Pick platforms first"
                      : "Select accounts"
                    : `${selectedAccountIds.length} account${selectedAccountIds.length > 1 ? "s" : ""}`}
                </span>
                <ChevronDown className="w-4 h-4 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-1 max-h-80 overflow-y-auto" align="start">
              {selectedPlatforms.map((p) => {
                const list = accountsByPlatform.get(p) ?? [];
                return (
                  <div key={p} className="mb-1">
                    <div className="px-2 py-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase">
                      <PlatformIcon platform={p} size="xs" />
                      {getPlatformName(p)}
                    </div>
                    {list.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No connected accounts.
                      </div>
                    )}
                    {list.map((a) => {
                      const checked = selectedAccountIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => toggleAccount(a.id)}
                          className={cn(
                            "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent",
                            checked && "bg-accent/60",
                          )}
                        >
                          <Checkbox checked={checked} className="pointer-events-none" />
                          <AccountAvatar
                            platform={a.platform}
                            avatarUrl={a.avatar_url}
                            name={a.platform_username}
                            size="sm"
                          />
                          <span className="flex-1 text-left truncate">
                            @{a.platform_username || "account"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
