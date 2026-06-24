import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Save,
  Globe,
  Bot,
  Instagram,
  Facebook,
  AtSign,
  Video,
  ExternalLink,
  CheckCircle2,
  Loader2,
  Timer,
  Hash,
  DollarSign,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SUPABASE_STUDIO_URL } from "@/lib/supabaseStudio";
import { useToast } from "@/hooks/use-toast";

const APIFY_ACTOR_KEYS = [
  {
    key: "apify_actor_instagram",
    label: "Instagram",
    icon: Instagram,
    color: "from-pink-500/20 to-orange-500/20",
    iconColor: "text-pink-500",
    defaultActor: "apify/instagram-scraper",
  },
  {
    key: "apify_actor_tiktok",
    label: "TikTok",
    icon: Video,
    color: "from-black/10 to-gray-500/10",
    iconColor: "text-foreground",
    defaultActor: "clockworks/free-tiktok-scraper",
  },
  {
    key: "apify_actor_facebook",
    label: "Facebook",
    icon: Facebook,
    color: "from-blue-500/20 to-blue-600/20",
    iconColor: "text-blue-600",
    defaultActor: "apify/facebook-posts-scraper",
  },
  {
    key: "apify_actor_threads",
    label: "Threads",
    icon: AtSign,
    color: "from-gray-500/20 to-gray-700/20",
    iconColor: "text-foreground",
    defaultActor: "apify/instagram-scraper",
  },
];

const ALL_KEYS = [
  "apify_enabled",
  "brand_scrape_cache_ttl_minutes",
  "brand_scrape_max_posts",
  ...APIFY_ACTOR_KEYS.map((a) => a.key),
];

interface ActorPricing {
  pricePerUnitUsd: number | null;
  exists: boolean;
  loading: boolean;
}

