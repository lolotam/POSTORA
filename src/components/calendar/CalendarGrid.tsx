import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GradientRingCard } from "@/components/fx";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  parseISO,
} from "date-fns";
import { cn } from "@/lib/utils";
import { ScheduledPostCard } from "./ScheduledPostCard";

interface Post {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
}

interface DraggedPost {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
}

interface CalendarGridProps {
  currentMonth: Date;
  posts: Post[];
  draggedPost: DraggedPost | null;
  onDragStart: (post: DraggedPost) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetDate: Date) => void;
  onDayClick: (day: Date) => void;
}

export function CalendarGrid({
  currentMonth,
  posts,
  draggedPost,
  onDragStart,
  onDragOver,
  onDrop,
  onDayClick,
}: CalendarGridProps) {
  const { t } = useTranslation("calendar");
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const calendarDays = eachDayOfInterval({
    start: calendarStart,
    end: calendarEnd,
  });

  const WEEKDAYS = [
    { id: "sun", label: t("weekdays.sun", "Sun") },
    { id: "mon", label: t("weekdays.mon", "Mon") },
    { id: "tue", label: t("weekdays.tue", "Tue") },
    { id: "wed", label: t("weekdays.wed", "Wed") },
    { id: "thu", label: t("weekdays.thu", "Thu") },
    { id: "fri", label: t("weekdays.fri", "Fri") },
    { id: "sat", label: t("weekdays.sat", "Sat") },
  ];

  const getPostsForDay = (day: Date) => {
    return posts.filter((post) => {
      if (!post.scheduled_at) return false;
      const postDate = parseISO(post.scheduled_at);
      return isSameDay(postDate, day);
    });
  };

  return (
    <GradientRingCard variant="violet" hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
      {/* Weekday Headers */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {WEEKDAYS.map((day) => (
          <div
            key={day.id}
            className="p-2 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground/80"
          >
            {day.label}
          </div>
        ))}
      </div>

      {/* Calendar Days */}
      <div className="grid grid-cols-7 gap-1">
        {calendarDays.map((day) => {
          const dayPosts = getPostsForDay(day);
          const isCurrentMonth = isSameMonth(day, currentMonth);
          const isToday = isSameDay(day, new Date());

          return (
            <div
              key={day.toISOString()}
              onDragOver={onDragOver}
              onDrop={(e) => onDrop(e, day)}
              onClick={() => onDayClick(day)}
              className={cn(
                "group/day min-h-[100px] lg:min-h-[120px] p-2 rounded-xl border border-border/40",
                "bg-card/40 backdrop-blur-sm transition-all duration-300 cursor-pointer",
                "hover:bg-card/80 hover:border-violet-400/40 hover:shadow-md hover:shadow-violet-500/10",
                !isCurrentMonth && "opacity-50 bg-muted/20",
                isToday &&
                  "ring-1 ring-sky-400/70 bg-gradient-to-br from-sky-500/10 via-blue-500/5 to-transparent shadow-[inset_0_0_24px_-8px] shadow-sky-500/40"
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    !isCurrentMonth && "text-muted-foreground",
                    isToday &&
                      "bg-clip-text text-transparent bg-gradient-to-br from-sky-400 to-indigo-500"
                  )}
                >
                  {format(day, "d")}
                </div>
                {isToday && (
                  <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500 shadow-[0_0_8px] shadow-sky-500/60" />
                )}
              </div>

              <div className="space-y-1">
                {dayPosts.slice(0, 3).map((post) => (
                  <ScheduledPostCard
                    key={post.id}
                    post={post}
                    isDragging={draggedPost?.id === post.id}
                    onDragStart={onDragStart}
                  />
                ))}
                {dayPosts.length > 3 && (
                  <div className="text-xs text-emerald-600/80 dark:text-emerald-300/80 pl-1 font-medium">
                    {t("grid.more", "+{{count}} more", { count: dayPosts.length - 3 })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-4 pt-3 border-t border-border/40">
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/30">
          <div className="w-2 h-2 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500" />
          <span className="text-emerald-700 dark:text-emerald-300 font-medium">
            {t("common:status.scheduled", "Scheduled")}
          </span>
        </div>
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-sky-500/10 border border-sky-400/30">
          <div className="w-2 h-2 rounded-full bg-gradient-to-br from-sky-400 to-indigo-500" />
          <span className="text-sky-700 dark:text-sky-300 font-medium">
            {t("grid.today", "Today")}
          </span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <GripVertical className="w-4 h-4" />
          <span>{t("grid.dragHint", "Drag to reschedule")}</span>
        </div>
      </div>
    </GradientRingCard>
  );
}
