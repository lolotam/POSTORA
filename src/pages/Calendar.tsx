import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { usePosts } from "@/hooks/usePosts";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { format, addMonths, subMonths, parseISO, isSameDay } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarHeader,
  CalendarGrid,
  DayDetailDialog,
} from "@/components/calendar";
import { Reveal, GradientDivider } from "@/components/fx";

interface DraggedPost {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
}

export default function Calendar() {
  const { t } = useTranslation("calendar");
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [draggedPost, setDraggedPost] = useState<DraggedPost | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const { data: posts = [] } = usePosts();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get scheduled posts
  const scheduledPosts = useMemo(() => {
    return posts.filter((p) => p.scheduled_at);
  }, [posts]);

  // Get posts for a specific day
  const getPostsForDay = (day: Date) => {
    return scheduledPosts.filter((post) => {
      if (!post.scheduled_at) return false;
      const postDate = parseISO(post.scheduled_at);
      return isSameDay(postDate, day);
    });
  };

  const handleDragStart = (post: DraggedPost) => {
    setDraggedPost(post);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, targetDate: Date) => {
    e.preventDefault();
    if (!draggedPost) return;

    // Keep the same time, just change the date
    const originalDate = draggedPost.scheduled_at
      ? parseISO(draggedPost.scheduled_at)
      : new Date();
    const newDate = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      targetDate.getDate(),
      originalDate.getHours(),
      originalDate.getMinutes()
    );

    try {
      const { error } = await supabase
        .from("posts")
        .update({ scheduled_at: newDate.toISOString() })
        .eq("id", draggedPost.id);

      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ["posts"] });
      toast({
        title: t("toast.rescheduled", "Post rescheduled"),
        description: t("toast.rescheduledDesc", "Moved to {{date}}", {
          date: format(newDate, "MMM d, yyyy 'at' h:mm a"),
        }),
      });
    } catch (error) {
      console.error("Reschedule error:", error);
      toast({
        title: t("toast.rescheduleFailed", "Failed to reschedule"),
        description: error instanceof Error ? error.message : t("toast.unknownError", "Unknown error"),
        variant: "destructive",
      });
    } finally {
      setDraggedPost(null);
    }
  };

  const handleDayClick = (day: Date) => {
    setSelectedDate(day);
    setDetailDialogOpen(true);
  };

  const selectedDayPosts = selectedDate ? getPostsForDay(selectedDate) : [];

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

        <Reveal delay={160}>
          <CalendarGrid
            currentMonth={currentMonth}
            posts={scheduledPosts}
            draggedPost={draggedPost}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDayClick={handleDayClick}
          />
        </Reveal>
      </div>

      <DayDetailDialog
        open={detailDialogOpen}
        onOpenChange={setDetailDialogOpen}
        selectedDate={selectedDate}
        posts={selectedDayPosts}
      />
    </DashboardLayout>
  );
}