export function ScrapingServicesSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [actorPricing, setActorPricing] = useState<Record<string, ActorPricing>>({});

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["scraping-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("*")
        .in("key", ALL_KEYS);
      if (error) throw error;
      return data || [];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert(
          { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scraping-settings"] });
      queryClient.invalidateQueries({ queryKey: ["bi-settings"] });
      toast({ title: "Setting saved" });
    },
    onError: (err) => {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    },
  });

  const getValue = (key: string): string => {
    if (editedValues[key] !== undefined) return editedValues[key];
    const setting = settings.find((s) => s.key === key);
    if (!setting) return "";
    try {
      const parsed = typeof setting.value === "string" ? JSON.parse(setting.value as string) : setting.value;
      return String(parsed);
    } catch {
      return String(setting.value);
    }
  };

  const handleSave = (key: string) => {
    const val = editedValues[key];
    if (val !== undefined) {
      saveMutation.mutate({ key, value: val });
      setEditedValues((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
    }
  };

  const handleToggle = (key: string, enabled: boolean) => {
    saveMutation.mutate({ key, value: enabled });
  };

  // Fetch pricing for each actor
  useEffect(() => {
    if (settings.length === 0) return;

    APIFY_ACTOR_KEYS.forEach((actor) => {
      const actorId = getValue(actor.key) || actor.defaultActor;
      if (!actorId) return;

      setActorPricing((prev) => ({
        ...prev,
        [actor.key]: { pricePerUnitUsd: null, exists: false, loading: true },
      }));

      const encodedActor = actorId.replace("/", "~");
      fetch(`https://api.apify.com/v2/acts/${encodedActor}`)
        .then((res) => {
          if (!res.ok) throw new Error("Not found");
          return res.json();
        })
        .then((data) => {
          const price = data?.data?.stats?.lastRunStats?.computeUnitsUsedAvg
            ? null // free actors don't have pricing
            : data?.data?.pricingInfo?.pricePerUnitUsd ?? null;
          setActorPricing((prev) => ({
            ...prev,
            [actor.key]: {
              pricePerUnitUsd: price,
              exists: true,
              loading: false,
            },
          }));
        })
        .catch(() => {
          setActorPricing((prev) => ({
            ...prev,
            [actor.key]: { pricePerUnitUsd: null, exists: false, loading: false },
          }));
        });
    });
  }, [settings]);

  if (isLoading) return null;

  const apifyEnabled = getValue("apify_enabled") === "true";

  return (
    <Card>
      <CardContent className="p-4 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-emerald-500/20 to-blue-500/20 flex items-center justify-center">
            <Globe className="w-3.5 h-3.5 text-emerald-500" />
          </div>
          <span className="text-sm font-semibold">External Scraping Services</span>
        </div>

        {/* ─── Strategy Toggle ─── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Meta API - Primary */}
          <div className="p-3 rounded-lg border-2 border-primary/30 bg-primary/5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold">Meta API</span>
              </div>
              <Badge className="text-[10px] bg-primary/10 text-primary border-primary/30">
                Primary
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Instagram Business Discovery & Facebook Graph API. Requires connected IG Business account.
            </p>
          </div>

          {/* Apify - Fallback */}
          <div className={`p-3 rounded-lg border space-y-2 transition-colors ${apifyEnabled ? "border-amber-500/30 bg-amber-500/5" : "border-border/50 bg-muted/20"}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-semibold">Apify Scrapers</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/30">
                  Fallback
                </Badge>
                <Switch
                  checked={apifyEnabled}
                  onCheckedChange={(checked) => handleToggle("apify_enabled", checked)}
                  className="scale-75"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Web scraping via Apify actors. Used when official APIs are unavailable or for TikTok.
            </p>
          </div>
        </div>

        {/* ─── Apify Actor Configuration ─── */}
        {apifyEnabled && (
          <div className="space-y-3 p-3 rounded-lg border border-border/50 bg-muted/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Apify Actor Endpoints
              </span>
              <a
                href={SUPABASE_STUDIO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> Manage API Key
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {APIFY_ACTOR_KEYS.map((actor) => {
                const Icon = actor.icon;
                const pricing = actorPricing[actor.key];
                const currentValue = getValue(actor.key) || actor.defaultActor;
                const isEdited = editedValues[actor.key] !== undefined;

                return (
                  <div
                    key={actor.key}
                    className="p-3 rounded-lg border border-border/50 bg-card space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded-md bg-gradient-to-br ${actor.color} flex items-center justify-center`}>
                          <Icon className={`w-3 h-3 ${actor.iconColor}`} />
                        </div>
                        <span className="text-xs font-medium">{actor.label}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {pricing?.loading ? (
                          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                        ) : pricing?.exists ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 text-red-500 border-red-500/30">
                            Not Found
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Input
                        value={editedValues[actor.key] ?? currentValue}
                        onChange={(e) =>
                          setEditedValues((prev) => ({ ...prev, [actor.key]: e.target.value }))
                        }
                        placeholder={actor.defaultActor}
                        className="h-7 text-[11px] font-mono"
                      />
                      <Button
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => handleSave(actor.key)}
                        disabled={!isEdited}
                      >
                        <Save className="w-3 h-3" />
                      </Button>
                    </div>

                    {/* Pricing */}
                    {pricing && !pricing.loading && pricing.exists && (
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <DollarSign className="w-3 h-3" />
                        {pricing.pricePerUnitUsd != null ? (
                          <span>~${(pricing.pricePerUnitUsd * 1000).toFixed(2)} / 1,000 results</span>
                        ) : (
                          <span className="text-emerald-600">Free / Pay-per-use</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Cache & Limits ─── */}
        <div className="space-y-3 p-3 rounded-lg border border-border/50 bg-muted/20">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Cache & Limits
          </span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Cache TTL */}
            <div className="space-y-1">
              <label className="text-xs font-medium flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5 text-muted-foreground" />
                Cache Duration (minutes)
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={10}
                  max={1440}
                  value={getValue("brand_scrape_cache_ttl_minutes")}
                  onChange={(e) =>
                    setEditedValues((prev) => ({
                      ...prev,
                      brand_scrape_cache_ttl_minutes: e.target.value,
                    }))
                  }
                  className="h-8 text-xs w-24"
                />
                <Button
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => handleSave("brand_scrape_cache_ttl_minutes")}
                  disabled={editedValues.brand_scrape_cache_ttl_minutes === undefined}
                >
                  <Save className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* Max Posts */}
            <div className="space-y-1">
              <label className="text-xs font-medium flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-muted-foreground" />
                Max Posts Per Scrape
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={10}
                  max={100}
                  value={getValue("brand_scrape_max_posts")}
                  onChange={(e) =>
                    setEditedValues((prev) => ({
                      ...prev,
                      brand_scrape_max_posts: e.target.value,
                    }))
                  }
                  className="h-8 text-xs w-24"
                />
                <Button
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => handleSave("brand_scrape_max_posts")}
                  disabled={editedValues.brand_scrape_max_posts === undefined}
                >
                  <Save className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
