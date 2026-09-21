import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { usePosts } from "@/hooks/usePosts";
import { useToast } from "@/hooks/use-toast";
import { Platform } from "@/lib/types";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Clock, Sparkles, Loader2, TrendingUp, Calendar } from "lucide-react";
import { format, addDays, setHours, setMinutes } from "date-fns";
import { useTranslation } from "react-i18next";

interface TimeSuggestion {
  platform: Platform;
  day: string;
  time: string;
  score: number;
  reason: string;
}

interface BestTimeSuggestionsProps {
  selectedPlatforms: Platform[];
  onSelectTime: (date: Date) => void;
}

export function BestTimeSuggestions({
  selectedPlatforms,
  onSelectTime,
}: BestTimeSuggestionsProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<TimeSuggestion[]>([]);
  const { data: posts = [] } = usePosts();
  const { toast } = useToast();
  const { t } = useTranslation("post");

  const analyzePostingPatterns = () => {
    // Analyze historical posting data
    const hourCounts: Record<number, number> = {};
    const dayCounts: Record<number, number> = {};
    const successfulPosts = posts.filter((p) => p.status === "completed");

    successfulPosts.forEach((post) => {
      if (post.posted_at) {
        const date = new Date(post.posted_at);
        const hour = date.getHours();
        const day = date.getDay();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        dayCounts[day] = (dayCounts[day] || 0) + 1;
      }
    });

    return { hourCounts, dayCounts, totalPosts: successfulPosts.length };
  };

  const generateSuggestions = async () => {
    if (selectedPlatforms.length === 0) {
      toast({
        title: t("bestTimes.selectPlatformsTitle", "Select platforms first"),
        description: t("bestTimes.selectPlatformsDesc", "Choose at least one platform to get suggestions."),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setSuggestions([]);

    try {
      const { hourCounts, dayCounts, totalPosts } = analyzePostingPatterns();

      // Get AI suggestions
      const { data, error } = await supabase.functions.invoke("suggest-best-times", {
        body: {
          platforms: selectedPlatforms,
          historicalData: { hourCounts, dayCounts, totalPosts },
        },
      });

      if (error) throw error;

      if (data?.suggestions) {
        setSuggestions(data.suggestions);
      } else {
        // Fallback to default suggestions if AI fails
        const fallbackSuggestions: TimeSuggestion[] = [];
        const platformBestTimes: Record<Platform, { day: number; hour: number; reason: string }[]> = {
          instagram: [
            { day: 1, hour: 11, reason: "Highest engagement during lunch breaks" },
            { day: 3, hour: 19, reason: "Peak evening browsing time" },
            { day: 5, hour: 10, reason: "Strong morning engagement" },
          ],
          facebook: [
            { day: 2, hour: 13, reason: "Mid-week lunch hour peak" },
            { day: 4, hour: 9, reason: "Morning coffee scroll time" },
            { day: 6, hour: 12, reason: "Weekend leisure browsing" },
          ],
          tiktok: [
            { day: 2, hour: 19, reason: "Evening entertainment peak" },
            { day: 4, hour: 12, reason: "Lunch break scrolling" },
            { day: 6, hour: 21, reason: "Prime weekend viewing" },
          ],
          twitter: [
            { day: 1, hour: 8, reason: "Morning news consumption" },
            { day: 3, hour: 12, reason: "Lunch break engagement" },
            { day: 5, hour: 17, reason: "End of workday browsing" },
          ],
          linkedin: [
            { day: 2, hour: 10, reason: "Business hours peak" },
            { day: 3, hour: 8, reason: "Early morning professionals" },
            { day: 4, hour: 12, reason: "Lunch networking time" },
          ],
          pinterest: [
            { day: 6, hour: 20, reason: "Weekend evening peak engagement" },
            { day: 0, hour: 14, reason: "Sunday afternoon browsing" },
            { day: 5, hour: 21, reason: "Friday night inspiration time" },
          ],
          youtube: [
            { day: 5, hour: 17, reason: "Friday evening video watching peak" },
            { day: 6, hour: 14, reason: "Saturday afternoon leisure viewing" },
            { day: 0, hour: 11, reason: "Sunday morning content consumption" },
          ],
          threads: [
            { day: 1, hour: 9, reason: "Morning thread discussions" },
            { day: 3, hour: 18, reason: "Evening engagement peak" },
            { day: 5, hour: 12, reason: "Lunch break conversations" },
          ],
          bluesky: [
            { day: 2, hour: 10, reason: "Morning tech community active" },
            { day: 4, hour: 15, reason: "Afternoon discussions peak" },
            { day: 6, hour: 11, reason: "Weekend casual browsing" },
          ],
          reddit: [
            { day: 1, hour: 8, reason: "Monday morning browsing" },
            { day: 3, hour: 12, reason: "Mid-week lunch discussions" },
            { day: 0, hour: 10, reason: "Sunday morning peak activity" },
          ],
          whatsapp: [
            { day: 1, hour: 9, reason: "Monday morning business messages" },
            { day: 3, hour: 14, reason: "Mid-week afternoon engagement" },
            { day: 5, hour: 10, reason: "Friday morning follow-ups" },
          ],
        };

        selectedPlatforms.forEach((platform) => {
          const times = platformBestTimes[platform] || [];
          times.forEach((t, i) => {
            fallbackSuggestions.push({
              platform,
              day: format(addDays(new Date(), (t.day - new Date().getDay() + 7) % 7 || 7), "EEEE"),
              time: format(setHours(setMinutes(new Date(), 0), t.hour), "h:mm a"),
              score: 95 - i * 5,
              reason: t.reason,
            });
          });
        });

        setSuggestions(fallbackSuggestions.slice(0, 9));
      }
    } catch (error) {
      console.error("Suggestion error:", error);
      toast({
        title: t("bestTimes.fallbackTitle", "Failed to get suggestions"),
        description: t("bestTimes.fallbackDesc", "Using general best practices instead."),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectSuggestion = (suggestion: TimeSuggestion) => {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayIndex = days.indexOf(suggestion.day);
    const today = new Date();
    const todayDay = today.getDay();
    
    let daysToAdd = dayIndex - todayDay;
    if (daysToAdd <= 0) daysToAdd += 7;
    
    const targetDate = addDays(today, daysToAdd);
    
    // Parse time
    const timeMatch = suggestion.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const isPM = timeMatch[3].toUpperCase() === "PM";
      
      if (isPM && hours !== 12) hours += 12;
      if (!isPM && hours === 12) hours = 0;
      
      const scheduledDate = setMinutes(setHours(targetDate, hours), minutes);
      onSelectTime(scheduledDate);
      setOpen(false);
      
      toast({
        title: t("bestTimes.selectedTitle", "Time selected!"),
        description: t("bestTimes.selectedDesc", "Scheduled for {{date}}", {
          date: format(scheduledDate, "EEEE, MMM d 'at' h:mm a"),
        }),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-primary gap-2">
          <Sparkles className="w-4 h-4" />
          {t("bestTimes.suggestTimes", "Suggest Best Times")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            {t("bestTimes.dialogTitle", "Best Times to Post")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">
            {t("bestTimes.dialogDesc", "AI-powered recommendations based on platform data and your posting history.")}
          </p>

          {suggestions.length === 0 && !isLoading && (
            <Button
              onClick={generateSuggestions}
              className="w-full"
              disabled={selectedPlatforms.length === 0}
            >
              <Sparkles className="w-4 h-4 me-2" />
              {t("bestTimes.getSuggestions", "Get Suggestions for {{count}} Platform(s)", { count: selectedPlatforms.length })}
            </Button>
          )}

          {isLoading && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">{t("bestTimes.analyzing", "Analyzing best posting times...")}</p>
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="space-y-3">
              {suggestions.map((suggestion, index) => (
                <Card
                  key={index}
                  className="p-4 bg-card/50 border-border hover:border-primary/30 cursor-pointer transition-colors"
                  onClick={() => handleSelectSuggestion(suggestion)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <PlatformIcon platform={suggestion.platform} size="sm" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{suggestion.day}</span>
                          <span className="text-muted-foreground">{t("bestTimes.at", "at")}</span>
                          <span className="font-medium">{suggestion.time}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {suggestion.reason}
                        </p>
                      </div>
                    </div>
                    <div className="text-end">
                      <Badge
                        variant={
                          suggestion.score >= 90
                            ? "default"
                            : suggestion.score >= 80
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {t("bestTimes.match", "{{score}}% match", { score: suggestion.score })}
                      </Badge>
                    </div>
                  </div>
                </Card>
              ))}

              <Button
                variant="outline"
                onClick={generateSuggestions}
                className="w-full"
              >
                {t("bestTimes.refresh", "Refresh Suggestions")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
