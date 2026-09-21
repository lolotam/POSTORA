import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useConversationExport,
  type ExportChatTarget,
  type ExportFormat,
} from "../application/useConversationExport";

/** Past this an export is heavy enough that the user deserves a warning before starting it. */
const MEDIA_WARNING_BYTES = 25 * 1024 * 1024;

interface WhatsAppExportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  socialAccountId: string;
  accountLabel: string;
  chats: ExportChatTarget[];
  estimatedMediaBytes?: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function WhatsAppExportDialog({
  open,
  onOpenChange,
  socialAccountId,
  accountLabel,
  chats,
  estimatedMediaBytes = 0,
}: WhatsAppExportDialogProps): JSX.Element {
  const [format, setFormat] = useState<ExportFormat>("md");
  const [includeMedia, setIncludeMedia] = useState(false);
  const { runExport, cancel, progress, isExporting } = useConversationExport();

  const isSingle = chats.length === 1;
  const heavyMedia = includeMedia && estimatedMediaBytes > MEDIA_WARNING_BYTES;

  const handleExport = async () => {
    try {
      const done = await runExport({
        socialAccountId,
        accountLabel,
        chats,
        // A multi-chat export is a zip of markdown; CSV has no sensible multi-file shape.
        format: isSingle ? format : "md",
        includeMedia,
        exportedAt: new Date(),
      });
      if (done) {
        toast.success(isSingle ? "Chat exported" : `${chats.length} chats exported`);
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (isExporting ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isSingle ? "Export chat" : `Export ${chats.length} chats`}</DialogTitle>
          <DialogDescription>
            {isSingle
              ? "Downloads the full conversation history, not just the messages on screen."
              : "Downloads one Markdown file per chat in a single ZIP archive."}
          </DialogDescription>
        </DialogHeader>

        {isSingle ? (
          <RadioGroup
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="md" id="export-md" />
              <Label htmlFor="export-md">Markdown (.md)</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="csv" id="export-csv" />
              <Label htmlFor="export-csv">CSV (.csv)</Label>
            </div>
          </RadioGroup>
        ) : (
          <p className="text-sm text-muted-foreground">
            CSV is available when exporting a single chat.
          </p>
        )}

        <div className="flex items-start gap-2">
          <Checkbox
            id="export-media"
            checked={includeMedia}
            onCheckedChange={(checked) => setIncludeMedia(checked === true)}
          />
          <div className="grid gap-1">
            <Label htmlFor="export-media">Include media files</Label>
            {heavyMedia && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Roughly {formatBytes(estimatedMediaBytes)} of media — this may take a while.
              </p>
            )}
          </div>
        </div>

        {progress && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2" data-testid="wa-export-progress">
            {progress.chats.map((chat) => (
              <div key={chat.conversationId} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">{chat.participantName}</span>
                <span className="shrink-0 text-muted-foreground">
                  {chat.state === "failed"
                    ? "failed"
                    : chat.state === "done"
                      ? `${chat.messagesFetched} messages${chat.truncated ? " (truncated)" : ""}`
                      : chat.state === "fetching"
                        ? `${chat.messagesFetched}…`
                        : "waiting"}
                </span>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          {isExporting ? (
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
          <Button onClick={handleExport} disabled={isExporting || chats.length === 0}>
            {isExporting ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
