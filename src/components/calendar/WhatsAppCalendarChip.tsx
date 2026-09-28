import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { GripVertical } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";

export function WhatsAppCalendarChip({
  label,
  when,
  draggable,
  muted,
  isDragging,
  onDragStart,
}: {
  label: string;
  when: string;
  draggable: boolean;
  muted: boolean;
  isDragging: boolean;
  onDragStart: () => void;
}) {
  const { t } = useTranslation("calendar");
  const accessibleName = t("grid.whatsappChip", "WhatsApp, {{label}}", { label });
  return (
    <div
      draggable={draggable}
      aria-label={accessibleName}
      title={accessibleName}
      onDragStart={(event) => {
        if (!draggable) {
          event.preventDefault();
          return;
        }
        onDragStart();
      }}
      className={cn(
        "flex items-center gap-1 px-1.5 py-1 rounded-md text-xs border",
        "bg-[#25D366]/15 border-[#25D366]/40 text-emerald-800 dark:text-emerald-200",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        muted && "opacity-50",
        isDragging && "opacity-50 scale-95",
      )}
    >
      {draggable && <GripVertical className="w-3 h-3 shrink-0 opacity-70" />}
      <PlatformIcon platform="whatsapp" size="xs" />
      <span className="truncate flex-1">{label}</span>
      <span className="hidden sm:inline tabular-nums opacity-80">{format(parseISO(when), "h:mm a")}</span>
    </div>
  );
}
