import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Video, Bot, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type Source = "apify" | "tiktok_api";

export function TikTokAnalyticsSourceCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: source = "apify", isLoading } = useQuery({
    queryKey: ["app-setting", "tiktok_analytics_source"],
    queryFn: async (): Promise<Source> => {
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "tiktok_analytics_source")
        .maybeSingle();
      if (!data) return "apify";
      try {
        const v = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
        return v === "tiktok_api" ? "tiktok_api" : "apify";
      } catch {
        return "apify";
      }
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (newSource: Source) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          {
            key: "tiktok_analytics_source",
            value: JSON.stringify(newSource),
            description: "Data source for TikTok analytics page",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" },
        );
      if (error) throw error;
    },
    onSuccess: (_, newSource) => {
      queryClient.invalidateQueries({ queryKey: ["app-setting", "tiktok_analytics_source"] });
      toast({
        title: "TikTok analytics source updated",
        description: newSource === "tiktok_api" ? "Now using official TikTok API" : "Now using Apify scraper",
      });
    },
    onError: (err) => {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    },
  });

  if (isLoading) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md flex items-center justify-center bg-muted">
            <Video className="w-3.5 h-3.5 text-foreground" />
          </div>
          <div>
            <span className="text-sm font-semibold">TikTok Analytics Source</span>
            <p className="text-[11px] text-muted-foreground">
              Choose how the /analytics/tiktok page fetches data
            </p>
          </div>
        </div>

        <RadioGroup
          value={source}
          onValueChange={(v) => saveMutation.mutate(v as Source)}
          className="space-y-2"
        >
          <label
            htmlFor="src-apify"
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              source === "apify" ? "border-amber-500/40 bg-amber-500/5" : "border-border/50 bg-muted/10 hover:bg-muted/30"
            }`}
          >
            <RadioGroupItem value="apify" id="src-apify" className="mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Bot className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-semibold">Apify (scrape any public username)</span>
                <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-600 border-amber-500/30">
                  Public
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Scrape any public TikTok creator by username. Requires Apify enabled and credit.
              </p>
            </div>
          </label>

          <label
            htmlFor="src-tiktok-api"
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              source === "tiktok_api" ? "border-primary/40 bg-primary/5" : "border-border/50 bg-muted/10 hover:bg-muted/30"
            }`}
          >
            <RadioGroupItem value="tiktok_api" id="src-tiktok-api" className="mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-semibold">TikTok API (official, connected accounts only)</span>
                <Badge variant="outline" className="text-[9px] bg-primary/10 text-primary border-primary/30">
                  Official
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Uses the user's connected TikTok account via OAuth. Requires the
                <code className="mx-1 px-1 rounded bg-muted text-[10px]">user.info.stats</code>
                and
                <code className="mx-1 px-1 rounded bg-muted text-[10px]">video.list</code>
                scopes. In sandbox, only added test users see data.
              </p>
            </div>
          </label>
        </RadioGroup>
      </CardContent>
    </Card>
  );
}
