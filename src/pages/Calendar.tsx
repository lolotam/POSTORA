import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { usePosts } from "@/hooks/usePosts";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  SCHEDULED_CHANGE_BLOCKED,
  SCHEDULED_RESCHEDULE_TOO_SOON,
  useWhatsAppScheduledMessages,
} from "@/hooks/useWhatsAppScheduledMessages";
import { format, addMonths, subMonths, parseISO, isSameDay, startOfMonth, endOfMonth, startOfWeek, endOfWeek, endOfDay } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarHeader,
  CalendarGrid,
  DayDetailDialog,
} from "@/components/calendar";
import type { CalendarDrag } from "@/components/calendar/CalendarGrid";
import { Reveal, GradientDivider } from "@/components/fx";
import { buildCalendarEntries } from "@/features/scheduled/domain/scheduledBoard";
import { moveKeepingLocalWallClock, movePostToDay } from "@/features/scheduled/domain/wallClockMove";
import { useWhatsAppScheduledItems } from "@/features/scheduled/whatsappScheduledItems";
import { CancelWhatsAppDialog, RescheduleWhatsAppDialog } from "@/features/scheduled/ui/WhatsAppScheduleDialogs";
import { AlertTriangle } from "lucide-react";

export default function Calendar() {
  const { t } = useTranslation("calendar");
  const { t: tInbox } = useTranslation("inbox");
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [dragged, setDragged] = useState<CalendarDrag | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const { data: posts = [] } = usePosts();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { cancel, reschedule } = useWhatsAppScheduledMessages();
  const accountFallback = tInbox("scheduled.accountFallback", "WhatsApp account");

  const range = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    return {
      rangeStart: startOfWeek(monthStart, { weekStartsOn: 0 }).toISOString(),
      rangeEnd: endOfDay(endOfWeek(monthEnd, { weekStartsOn: 0 })).toISOString(),
    };
  }, [currentMonth]);

  const whatsApp = useWhatsAppScheduledItems({ kind: "range", ...range });
  const entries = useMemo(
    () => buildCalendarEntries(posts, whatsApp.data?.messages ?? [], accountFallback),
    [posts, whatsApp.data?.messages, accountFallback],
  );

  const modelFor = (id: string | null) => entries.find((entry) => entry.kind === "whatsapp" && entry.id === id);

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const toastFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : t("toast.unknownError", "Unknown error");
    const description = message === SCHEDULED_CHANGE_BLOCKED
      ? tInbox("scheduled.changeBlocked", SCHEDULED_CHANGE_BLOCKED)
      : message === SCHEDULED_RESCHEDULE_TOO_SOON
        ? tInbox("scheduled.tooSoon", SCHEDULED_RESCHEDULE_TOO_SOON)
        : message;
    toast({ title: t("toast.rescheduleFailed", "Failed to reschedule"), description, variant: "destructive" });
  };

  const handleDrop = async (event: React.DragEvent, targetDate: Date) => {
    event.preventDefault();
    if (!dragged) return;
    try {
      if (dragged.kind === "post") {
        const newDate = movePostToDay(dragged.scheduled_at, targetDate);
        const { error } = await supabase.from("posts").update({ scheduled_at: newDate.toISOString() }).eq("id", dragged.id);
        if (error) throw error;
        queryClient.invalidateQueries({ queryKey: ["posts"] });
        toast({
          title: t("toast.rescheduled", "Post rescheduled"),
          description: t("toast.rescheduledDesc", "Moved to {{date}}", { date: format(newDate, "MMM d, yyyy 'at' h:mm a") }),
        });
        return;
      }
      const moved = moveKeepingLocalWallClock(dragged.when, targetDate);
      if (moved.ok === false) {
        const reason = moved.reason;
        toast({
          title: t("toast.rescheduleFailed", "Failed to reschedule"),
          description: reason === "nonexistent"
            ? t("toast.missingHour", "That time does not exist on the selected day.")
            : tInbox("scheduled.tooSoon", SCHEDULED_RESCHEDULE_TOO_SOON),
          variant: "destructive",
        });
        return;
      }
      await reschedule.mutateAsync({ id: dragged.id, scheduledAt: moved.iso });
      toast({
        title: tInbox("scheduled.rescheduledToast", "Message rescheduled"),
        description: t("toast.rescheduledDesc", "Moved to {{date}}", { date: format(parseISO(moved.iso), "MMM d, yyyy 'at' h:mm a") }),
      });
    } catch (error) {
      console.error("Reschedule error:", error);
      toastFailure(error);
    } finally {
      setDragged(null);
    }
  };

  const selectedEntries = selectedDate ? entries.filter((entry) => isSameDay(parseISO(entry.when), selectedDate)) : [];
  const rescheduleModel = modelFor(rescheduleId);
  const cancelModel = modelFor(cancelId);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <Reveal>
          <CalendarHeader
            currentMonth={currentMonth}
            onPreviousMonth={() => setCurrentMonth(subMonths(currentMonth, 1))}
            onNextMonth={() => setCurrentMonth(addMonths(currentMonth, 1))}
            onToday={() => setCurrentMonth(new Date())}
          />
        </Reveal>
        <Reveal delay={80}>
          <GradientDivider tone="violet" />
        </Reveal>
        {whatsApp.error && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-200">
            <AlertTriangle className="h-4 w-4" />
            {t("error.whatsappFailed", "Couldn't load scheduled WhatsApp messages.")}
          </div>
        )}
        {whatsApp.data?.truncated && (
          <p className="text-sm text-muted-foreground">{t("grid.moreNotShown", "Some items in this range are not shown.")}</p>
        )}
        <Reveal delay={160}>
          <CalendarGrid
            currentMonth={currentMonth}
            entries={entries}
            draggedId={dragged?.id ?? null}
            onDragStart={setDragged}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDayClick={(day) => {
              setSelectedDate(day);
              setDetailDialogOpen(true);
            }}
          />
        </Reveal>
      </div>
      <DayDetailDialog
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        selectedDate={selectedDate}
        entries={selectedEntries}
        onRescheduleWhatsApp={setRescheduleId}
        onCancelWhatsApp={setCancelId}
      />
      {rescheduleModel?.kind === "whatsapp" && (
        <RescheduleWhatsAppDialog
          key={rescheduleModel.id}
          open
          recipientLabel={rescheduleModel.model.recipientLabel}
          scheduledAt={rescheduleModel.model.scheduledAt}
          pending={reschedule.isPending}
          onOpenChange={(open) => !open && setRescheduleId(null)}
          onConfirm={(scheduledAt) => {
            reschedule.mutate({ id: rescheduleModel.id, scheduledAt }, {
              onSuccess: () => {
                toast({ title: tInbox("scheduled.rescheduledToast", "Message rescheduled") });
                setRescheduleId(null);
              },
              onError: toastFailure,
            });
          }}
        />
      )}
      <CancelWhatsAppDialog
        open={cancelModel?.kind === "whatsapp"}
        recipientLabel={cancelModel?.kind === "whatsapp" ? cancelModel.model.recipientLabel : ""}
        pending={cancel.isPending}
        onOpenChange={(open) => !open && setCancelId(null)}
        onConfirm={() => {
          if (cancelModel?.kind !== "whatsapp") return;
          cancel.mutate(cancelModel.id, {
            onSuccess: () => {
              toast({ title: tInbox("scheduled.cancelledToast", "Scheduled message cancelled") });
              setCancelId(null);
            },
            onError: (error) => {
              toast({
                title: t("toast.cancelFailed", "Cancel failed"),
                description: error instanceof Error ? error.message : t("toast.unknownError", "Unknown error"),
                variant: "destructive",
              });
            },
          });
        }}
      />
    </DashboardLayout>
  );
}
