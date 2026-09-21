import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWhatsAppInboxApi } from "./WhatsAppInboxApiProvider";

export interface ForwardTarget {
  phone: string;
  label: string;
}

interface WhatsAppForwardDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  socialAccountId: string;
  messageRowId: string | null;
  targets: ForwardTarget[];
}

// Picking a target sends immediately, the way WhatsApp Web forwards: there is no second
// confirm step, so the list is searchable by name or digits to keep mis-taps rare.
export function WhatsAppForwardDialog({
  open,
  onOpenChange,
  socialAccountId,
  messageRowId,
  targets,
}: WhatsAppForwardDialogProps): JSX.Element {
  const api = useWhatsAppInboxApi();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const term = search.trim().toLowerCase();
  const visible = term
    ? targets.filter((target) => target.label.toLowerCase().includes(term) || target.phone.includes(term))
    : targets;

  const pick = async (target: ForwardTarget) => {
    if (!messageRowId || busy) return;
    setBusy(true);
    try {
      const result = await api.forwardMessage({
        social_account_id: socialAccountId,
        message_row_id: messageRowId,
        to_phone: target.phone,
      });
      if (result.error_type) throw new Error(result.error ?? result.error_type);
      toast.success(`Forwarded to ${target.label}`);
      setSearch("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not forward");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>Pick a chat or contact. The message is sent immediately.</DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats or contacts"
        />
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matches</p>
          ) : (
            <ul>
              {visible.map((target) => (
                <li key={target.phone}>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void pick(target)}
                    className="h-auto w-full justify-between rounded-none border-b px-3 py-2.5"
                  >
                    <span className="min-w-0 text-start">
                      <span className="block truncate text-sm font-medium">{target.label}</span>
                      <span className="text-xs text-muted-foreground">+{target.phone}</span>
                    </span>
                    <Send className="h-4 w-4 shrink-0" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
