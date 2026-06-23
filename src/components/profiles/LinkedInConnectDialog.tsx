import { Linkedin, Building2, User } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type LinkedInFlow = "personal" | "organization";

interface LinkedInConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (flow: LinkedInFlow) => void;
  disabled?: boolean;
}

export function LinkedInConnectDialog({
  open,
  onOpenChange,
  onSelect,
  disabled,
}: LinkedInConnectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Linkedin className="h-5 w-5 text-[#0A66C2]" />
            Connect LinkedIn
          </DialogTitle>
          <DialogDescription>
            Choose how you want to connect your LinkedIn account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect("personal")}
            className="flex items-start gap-3 rounded-lg border p-4 text-left transition hover:border-primary hover:bg-accent disabled:opacity-50"
          >
            <User className="mt-1 h-5 w-5 text-primary" />
            <div>
              <div className="font-medium">Personal Account</div>
              <div className="text-sm text-muted-foreground">
                Post to your own LinkedIn profile as a member.
              </div>
            </div>
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect("organization")}
            className="flex items-start gap-3 rounded-lg border p-4 text-left transition hover:border-primary hover:bg-accent disabled:opacity-50"
          >
            <Building2 className="mt-1 h-5 w-5 text-primary" />
            <div>
              <div className="font-medium">Commercial Page / Organization</div>
              <div className="text-sm text-muted-foreground">
                Manage and post to LinkedIn Company Pages you administer.
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
