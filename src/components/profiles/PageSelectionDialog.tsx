import { useMemo, useState } from "react";
import { Facebook, Instagram, Loader2, Search } from "lucide-react";
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

interface FacebookPage {
  id: string;
  name: string;
  has_instagram?: boolean;
  picture_url?: string;
}

interface StandaloneInstagram {
  id: string;
  username: string;
  profile_picture_url?: string;
}

interface PageSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: FacebookPage[];
  standaloneInstagram?: StandaloneInstagram[];
  pageSearchQuery: string;
  onPageSearchChange: (query: string) => void;
  onSelectPage: (pageId: string) => void;
  onSelectStandaloneInstagram?: (igAccount: StandaloneInstagram) => void;
  selectingPage: string | null;
}

function PageLogo({ page }: { page: FacebookPage }) {
  const src = page.picture_url || `https://graph.facebook.com/${page.id}/picture?type=square`;
  const [errored, setErrored] = useState(false);
  return (
    <div className="relative h-16 w-16 overflow-hidden rounded-full bg-gradient-to-br from-blue-500 to-blue-700">
      {!errored ? (
        <img
          src={src}
          alt={page.name}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <Facebook className="absolute inset-0 m-auto h-8 w-8 text-white" />
      )}
    </div>
  );
}

export function PageSelectionDialog({
  open,
  onOpenChange,
  pages,
  standaloneInstagram = [],
  pageSearchQuery,
  onPageSearchChange,
  onSelectPage,
  onSelectStandaloneInstagram,
  selectingPage,
}: PageSelectionDialogProps) {
  const q = pageSearchQuery.trim().toLowerCase();

  const filteredPages = useMemo(
    () => (q ? pages.filter((p) => p.name.toLowerCase().includes(q)) : pages),
    [pages, q],
  );
  const filteredIg = useMemo(
    () =>
      q
        ? standaloneInstagram.filter((ig) => ig.username.toLowerCase().includes(q))
        : standaloneInstagram,
    [standaloneInstagram, q],
  );

  const handleOpenChange = (next: boolean) => {
    if (!next) onPageSearchChange("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Facebook className="h-5 w-5 text-blue-500" />
            Select a Facebook Page
          </DialogTitle>
          <DialogDescription>
            Choose which Facebook Page you want to connect. Pages marked{" "}
            <span className="font-medium text-pink-500">IG</span> will also connect their linked
            Instagram.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search pages..."
            value={pageSearchQuery}
            onChange={(e) => onPageSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>

        {filteredPages.length === 0 && filteredIg.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No pages match your search.
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {filteredPages.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {filteredPages.map((page) => {
                  const isSelecting = selectingPage === page.id;
                  const disabled = !!selectingPage;
                  return (
                    <button
                      key={page.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelectPage(page.id)}
                      className={cn(
                        "group relative aspect-square rounded-xl border p-3 text-left transition-all",
                        "flex flex-col items-center justify-center gap-2",
                        "hover:border-primary hover:bg-accent/50",
                        "disabled:cursor-not-allowed",
                      )}
                    >
                      {isSelecting && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        </div>
                      )}
                      <PageLogo page={page} />
                      <div className="w-full truncate text-center text-sm font-medium">
                        {page.name}
                      </div>
                      <div className="w-full truncate text-center text-[11px] text-muted-foreground">
                        Facebook Page
                      </div>
                      {page.has_instagram && (
                        <span className="absolute right-2 top-2 rounded-full bg-gradient-to-r from-purple-500/20 to-pink-500/20 px-2 py-0.5 text-[10px] font-medium text-pink-500 border border-pink-500/30">
                          IG
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {filteredIg.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 pt-2">
                  <Instagram className="h-4 w-4 text-pink-500" />
                  <span className="text-xs font-medium text-muted-foreground">
                    Standalone Instagram Accounts
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {filteredIg.map((ig) => {
                    const isSelecting = selectingPage === ig.id;
                    const disabled = !!selectingPage;
                    return (
                      <button
                        key={ig.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => onSelectStandaloneInstagram?.(ig)}
                        className={cn(
                          "group relative aspect-square rounded-xl border p-3 text-left transition-all",
                          "flex flex-col items-center justify-center gap-2",
                          "hover:border-primary hover:bg-accent/50",
                          "disabled:cursor-not-allowed",
                        )}
                      >
                        {isSelecting && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          </div>
                        )}
                        <div className="relative h-16 w-16 overflow-hidden rounded-full bg-gradient-to-br from-pink-500 to-purple-600">
                          {ig.profile_picture_url ? (
                            <img
                              src={ig.profile_picture_url}
                              alt={ig.username}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <Instagram className="absolute inset-0 m-auto h-8 w-8 text-white" />
                          )}
                        </div>
                        <div className="w-full truncate text-center text-sm font-medium">
                          @{ig.username}
                        </div>
                        <div className="w-full truncate text-center text-[11px] text-muted-foreground">
                          Instagram only
                        </div>
                        <span className="absolute right-2 top-2 rounded-full bg-gradient-to-r from-purple-500/20 to-pink-500/20 px-2 py-0.5 text-[10px] font-medium text-pink-500 border border-pink-500/30">
                          IG
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={!!selectingPage}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
