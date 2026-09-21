import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Facebook, Instagram, Info } from "lucide-react";

interface InstagramConnectMethodDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectFacebookPage: () => void;
  onSelectBusinessLogin: () => void;
  instagramViaFacebookEnabled?: boolean;
}

export function InstagramConnectMethodDialog({
  open,
  onClose,
  onSelectFacebookPage,
  onSelectBusinessLogin,
  instagramViaFacebookEnabled = true,
}: InstagramConnectMethodDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Instagram</DialogTitle>
          <DialogDescription>
            Choose how you'd like to connect your Instagram account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          {/* Business Login — Direct */}
          <button
            onClick={onSelectBusinessLogin}
            className="flex items-start gap-3 p-4 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors text-start"
          >
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Instagram className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Connect Instagram Directly</span>
                <Badge variant="secondary" className="text-[10px] bg-green-500/10 text-green-600 border-green-500/30">
                  Recommended
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Uses Instagram Business Login. Best for Business &amp; Creator accounts.
              </p>
            </div>
          </button>

          {/* Facebook Page flow — conditionally shown */}
          {instagramViaFacebookEnabled ? (
            <button
              onClick={onSelectFacebookPage}
              className="flex items-start gap-3 p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors text-start"
            >
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Facebook className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <span className="font-medium text-sm">Connect via Facebook Page</span>
                <p className="text-xs text-muted-foreground">
                  Links Instagram through your Facebook Page. Use if your IG is connected to a Page.
                </p>
                <p className="text-[10px] text-muted-foreground/70 italic">
                  Personal Instagram accounts can only connect through this method.
                </p>
              </div>
            </button>
          ) : (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-muted/30 text-start">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Info className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <span className="font-medium text-sm text-muted-foreground">Facebook Page method unavailable</span>
                <p className="text-xs text-muted-foreground">
                  Only direct Instagram connection is available at this time.
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
