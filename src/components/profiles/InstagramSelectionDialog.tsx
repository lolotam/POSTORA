import { useMemo, useState } from "react";
import { Instagram, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface IgAccountCard {
  ig_user_id: string;
  ig_username: string;
  ig_profile_picture_url: string | null;
  facebook_page_name: string;
}

interface InstagramSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: IgAccountCard[];
  onSelect: (igUserId: string) => void;
  onDone: () => void;
  selectingId?: string | null;
  connectedIds?: string[];
}

export function InstagramSelectionDialog({
  open,
  onOpenChange,
  accounts,
  onSelect,
  onDone,
  selectingId,
  connectedIds = [],
}: InstagramSelectionDialogProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.ig_username.toLowerCase().includes(q) ||
        a.facebook_page_name.toLowerCase().includes(q),
    );
  }, [accounts, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Instagram className="h-5 w-5 text-pink-500" />
            Choose Instagram account
          </DialogTitle>
          <DialogDescription>
            Pick the Instagram account you want to connect. You can come back and
            add more, one at a time.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by username or Page"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No Instagram accounts match your search.
          </div>
        ) : (
          <div className="grid max-h-[60vh] grid-cols-2 gap-2.5 overflow-y-auto sm:grid-cols-3">
            {filtered.map((acc) => {
              const isSelecting = selectingId === acc.ig_user_id;
              const isConnected = connectedIds.includes(acc.ig_user_id);
              const disabled = !!selectingId || isConnected;
              return (
                <button
                  key={acc.ig_user_id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(acc.ig_user_id)}
                  className={cn(
                    "group relative rounded-lg border border-input p-2.5 text-center transition-all",
                    "flex w-full flex-col items-center gap-2.5",
                    "hover:border-primary hover:bg-accent/50",
                    "disabled:cursor-not-allowed",
                    isConnected && "border-green-500/50 bg-green-500/5",
                  )}
                >
                  {isSelecting && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  )}
                  <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gradient-to-br from-pink-500 to-purple-600">
                    {acc.ig_profile_picture_url ? (
                      <img
                        src={acc.ig_profile_picture_url}
                        alt={acc.ig_username}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Instagram className="absolute inset-0 m-auto h-10 w-10 text-white" />
                    )}
                  </div>
                  <div className="w-full truncate text-center text-sm font-medium">
                    @{acc.ig_username}
                  </div>
                  <div className="w-full truncate text-center text-[11px] text-muted-foreground">
                    via {acc.facebook_page_name}
                  </div>
                  {isConnected && (
                    <span className="absolute right-2 top-2 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-600">
                      Connected
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={!!selectingId}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
