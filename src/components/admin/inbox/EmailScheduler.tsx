import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmailSchedulerProps {
  scheduledAt: Date | null;
  onScheduleChange: (date: Date | null) => void;
}

export function EmailScheduler({
  scheduledAt,
  onScheduleChange,
}: EmailSchedulerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(
    scheduledAt || undefined
  );
  const [selectedTime, setSelectedTime] = useState(
    scheduledAt ? format(scheduledAt, "HH:mm") : "09:00"
  );

  const getNextTime = () => {
    const now = new Date();
    const d = new Date(now);
    // Round up to next 15 minutes
    const minutes = d.getMinutes();
    const rounded = Math.ceil((minutes + 1) / 15) * 15;
    d.setMinutes(rounded, 0, 0);
    return format(d, "HH:mm");
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open && !scheduledAt) {
      // Default to today + next available time so Confirm isn't accidentally disabled
      if (!selectedDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        setSelectedDate(today);
      }
      setSelectedTime(getNextTime());
    }
  };

  const handleDateSelect = (date?: Date) => {
    setSelectedDate(date);
    if (!date) return;

    // If user picked today and time is in the past, bump time to next slot
    const [h, m] = selectedTime.split(":").map(Number);
    const candidate = new Date(date);
    candidate.setHours(h, m, 0, 0);
    if (candidate <= new Date()) {
      setSelectedTime(getNextTime());
    }
  };

  // Check if selected date/time is in the future
  const isValidScheduleTime = () => {
    if (!selectedDate) return false;
    const [hours, minutes] = selectedTime.split(":").map(Number);
    const scheduledDate = new Date(selectedDate);
    scheduledDate.setHours(hours, minutes, 0, 0);
    return scheduledDate > new Date();
  };

  const handleConfirm = () => {
    if (!selectedDate) return;

    const [hours, minutes] = selectedTime.split(":").map(Number);
    const scheduledDate = new Date(selectedDate);
    scheduledDate.setHours(hours, minutes, 0, 0);

    if (scheduledDate <= new Date()) return;

    onScheduleChange(scheduledDate);
    setIsOpen(false);
  };

  const handleClear = () => {
    onScheduleChange(null);
    setSelectedDate(undefined);
    setSelectedTime(getNextTime());
  };

  // Disable past dates (keep today selectable)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const disabledDays = { before: today };

  return (
    <div className="flex items-center gap-2">
      {scheduledAt ? (
        <div className="flex items-center gap-2 bg-primary/10 text-primary rounded-md px-3 py-1.5 text-sm">
          <Clock className="h-4 w-4" />
          <span>
            Scheduled for {format(scheduledAt, "MMM d, yyyy 'at' h:mm a")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 hover:bg-primary/20"
            onClick={handleClear}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <Popover open={isOpen} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs">
              <Clock className="h-3 w-3 me-1" />
              Schedule Send
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-4" align="start">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Select Date</Label>
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDateSelect}
                  disabled={disabledDays}
                  initialFocus
                  className="rounded-md border pointer-events-auto"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="schedule-time">Select Time</Label>
                <Input
                  id="schedule-time"
                  type="time"
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                  className="w-full"
                />
              </div>

              {selectedDate && (
                <p className={cn(
                  "text-sm",
                  isValidScheduleTime() ? "text-muted-foreground" : "text-destructive"
                )}>
                  {isValidScheduleTime() 
                    ? `Will send on ${format(selectedDate, "MMMM d, yyyy")} at ${selectedTime}`
                    : "Please select a future date/time"
                  }
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirm}
                  disabled={!isValidScheduleTime()}
                >
                  Confirm
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
