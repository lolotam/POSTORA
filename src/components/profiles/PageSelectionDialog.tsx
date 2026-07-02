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
  const src =
    page.picture_url || `https://graph.facebook.com/${page.id}/picture?type=large`;
  const [errored, setErrored] = useState(false);
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gradient-to-br from-blue-500 to-blue-700">
      {!errored ? (
        <img
          src={src}
          alt={page.name}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <Facebook className="absolute inset-0 m-auto h-10 w-10 text-white" />
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
        ? standaloneInstagram.filter((ig) =>
            ig.username.toLowerCase().includes(q),
          )
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
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle className="text-center text-xl">
            Configure Your Channel
          </DialogTitle>
          <DialogDescription className="text-center">
            Select the Facebook page or account you want to connect.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search pages..."
              value={pageSearchQuery}
              onChange={(e) => onPageSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="text-sm font-medium">Select Page:</div>
        </div>

        {filteredPages.length === 0 && filteredIg.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No pages match your search.
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1">
            {filteredPages.length > 0 && (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
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
                        "group flex w-full flex-col items-center gap-2.5 rounded-lg border border-input p-2.5 text-center transition-all",
                        "hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        "disabled:cursor-not-allowed",
                      )}
                    >
                      <div className="relative w-full">
                        <PageLogo page={page} />
                        {isSelecting && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                          </div>
                        )}
                        {page.has_instagram && (
                          <span className="absolute -right-1 -top-1 rounded-full border border-pink-500/40 bg-gradient-to-r from-purple-500/30 to-pink-500/30 px-2 py-0.5 text-[10px] font-medium text-pink-500 backdrop-blur-sm">
                            IG
                          </span>
                        )}
                      </div>
                      <div className="line-clamp-2 w-full text-center text-sm font-medium leading-tight">
                        {page.name}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {filteredIg.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Instagram className="h-4 w-4 text-pink-500" />
                  <span className="text-xs font-medium text-muted-foreground">
                    Standalone Instagram Accounts
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
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
                          "group flex w-full flex-col items-center gap-2.5 rounded-lg border border-input p-2.5 text-center transition-all",
                          "hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                          "disabled:cursor-not-allowed",
                        )}
                      >
                        <div className="relative w-full">
                          <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gradient-to-br from-pink-500 to-purple-600">
                            {ig.profile_picture_url ? (
                              <img
                                src={ig.profile_picture_url}
                                alt={ig.username}
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <Instagram className="absolute inset-0 m-auto h-10 w-10 text-white" />
                            )}
                          </div>
                          {isSelecting && (
                            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/70 backdrop-blur-sm">
                              <Loader2 className="h-6 w-6 animate-spin text-primary" />
                            </div>
                          )}
                          <span className="absolute -right-1 -top-1 rounded-full border border-pink-500/40 bg-gradient-to-r from-purple-500/30 to-pink-500/30 px-2 py-0.5 text-[10px] font-medium text-pink-500 backdrop-blur-sm">
                            IG
                          </span>
                        </div>
                        <div className="line-clamp-2 w-full text-center text-sm font-medium leading-tight">
                          @{ig.username}
                        </div>
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
