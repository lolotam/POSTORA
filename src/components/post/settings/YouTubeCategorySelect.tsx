import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  preserveYouTubeCategory,
  youtubeCategoryOptions,
  type YouTubeCategoryApiEntry,
  type YouTubeCategoryLocale,
} from "@/lib/youtubeVideoCategories";

interface YouTubeCategorySelectProps {
  /** The category ID already stored on the post or video. */
  value: string;
  onValueChange: (categoryId: string) => void;
  locale: YouTubeCategoryLocale;
  /** Google's catalog for the creator's region; bundled list when absent. */
  catalog?: readonly YouTubeCategoryApiEntry[] | null;
  /** Show a retry state instead of silently changing the selection. */
  catalogUnavailable?: boolean;
  onRetry?: () => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  unavailableText?: string;
  retryText?: string;
  helpText?: string;
}

/**
 * The single numbered category dropdown used by both YouTube editors. Only
 * the selected ID is ever persisted; the label is presentation only.
 */
export function YouTubeCategorySelect({
  value,
  onValueChange,
  locale,
  catalog,
  catalogUnavailable = false,
  onRetry,
  disabled = false,
  id = "youtube-category",
  label = "Category",
  unavailableText,
  retryText = "Retry",
  helpText,
}: YouTubeCategorySelectProps) {
  const options = preserveYouTubeCategory(
    youtubeCategoryOptions(catalog, locale),
    value,
    locale,
    unavailableText ?? (locale === "ar" ? "غير متاح حالياً" : "Currently unavailable"),
  );

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
      <Select
        value={value || undefined}
        onValueChange={onValueChange}
        disabled={disabled || catalogUnavailable}
      >
        <SelectTrigger id={id} className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={!option.assignable}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {catalogUnavailable ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={!onRetry}
          className="text-xs text-primary underline underline-offset-2"
        >
          {retryText}
        </button>
      ) : helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
    </div>
  );
}
