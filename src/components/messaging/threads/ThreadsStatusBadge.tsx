import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sparkles, Check, Reply, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { ThreadsMentionStatus } from "@/hooks/useThreadsMentions";

const OPTIONS: {
  value: ThreadsMentionStatus;
  label: string;
  icon: typeof Sparkles;
  className: string;
}[] = [
  {
    value: "new",
    label: "New",
    icon: Sparkles,
    className: "bg-primary/15 text-primary border-primary/30",
  },
  {
    value: "read",
    label: "Read",
    icon: Check,
    className: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30",
  },
  {
    value: "replied",
    label: "Replied",
    icon: Reply,
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  },
  {
    value: "archived",
    label: "Archived",
    icon: Archive,
    className: "bg-muted text-muted-foreground border-border",
  },
];

interface Props {
  value: ThreadsMentionStatus;
  disabled?: boolean;
  onChange: (value: ThreadsMentionStatus) => void;
}

export function ThreadsStatusBadge({ value, disabled, onChange }: Props) {
  const { t } = useTranslation("threads");
  const current = OPTIONS.find((o) => o.value === value) || OPTIONS[0];
  const Icon = current.icon;
  const labelFor = (status: ThreadsMentionStatus, fallback: string) => {
    if (status === "new") return t("status.new", fallback);
    if (status === "read") return t("status.read", fallback);
    if (status === "replied") return t("status.replied", fallback);
    return t("status.archived", fallback);
  };
  const currentLabel = labelFor(current.value, current.label);
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium capitalize transition-colors hover:opacity-90 disabled:opacity-60",
            current.className,
          )}
          disabled={disabled}
          aria-label={t("status.aria", "Status: {{label}}. Click to change.", { label: currentLabel })}
        >
          <Icon className="h-3 w-3" />
          <span>{currentLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        <div className="space-y-0.5">
          {OPTIONS.map((opt) => {
            const OptIcon = opt.icon;
            const active = opt.value === value;
            return (
              <Button
                key={opt.value}
                size="sm"
                variant="ghost"
                className="w-full justify-start font-normal h-8"
                onClick={() => onChange(opt.value)}
              >
                <OptIcon className="h-3.5 w-3.5 me-2" />
                <span className="flex-1 text-start">{labelFor(opt.value, opt.label)}</span>
                {active && <Check className="h-3.5 w-3.5 text-primary" />}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}