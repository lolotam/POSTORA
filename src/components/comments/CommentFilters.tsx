import { useTranslation } from "react-i18next";
import "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface CommentFiltersProps {
  sentimentFilter: string;
  onSentimentChange: (value: string) => void;
  hiddenFilter: string;
  onHiddenChange: (value: string) => void;
}

export function CommentFilters({
  sentimentFilter,
  onSentimentChange,
  hiddenFilter,
  onHiddenChange,
}: CommentFiltersProps) {
  const { t } = useTranslation("automation");

  return (
    <div className="flex flex-wrap gap-4 items-end">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("filters.visibility", "Visibility")}</Label>
        <Select value={hiddenFilter} onValueChange={onHiddenChange}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common:all", "All")}</SelectItem>
            <SelectItem value="visible">{t("filters.visible", "Visible")}</SelectItem>
            <SelectItem value="hidden">{t("filters.hidden", "Hidden")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{t("filters.sentiment", "Sentiment")}</Label>
        <Select value={sentimentFilter} onValueChange={onSentimentChange}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common:all", "All")}</SelectItem>
            <SelectItem value="positive">{t("filters.positive", "Positive")}</SelectItem>
            <SelectItem value="neutral">{t("filters.neutral", "Neutral")}</SelectItem>
            <SelectItem value="negative">{t("filters.negative", "Negative")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
