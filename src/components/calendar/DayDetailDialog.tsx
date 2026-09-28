import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { ScheduledMessageStatusBadge } from "@/components/messaging/ScheduledMessageStatusBadge";
import { Platform } from "@/lib/types";
import { format, parseISO } from "date-fns";
import { Calendar as CalendarIcon, Clock, Image } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GradientRingCard, Icon3D, Reveal } from "@/components/fx";
import { cn } from "@/lib/utils";
import { browserTimeZone, type CalendarEntry } from "@/features/scheduled";

interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: Date | null;
  entries: CalendarEntry[];
  onRescheduleWhatsApp: (id: string) => void;
  onCancelWhatsApp: (id: string) => void;
}

function WhatsAppDayRow({
  entry,
  onReschedule,
  onCancel,
}: {
  entry: Extract<CalendarEntry, { kind: "whatsapp" }>;
  onReschedule: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation("inbox");
  const { model } = entry;
  return (
    <GradientRingCard
      variant={model.muted ? "sky" : "emerald"}
      hoverLift={false}
      ringIntensity="subtle"
      innerClassName={cn("p-4 space-y-2", model.muted && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <PlatformIcon platform="whatsapp" size="xs" />
            <span className="truncate">{model.accountName}</span>
          </div>
          <p className="text-xs text-muted-foreground truncate" aria-label={model.recipientLabel}>
            {model.recipientLabel}
          </p>
          <p className="text-sm line-clamp-2">
            {model.preview || model.mediaName || t("scheduled.previewEmpty", "No message text")}
          </p>
        </div>
        <div className="text-end shrink-0 space-y-1.5">
          <div className="flex items-center justify-end gap-1 text-xs font-medium tabular-nums">
            <Clock className="w-3 h-3" />
            {format(parseISO(entry.when), "h:mm a")}
          </div>
          <ScheduledMessageStatusBadge status={model.status} />
        </div>
      </div>
      {model.action === "editable" && (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onReschedule(model.id)}>
            {t("scheduled.reschedule", "Reschedule")}
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => onCancel(model.id)}>
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

export function DayDetailDialog({
  open,
  onOpenChange,
  selectedDate,
  entries,
  onRescheduleWhatsApp,
  onCancelWhatsApp,
}: DayDetailDialogProps) {
  const { t } = useTranslation("calendar");
  const zone = browserTimeZone();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 group">
            <Icon3D icon={CalendarIcon} variant="violet" size="sm" />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500">
              {selectedDate && format(selectedDate, "EEEE, MMMM d, yyyy")}
            </span>
          </DialogTitle>
          <DialogDescription>{t("dayDialog.timezone", "Timezone: {{zone}}", { zone })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-4 max-h-[60vh] overflow-y-auto pe-1">
          {entries.length === 0 ? (
            <div className="text-center py-10 group">
              <div className="inline-flex flex-col items-center gap-3">
                <Icon3D icon={CalendarIcon} variant="sky" size="md" />
                <p className="text-muted-foreground">{t("dayDialog.noPosts", "Nothing scheduled for this day")}</p>
              </div>
            </div>
          ) : (
            entries.map((entry, index) => {
              if (entry.kind === "whatsapp") {
                return (
                  <Reveal key={`whatsapp-${entry.id}`} delay={index * 40}>
                    <WhatsAppDayRow
                      entry={entry}
                      onReschedule={onRescheduleWhatsApp}
                      onCancel={onCancelWhatsApp}
                    />
                  </Reveal>
                );
              }
              const post = entry.post;
              const statusVariant =
                post.status === "completed"
                  ? "emerald"
                  : post.status === "failed"
                    ? "rose"
                    : "amber";
              const statusClasses =
                statusVariant === "emerald"
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-400/40"
                  : statusVariant === "rose"
                    ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-400/40"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-400/40";
              return (
                <Reveal key={post.id} delay={index * 40}>
                  <GradientRingCard
                    variant={statusVariant === "rose" ? "rose" : "emerald"}
                    hoverLift={false}
                    ringIntensity="subtle"
                    innerClassName="p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-2">
                          {post.platforms.map((p) => (
                            <Badge
                              key={p}
                              variant="secondary"
                              className="gap-1 bg-card/60 border border-border/60"
                            >
                              <PlatformIcon platform={p as Platform} size="xs" />
                              {getPlatformName(p as Platform)}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-sm line-clamp-3">
                          {post.caption || (
                            <span className="text-muted-foreground italic">
                              {t("common:noCaption", "No caption")}
                            </span>
                          )}
                        </p>
                        {post.media_file_ids && post.media_file_ids.length > 0 && (
                          <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
                            <Image className="w-3 h-3" />
                            {t("dayDialog.mediaCount", "{{count}} media file(s)", { count: post.media_file_ids.length })}
                          </div>
                        )}
                      </div>
                      <div className="text-end shrink-0 space-y-1.5">
                        <div className="flex items-center justify-end gap-1 text-xs font-medium tabular-nums px-2 py-1 rounded-full bg-card/70 border border-border/60">
                          <Clock className="w-3 h-3" />
                          {post.scheduled_at &&
                            format(parseISO(post.scheduled_at), "h:mm a")}
                        </div>
                        <span
                          className={cn(
                            "inline-block text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border",
                            statusClasses
                          )}
                        >
                          {post.status}
                        </span>
                      </div>
                    </div>
                  </GradientRingCard>
                </Reveal>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
