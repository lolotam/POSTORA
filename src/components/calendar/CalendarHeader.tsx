import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { format } from "date-fns";
import { GradientHeading, Icon3D } from "@/components/fx";

interface CalendarHeaderProps {
  currentMonth: Date;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}

export function CalendarHeader({
  currentMonth,
  onPreviousMonth,
  onNextMonth,
  onToday,
}: CalendarHeaderProps) {
  const { t } = useTranslation("calendar");

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 group">
      <div className="flex items-center gap-4">
        <Icon3D icon={CalendarDays} variant="violet" size="md" />
        <div>
          <GradientHeading as="h1" preset="sky-violet-pink" size="xl">
            {t("header.title", "Content Calendar")}
          </GradientHeading>
          <p className="text-muted-foreground mt-1">
            {t("header.subtitle", "View and reschedule posts and WhatsApp messages with drag and drop")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card p-1.5 shadow-sm">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPreviousMonth}
          className="rounded-xl hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="min-w-[160px] text-center px-2">
          <span className="font-semibold tabular-nums text-foreground">
            {format(currentMonth, "MMMM yyyy")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNextMonth}
          className="rounded-xl hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={onToday}
          className="rounded-xl text-foreground dark:text-neutral-200 font-medium bg-muted hover:bg-muted"
        >
          {t("header.today", "Today")}
        </Button>
      </div>
    </div>
  );
}
