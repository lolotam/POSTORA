import { useState, useMemo, useEffect } from "react";
import { Check, ChevronsUpDown, Globe, Clock } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

// Common timezones organized by region
const COMMON_TIMEZONES = [
  // Americas
  { value: "America/New_York", label: "New York (EST/EDT)", region: "Americas" },
  { value: "America/Chicago", label: "Chicago (CST/CDT)", region: "Americas" },
  { value: "America/Denver", label: "Denver (MST/MDT)", region: "Americas" },
  { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)", region: "Americas" },
  { value: "America/Toronto", label: "Toronto (EST/EDT)", region: "Americas" },
  { value: "America/Vancouver", label: "Vancouver (PST/PDT)", region: "Americas" },
  { value: "America/Mexico_City", label: "Mexico City (CST)", region: "Americas" },
  { value: "America/Sao_Paulo", label: "São Paulo (BRT)", region: "Americas" },
  { value: "America/Argentina/Buenos_Aires", label: "Buenos Aires (ART)", region: "Americas" },
  { value: "America/Bogota", label: "Bogotá (COT)", region: "Americas" },
  
  // Europe
  { value: "Europe/London", label: "London (GMT/BST)", region: "Europe" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)", region: "Europe" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)", region: "Europe" },
  { value: "Europe/Madrid", label: "Madrid (CET/CEST)", region: "Europe" },
  { value: "Europe/Rome", label: "Rome (CET/CEST)", region: "Europe" },
  { value: "Europe/Amsterdam", label: "Amsterdam (CET/CEST)", region: "Europe" },
  { value: "Europe/Brussels", label: "Brussels (CET/CEST)", region: "Europe" },
  { value: "Europe/Stockholm", label: "Stockholm (CET/CEST)", region: "Europe" },
  { value: "Europe/Moscow", label: "Moscow (MSK)", region: "Europe" },
  { value: "Europe/Istanbul", label: "Istanbul (TRT)", region: "Europe" },
  
  // Asia
  { value: "Asia/Dubai", label: "Dubai (GST)", region: "Asia" },
  { value: "Asia/Riyadh", label: "Riyadh (AST)", region: "Asia" },
  { value: "Asia/Kolkata", label: "Mumbai/Delhi (IST)", region: "Asia" },
  { value: "Asia/Bangkok", label: "Bangkok (ICT)", region: "Asia" },
  { value: "Asia/Singapore", label: "Singapore (SGT)", region: "Asia" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (HKT)", region: "Asia" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)", region: "Asia" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)", region: "Asia" },
  { value: "Asia/Seoul", label: "Seoul (KST)", region: "Asia" },
  { value: "Asia/Jakarta", label: "Jakarta (WIB)", region: "Asia" },
  
  // Pacific
  { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)", region: "Pacific" },
  { value: "Australia/Melbourne", label: "Melbourne (AEST/AEDT)", region: "Pacific" },
  { value: "Australia/Perth", label: "Perth (AWST)", region: "Pacific" },
  { value: "Pacific/Auckland", label: "Auckland (NZST/NZDT)", region: "Pacific" },
  { value: "Pacific/Honolulu", label: "Honolulu (HST)", region: "Pacific" },
  
  // Africa
  { value: "Africa/Cairo", label: "Cairo (EET)", region: "Africa" },
  { value: "Africa/Johannesburg", label: "Johannesburg (SAST)", region: "Africa" },
  { value: "Africa/Lagos", label: "Lagos (WAT)", region: "Africa" },
  { value: "Africa/Nairobi", label: "Nairobi (EAT)", region: "Africa" },
  
  // UTC
  { value: "UTC", label: "UTC (Coordinated Universal Time)", region: "UTC" },
];

interface TimezoneSelectorProps {
  value: string;
  onChange: (value: string) => void;
  scheduledAt?: Date | null;
}

// Helper to get current time in a specific timezone
const getCurrentTimeInTimezone = (timezone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date());
  } catch (e) {
    return '';
  }
};

// Helper to format scheduled time in timezone
const getScheduledTimeInTimezone = (date: Date, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch (e) {
    return format(date, "EEE, MMM d 'at' h:mm a");
  }
};

