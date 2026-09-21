import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Loader2, Clock, Plus, Trash2, CalendarIcon, Check, X } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface ScheduledChange {
  id: string;
  feature_key: string;
  scheduled_value: boolean;
  scheduled_at: string;
  status: string;
  executed_at: string | null;
  created_at: string;
}

const FLAG_OPTIONS = [
  { key: "feature_video_compress", label: "Video Compression" },
  { key: "feature_tiktok_transcode", label: "TikTok Transcode" },
  { key: "feature_image_crop", label: "Image Cropping" },
  { key: "feature_ai_caption", label: "AI Caption" },
  { key: "feature_ai_hashtags", label: "AI Hashtags" },
  { key: "feature_ai_thumbnails", label: "AI Thumbnails" },
  { key: "feature_ai_image", label: "AI Image" },
];

export function FeatureFlagScheduler() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isAdding, setIsAdding] = useState(false);
  const [selectedFlag, setSelectedFlag] = useState<string>("");
  const [scheduledValue, setScheduledValue] = useState<boolean>(true);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [selectedTime, setSelectedTime] = useState("12:00");

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["feature-flag-schedules"],
    queryFn: async (): Promise<ScheduledChange[]> => {
      const { data, error } = await supabase
        .from("feature_flag_schedules")
        .select("*")
        .order("scheduled_at", { ascending: true });

      if (error) throw error;
      return data || [];
    },
  });

  const createScheduleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate || !selectedFlag || !user?.id) {
        throw new Error("Missing required fields");
      }

      const [hours, minutes] = selectedTime.split(":").map(Number);
      const scheduledAt = new Date(selectedDate);
      scheduledAt.setHours(hours, minutes, 0, 0);

      const { error } = await supabase.from("feature_flag_schedules").insert({
        feature_key: selectedFlag,
        scheduled_value: scheduledValue,
        scheduled_at: scheduledAt.toISOString(),
        created_by: user.id,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-flag-schedules"] });
      toast({ title: "Schedule created" });
      resetForm();
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create schedule",
        variant: "destructive",
      });
    },
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("feature_flag_schedules")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-flag-schedules"] });
      toast({ title: "Schedule deleted" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setIsAdding(false);
    setSelectedFlag("");
    setScheduledValue(true);
    setSelectedDate(undefined);
    setSelectedTime("12:00");
  };

  const pendingSchedules = schedules.filter((s) => s.status === "pending");
  const executedSchedules = schedules.filter((s) => s.status === "executed");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">Scheduled Changes</CardTitle>
              <CardDescription>Schedule flag changes for a specific time</CardDescription>
            </div>
          </div>
          {!isAdding && (
            <Button size="sm" onClick={() => setIsAdding(true)}>
              <Plus className="w-4 h-4 me-2" />
              Schedule
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdding && (
          <div className="p-4 rounded-lg border bg-muted/30 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Feature Flag</label>
                <Select value={selectedFlag} onValueChange={setSelectedFlag}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a flag" />
                  </SelectTrigger>
                  <SelectContent>
                    {FLAG_OPTIONS.map((flag) => (
                      <SelectItem key={flag.key} value={flag.key}>
                        {flag.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">New State</label>
                <Select
                  value={scheduledValue ? "on" : "off"}
                  onValueChange={(v) => setScheduledValue(v === "on")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">
                      <div className="flex items-center gap-2">
                        <Check className="w-4 h-4 text-green-600" />
                        Turn On
                      </div>
                    </SelectItem>
                    <SelectItem value="off">
                      <div className="flex items-center gap-2">
                        <X className="w-4 h-4 text-destructive" />
                        Turn Off
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-start font-normal",
                        !selectedDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="me-2 h-4 w-4" />
                      {selectedDate ? format(selectedDate, "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={setSelectedDate}
                      disabled={(date) => date < new Date()}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Time</label>
                <Input
                  type="time"
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={resetForm}>
                Cancel
              </Button>
              <Button
                onClick={() => createScheduleMutation.mutate()}
                disabled={!selectedFlag || !selectedDate || createScheduleMutation.isPending}
              >
                {createScheduleMutation.isPending && (
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                )}
                Create Schedule
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : pendingSchedules.length === 0 && !isAdding ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No scheduled changes
          </p>
        ) : (
          <div className="space-y-2">
            {pendingSchedules.map((schedule) => {
              const flagLabel = FLAG_OPTIONS.find((f) => f.key === schedule.feature_key)?.label || schedule.feature_key;
              const scheduledDate = new Date(schedule.scheduled_at);
              const isPast = scheduledDate < new Date();

              return (
                <div
                  key={schedule.id}
                  className={cn(
                    "flex items-center justify-between p-3 rounded-lg border",
                    isPast && "bg-yellow-500/10 border-yellow-500/30"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      {schedule.scheduled_value ? (
                        <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                          <Check className="w-4 h-4 text-green-600" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-destructive/20 flex items-center justify-center">
                          <X className="w-4 h-4 text-destructive" />
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="font-medium text-sm">{flagLabel}</p>
                      <p className="text-xs text-muted-foreground">
                        {format(scheduledDate, "MMM d, yyyy 'at' h:mm a")}
                        {isPast && (
                          <Badge variant="outline" className="ms-2 text-yellow-600 border-yellow-500/30">
                            Pending execution
                          </Badge>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteScheduleMutation.mutate(schedule.id)}
                    disabled={deleteScheduleMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {executedSchedules.length > 0 && (
          <div className="pt-4 border-t">
            <p className="text-xs text-muted-foreground mb-2">Recently executed</p>
            <div className="space-y-1">
              {executedSchedules.slice(0, 3).map((schedule) => {
                const flagLabel = FLAG_OPTIONS.find((f) => f.key === schedule.feature_key)?.label || schedule.feature_key;
                return (
                  <div
                    key={schedule.id}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <Check className="w-3 h-3 text-green-600" />
                    <span>{flagLabel}</span>
                    <span>•</span>
                    <span>{format(new Date(schedule.executed_at || schedule.scheduled_at), "MMM d")}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
