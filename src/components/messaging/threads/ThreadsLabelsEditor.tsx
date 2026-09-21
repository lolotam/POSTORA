import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

const SUGGESTED = ["lead", "complaint", "support", "testimonial", "sales", "partnership", "spam"];

interface Props {
  labels: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}

export function ThreadsLabelsEditor({ labels, disabled, onChange }: Props) {
  const { t } = useTranslation("threads");
  const [draft, setDraft] = useState("");

  const normalize = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 32);

  const addLabel = (raw: string) => {
    const v = normalize(raw);
    if (!v) return;
    if (labels.map((l) => l.toLowerCase()).includes(v)) return;
    onChange([...labels, v].slice(0, 10));
    setDraft("");
  };
  const removeLabel = (label: string) => {
    onChange(labels.filter((l) => l !== label));
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addLabel(draft);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((l) => (
        <Badge
          key={l}
          variant="secondary"
          className="gap-1 pr-1 group"
        >
          <span>#{l}</span>
          {!disabled && (
            <button
              type="button"
              onClick={() => removeLabel(l)}
              className="rounded-full p-0.5 opacity-60 hover:opacity-100 hover:bg-background/50 transition-opacity"
              aria-label={t("labels.removeAria", "Remove {{label}} label", { label: l })}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </Badge>
      ))}
      <Popover>
        <PopoverTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs gap-1"
            disabled={disabled}
          >
            <Plus className="h-3 w-3" />
            {t("labels.add", "Label")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-3 space-y-3">
          <div className="space-y-1.5">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              placeholder={t("labels.placeholder", "New label, then Enter")}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              {t("labels.hint", "Lowercase, max 32 chars. Up to 10 labels per mention.")}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {t("labels.suggested", "Suggested")}
            </p>
            <div className="flex flex-wrap gap-1">
              {SUGGESTED.map((s) => {
                const isOn = labels.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => (isOn ? removeLabel(s) : addLabel(s))}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs transition-colors",
                      isOn
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    #{s}
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