export function TimezoneSelector({ value, onChange, scheduledAt }: TimezoneSelectorProps) {
  const { t } = useTranslation("post");
  const [open, setOpen] = useState(false);
  const [detectedTimezone, setDetectedTimezone] = useState<string>("");
  const [currentTime, setCurrentTime] = useState<string>("");

  const getRegionHeading = (region: string) => {
    switch (region) {
      case "Americas": return t("timezone.regionAmericas", "Americas");
      case "Europe": return t("timezone.regionEurope", "Europe");
      case "Asia": return t("timezone.regionAsia", "Asia");
      case "Pacific": return t("timezone.regionPacific", "Pacific");
      case "Africa": return t("timezone.regionAfrica", "Africa");
      case "UTC": return t("timezone.regionUtc", "UTC");
      default: return region;
    }
  };

  // Detect user's local timezone on mount
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setDetectedTimezone(tz);
    } catch (e) {
      console.error("Failed to detect timezone:", e);
    }
  }, []);

  // Update current time in selected timezone every minute
  useEffect(() => {
    if (!value) {
      setCurrentTime("");
      return;
    }
    
    const updateTime = () => {
      setCurrentTime(getCurrentTimeInTimezone(value));
    };
    
    updateTime();
    const interval = setInterval(updateTime, 60000);
    return () => clearInterval(interval);
  }, [value]);

  // Find display label for current value
  const selectedLabel = useMemo(() => {
    const found = COMMON_TIMEZONES.find(tz => tz.value === value);
    return found ? found.label : value || t("timezone.select", "Select timezone...");
  }, [value, t]);

  // Group timezones by region
  const groupedTimezones = useMemo(() => {
    const groups: Record<string, typeof COMMON_TIMEZONES> = {};
    COMMON_TIMEZONES.forEach(tz => {
      if (!groups[tz.region]) {
        groups[tz.region] = [];
      }
      groups[tz.region].push(tz);
    });
    return groups;
  }, []);

  const handleUseDetected = () => {
    onChange(detectedTimezone);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t("timezone.label", "Timezone (Optional)")}</Label>
        <a 
          href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline"
        >
          {t("timezone.seeList", "See list")}
        </a>
      </div>
      
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            <div className="flex items-center gap-2 truncate">
              <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className={cn("truncate", !value && "text-muted-foreground")}>
                {value ? selectedLabel : t("timezone.select", "Select timezone...")}
              </span>
            </div>
            <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0 bg-popover border z-50" align="start">
          <Command>
            <CommandInput placeholder={t("timezone.search", "Search timezone...")} />
            <CommandList>
              <CommandEmpty>{t("timezone.notFound", "No timezone found.")}</CommandEmpty>
              {Object.entries(groupedTimezones).map(([region, timezones]) => (
                <CommandGroup key={region} heading={getRegionHeading(region)}>
                  {timezones.map((tz) => (
                    <CommandItem
                      key={tz.value}
                      value={`${tz.value} ${tz.label}`}
                      onSelect={() => {
                        onChange(tz.value);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "me-2 h-4 w-4",
                          value === tz.value ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <div className="flex flex-col">
                        <span className="text-sm">{tz.label}</span>
                        <span className="text-xs text-muted-foreground">{tz.value}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Current time in selected timezone */}
      {value && currentTime && (
        <div className="flex items-center gap-2 text-xs bg-muted/50 rounded-md px-3 py-2">
          <Clock className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">{t("timezone.currentTime", "Current time:")}</span>
          <span className="font-medium text-foreground">{currentTime}</span>
        </div>
      )}

      {/* Show scheduled time in selected timezone */}
      {value && scheduledAt && (
        <div className="flex items-center gap-2 text-xs bg-primary/10 rounded-md px-3 py-2">
          <Clock className="w-3 h-3 text-primary" />
          <span className="text-muted-foreground">{t("timezone.willPostAt", "Will post at:")}</span>
          <span className="font-medium text-primary">{getScheduledTimeInTimezone(scheduledAt, value)}</span>
        </div>
      )}

      {/* Detected timezone suggestion */}
      {detectedTimezone && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t("timezone.detected", "Detected:")} <span className="font-medium text-foreground">{detectedTimezone}</span>
          </span>
          {value !== detectedTimezone && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-primary"
              onClick={handleUseDetected}
            >
              {t("timezone.useThis", "Use this")}
            </Button>
          )}
          {value === detectedTimezone && (
            <Check className="w-3 h-3 text-primary" />
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("timezone.hint", "Defaults to UTC conversion of your local time if left blank.")}
      </p>
    </div>
  );
}