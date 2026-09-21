import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { format, parseISO } from "date-fns";
import { Calendar as CalendarIcon, Clock, Image } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GradientRingCard, Icon3D, Reveal } from "@/components/fx";
import { cn } from "@/lib/utils";

interface Post {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
  status: string | null;
  media_file_ids: string[] | null;
}

interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: Date | null;
  posts: Post[];
}

export function DayDetailDialog({
  open,
  onOpenChange,
  selectedDate,
  posts,
}: DayDetailDialogProps) {
  const { t } = useTranslation("calendar");

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
        </DialogHeader>

        <div className="space-y-3 pt-4 max-h-[60vh] overflow-y-auto pe-1">
          {posts.length === 0 ? (
            <div className="text-center py-10 group">
              <div className="inline-flex flex-col items-center gap-3">
                <Icon3D icon={CalendarIcon} variant="sky" size="md" />
                <p className="text-muted-foreground">{t("dayDialog.noPosts", "No posts scheduled for this day")}</p>
              </div>
            </div>
          ) : (
            posts.map((post, index) => {
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
