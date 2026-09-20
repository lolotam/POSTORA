import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { X, History } from "lucide-react";
import { useSavedFieldSuggestions, FieldType } from "@/hooks/useSavedFieldSuggestions";
import { cn } from "@/lib/utils";

interface SavedSuggestionsInputProps {
  fieldType: FieldType;
  platform?: string | null;
  isCommaMode?: boolean;
  isTextarea?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  rows?: number;
}

export function SavedSuggestionsInput({
  fieldType,
  platform,
  isCommaMode = false,
  isTextarea = false,
  value,
  onChange,
  placeholder,
  className,
  maxLength,
  rows,
}: SavedSuggestionsInputProps) {
  const { t } = useTranslation("postsettings");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { suggestions, deleteSuggestion } = useSavedFieldSuggestions(fieldType, platform);

  const handleSelect = (suggestionValue: string) => {
    if (isCommaMode) {
      const existing = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (!existing.includes(suggestionValue)) {
        const newValue = existing.length > 0
          ? `${existing.join(", ")}, ${suggestionValue}`
          : suggestionValue;
        onChange(newValue);
      }
    } else {
      onChange(suggestionValue);
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) {
        setShowSuggestions(false);
      }
    }, 200);
  };

  const InputComponent = isTextarea ? Textarea : Input;
  const inputProps = isTextarea
    ? { rows: rows || 3, maxLength }
    : { maxLength };

  return (
    <div ref={containerRef} className="relative">
      <InputComponent
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value)}
        onFocus={() => setShowSuggestions(true)}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={cn(isTextarea && "min-h-[60px] resize-none", className)}
        {...inputProps}
      />

      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 p-2 rounded-lg border bg-popover shadow-md max-h-40 overflow-y-auto animate-fade-in">
          <div className="flex items-center gap-1.5 mb-1.5 px-1">
            <History className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-medium">
              {t("savedSuggestions.previouslyUsed", "Previously used")}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSelect(s.value)}
                className="group inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-secondary hover:bg-secondary/80 text-secondary-foreground transition-colors border border-border/50"
              >
                <span className="max-w-[150px] truncate">{s.value}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSuggestion(s.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 hover:text-destructive"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
