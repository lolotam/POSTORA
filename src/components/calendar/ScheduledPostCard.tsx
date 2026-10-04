import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { GripVertical } from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

interface DraggedPost {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
}

interface ScheduledPostCardProps {
  post: {
    id: string;
    caption: string | null;
    platforms: string[];
    scheduled_at: string | null;
  };
  isDragging: boolean;
  onDragStart: (post: DraggedPost) => void;
}

export function ScheduledPostCard({
  post,
  isDragging,
  onDragStart,
}: ScheduledPostCardProps) {
  return (
    <div
      draggable
      onDragStart={() =>
        onDragStart({
          id: post.id,
          caption: post.caption,
          platforms: post.platforms,
          scheduled_at: post.scheduled_at,
        })
      }
      className={cn(
        "group/chip flex items-center gap-1 px-1.5 py-1 rounded-md text-xs",
        "bg-emerald-500/15",
        "border border-emerald-400/30 text-emerald-700 dark:text-emerald-300",
        "cursor-grab active:cursor-grabbing transition-all duration-300",
        "hover:from-emerald-500/25 hover:to-cyan-500/20 hover:-translate-y-0.5 hover:shadow-md",
        isDragging && "opacity-50 scale-95"
      )}
    >
      <GripVertical className="w-3 h-3 text-emerald-500/70 opacity-0 group-hover/chip:opacity-100 transition-opacity shrink-0" />
      <div className="flex items-center gap-1 flex-1 min-w-0">
        {post.platforms.slice(0, 2).map((p) => (
          <PlatformIcon key={p} platform={p as Platform} size="xs" />
        ))}
        {post.platforms.length > 2 && (
          <span className="text-emerald-600/80 dark:text-emerald-300/80">
            +{post.platforms.length - 2}
          </span>
        )}
      </div>
      <span className="hidden sm:inline tabular-nums opacity-80">
        {post.scheduled_at && format(parseISO(post.scheduled_at), "h:mm a")}
      </span>
    </div>
  );
}
