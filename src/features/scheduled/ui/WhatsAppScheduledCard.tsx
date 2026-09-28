import { useTranslation } from "react-i18next";
import { FileAudio, FileText, FileVideo, Image as ImageIcon } from "lucide-react";
import { format } from "date-fns";
import { PlatformIcon } from "@/components/PlatformIcon";
import { ScheduledMessageStatusBadge } from "@/components/messaging/ScheduledMessageStatusBadge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { GradientRingCard } from "@/components/fx";
import { cn } from "@/lib/utils";
import type { WhatsAppCardModel } from "../domain/scheduledBoard";

function MediaTypeIcon({ mediaType }: { mediaType: string | null }) {
  const kind = (mediaType ?? "").toLowerCase();
  if (kind === "image") return <ImageIcon className="h-3.5 w-3.5" aria-hidden />;
  if (kind === "video") return <FileVideo className="h-3.5 w-3.5" aria-hidden />;
  if (kind === "audio") return <FileAudio className="h-3.5 w-3.5" aria-hidden />;
  return <FileText className="h-3.5 w-3.5" aria-hidden />;
}

export function WhatsAppScheduledCard({
  model,
  overdue,
  onReschedule,
  onCancel,
}: {
  model: WhatsAppCardModel;
  overdue: boolean;
  onReschedule: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("inbox");
  const when = new Date(model.scheduledAt);
  return (
    <GradientRingCard
      variant={overdue ? "rose" : "emerald"}
      hoverLift
      ringIntensity="normal"
      innerClassName="p-5 space-y-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar className="h-9 w-9">
            {model.avatarUrl && <AvatarImage src={model.avatarUrl} alt={model.accountName} />}
            <AvatarFallback><PlatformIcon platform="whatsapp" size="sm" /></AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium truncate">
              <PlatformIcon platform="whatsapp" size="xs" />
              {model.accountName}
            </p>
            <p className="text-xs text-muted-foreground truncate">{model.recipientLabel}</p>
          </div>
        </div>
        <ScheduledMessageStatusBadge status={model.status} />
      </div>
      <p className="text-sm line-clamp-2">
        {model.preview || <span className="text-muted-foreground italic">{t("scheduled.previewEmpty", "No message text")}</span>}
      </p>
      {model.mediaName && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <MediaTypeIcon mediaType={model.mediaType} />
          <span className="truncate">{model.mediaName}</span>
        </div>
      )}
      <div className={cn(
        "flex items-center justify-between rounded-xl border px-3 py-2 text-sm",
        overdue
          ? "border-rose-400/40 bg-rose-500/10 text-rose-600 dark:text-rose-300"
          : "border-emerald-400/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}>
        <span>{format(when, "MMM d, yyyy")}</span>
        <span className="tabular-nums">{format(when, "h:mm a")}</span>
      </div>
      {model.action === "editable" && (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onReschedule}>
            {t("scheduled.reschedule", "Reschedule")}
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={onCancel}>
            {t("common:cancel", "Cancel")}
          </Button>
        </div>
      )}
      {model.action === "sending" && (
        <p className="text-sm text-muted-foreground">{t("scheduled.sendingNow", "Sending…")}</p>
      )}
    </GradientRingCard>
  );
}
