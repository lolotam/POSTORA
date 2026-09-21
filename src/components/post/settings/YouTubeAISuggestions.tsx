import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { Sparkles, Loader2, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { handleAIError } from "@/lib/aiErrorHandler";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface YouTubeAISuggestionsProps {
  type: "title" | "description" | "tags";
  context: string; // title or caption text used as context
  secondaryContext?: string; // description for tags context
  onSelect: (value: string) => void;
}

export function YouTubeAISuggestions({ type, context, secondaryContext, onSelect }: YouTubeAISuggestionsProps) {
  const { t } = useTranslation("postsettings");
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [language, setLanguage] = useState<"english" | "arabic">("english");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { toast } = useToast();

  const handleGenerate = async () => {
    if (!context.trim()) {
      toast({
        title: t("youtubeAI.enterContentFirstTitle", "Enter content first"),
        description: type === "title" 
          ? t("youtubeAI.writeTitleOrCaption", "Write a title or caption to get AI suggestions.") 
          : type === "description"
          ? t("youtubeAI.writeTitleFirst", "Write a title first to generate a description.")
          : t("youtubeAI.writeTitleAndDesc", "Write a title and description to get tag suggestions."),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setSuggestions([]);
    setSelectedIndex(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error(t("youtubeAI.signInRequired", "Please sign in to use AI features."));

      const requestType = type === "title" ? "youtube_title" 
        : type === "description" ? "youtube_description" 
        : "youtube_tags";

      const { data, error } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: type === "tags" ? `Title: ${context}\nDescription: ${secondaryContext || ""}` : context,
          platform: "youtube",
          language,
          requestType,
        },
      });

      if (error) {
        const status = (error as any)?.status;
        if (status === 401 || status === 402 || status === 429) {
          handleAIError({ status, message: error.message }, "YouTube AI");
          return;
        }
        throw error;
      }

      if (data?.error) throw new Error(data.error);

      if (data?.suggestions) {
        setSuggestions(data.suggestions);
      } else if (data?.captions) {
        setSuggestions(data.captions);
      }
    } catch (err) {
      handleAIError(err, "YouTube AI suggestion");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelect = (index: number) => {
    setSelectedIndex(index);
    onSelect(suggestions[index]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select value={language} onValueChange={(v) => setLanguage(v as "english" | "arabic")}>
          <SelectTrigger className="w-28 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="english">{t("youtubeAI.langEnglish", "English")}</SelectItem>
            <SelectItem value="arabic">{t("youtubeAI.langArabic", "العربية")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={isLoading || !context.trim()}
          className="gap-1.5"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {t("youtubeAI.aiSuggestBtn", "AI Suggest")}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="space-y-1.5">
          {type === "tags" ? (
            <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-secondary/50 border border-border">
              {suggestions.map((tagSet, idx) => (
                <Badge
                  key={idx}
                  variant={selectedIndex === idx ? "default" : "outline"}
                  className="cursor-pointer transition-all hover:scale-105 text-xs"
                  onClick={() => handleSelect(idx)}
                >
                  {selectedIndex === idx && <Check className="w-3 h-3 me-1" />}
                  {tagSet}
                </Badge>
              ))}
            </div>
          ) : (
            suggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSelect(idx)}
                className={`w-full text-start p-2.5 rounded-lg border text-sm transition-all ${
                  selectedIndex === idx
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border hover:border-primary/40 hover:bg-secondary/50"
                }`}
              >
                <div className="flex items-start gap-2">
                  {selectedIndex === idx && <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />}
                  <span className="line-clamp-3">{suggestion}</span>
                </div>
              </button>
            ))
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("youtubeAI.clickSuggestionHelp", "Click a suggestion to use it")}
          </p>
        </div>
      )}
    </div>
  );
}
