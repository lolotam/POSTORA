import { Instagram, Facebook } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type InstagramFlow = "direct" | "facebook_business";

interface InstagramConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (flow: InstagramFlow) => void;
  disabled?: boolean;
}

export function InstagramConnectDialog({
  open,
  onOpenChange,
  onSelect,
  disabled,
}: InstagramConnectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Instagram className="h-5 w-5 text-[#E1306C]" />
            Connect Instagram
          </DialogTitle>
          <DialogDescription>
            Choose how you want to connect your Instagram account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect("direct")}
            className="flex items-start gap-3 rounded-lg border p-4 text-start transition hover:border-primary hover:bg-accent disabled:opacity-50"
          >
            <Instagram className="mt-1 h-5 w-5 text-[#E1306C]" />
            <div>
              <div className="font-medium">Connect Instagram Directly</div>
              <div className="text-sm text-muted-foreground">
                Use Instagram Business Login. Requires a Business or Creator
                account.
              </div>
            </div>
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect("facebook_business")}
            className="flex items-start gap-3 rounded-lg border p-4 text-start transition hover:border-primary hover:bg-accent disabled:opacity-50"
          >
            <Facebook className="mt-1 h-5 w-5 text-[#1877F2]" />
            <div>
              <div className="font-medium">Connect via Facebook Business</div>
              <div className="text-sm text-muted-foreground">
                Use your Facebook Page linked to an Instagram Business account.
                Best for Pages you already manage.
              </div>
            </div>
          </button>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
