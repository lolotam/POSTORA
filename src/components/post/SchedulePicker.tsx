import { useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { CalendarIcon, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Icon3D, GradientRingCard } from "@/components/fx";

interface SchedulePickerProps {
  scheduledAt: Date | null;
  onScheduleChange: (date: Date | null) => void;
}

export function SchedulePicker({ scheduledAt, onScheduleChange }: SchedulePickerProps) {
  const { t } = useTranslation("post");
  const [isScheduled, setIsScheduled] = useState(!!scheduledAt);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(scheduledAt || undefined);
  const [selectedTime, setSelectedTime] = useState(
    scheduledAt ? format(scheduledAt, "HH:mm") : "12:00"
  );

  const handleToggleSchedule = (enabled: boolean) => {
    setIsScheduled(enabled);
    if (!enabled) {
      onScheduleChange(null);
    } else if (selectedDate) {
      updateScheduledDate(selectedDate, selectedTime);
    }
  };

  const updateScheduledDate = (date: Date, time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    const newDate = new Date(date);
    newDate.setHours(hour, minute, 0, 0);
    onScheduleChange(newDate);
  };

  const handleDateSelect = (date: Date | undefined) => {
    setSelectedDate(date);
    if (date && isScheduled) {
      updateScheduledDate(date, selectedTime);
    }
  };

  const handleTimeChange = (time: string) => {
    setSelectedTime(time);
    if (selectedDate && isScheduled) {
      updateScheduledDate(selectedDate, time);
    }
  };

  const minDate = new Date();
  minDate.setHours(0, 0, 0, 0);

  return (
    <GradientRingCard variant="amber" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-5 space-y-4">
      <div className="flex items-center justify-between group">
        <div className="flex items-center gap-3">
          <Icon3D icon={Clock} variant="amber" size="sm" />
          <Label htmlFor="schedule-toggle" className="font-semibold text-foreground">
            {t("schedulePicker.label", "Schedule Post")}
          </Label>
        </div>
        <Switch
          id="schedule-toggle"
          checked={isScheduled}
          onCheckedChange={handleToggleSchedule}
        />
      </div>

      {isScheduled && (
        <div className="space-y-3 pt-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-start font-normal bg-card border-amber-400/30 hover:border-amber-400/60 hover:bg-card transition-all",
                  !selectedDate && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="me-2 h-4 w-4 text-amber-500" />
                {selectedDate ? format(selectedDate, "PPP") : <span>{t("schedulePicker.pickDate", "Pick a date")}</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={handleDateSelect}
                disabled={(date) => date < minDate}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-500" />
            <Input
              type="time"
              value={selectedTime}
              onChange={(e) => handleTimeChange(e.target.value)}
              className="w-full bg-background border-amber-400/30 focus-visible:border-amber-400 focus-visible:ring-amber-400/30"
            />
          </div>

          {scheduledAt && (
            <div className="flex justify-center">
              <span className="inline-flex items-center bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-400/40 rounded-full px-3 py-1 text-xs font-medium">
                {t("schedulePicker.willBePosted", "Will be posted on {{date}}", {
                  date: format(scheduledAt, "PPP 'at' p"),
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </GradientRingCard>
  );
}
