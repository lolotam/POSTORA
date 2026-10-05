import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, SearchCheck, Shield, Mic, ArrowDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export function BrandIntelligenceSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const keys = [
    "transcription_primary_model",
    "transcription_fallback_model",
    "apify_enabled",
    "brand_scrape_cache_ttl_minutes",
    "brand_scrape_max_posts",
  ];

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ["bi-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("*")
        .in("key", keys);
      if (error) throw error;
      return data || [];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw error;
    },
    onSuccess: () => {
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
      setEditedValues((prev) => { const n = { ...prev }; delete n[key]; return n; });
    }
  };

  const handleToggle = (key: string, enabled: boolean) => {
    saveMutation.mutate({ key, value: enabled });
  };

  if (isLoading) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-5">
        {/* Brand Intelligence Header */}
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-md flex items-center justify-center bg-muted">
            <SearchCheck className="w-3.5 h-3.5 text-foreground" />
          </div>
          <span className="text-sm font-semibold">Brand Intelligence</span>
        </div>

        {/* ─── Transcription Models Section ─── */}
        <div className="space-y-3 p-3 rounded-lg border border-border/50 bg-muted/20">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Audio-to-Text Models</span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">1st</Badge>
            <span>Primary</span>
            <ArrowDown className="w-3 h-3" />
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/10 text-amber-600 border-amber-500/30">2nd</Badge>
            <span>Fallback</span>
            <ArrowDown className="w-3 h-3" />
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-500/10 text-red-600 border-red-500/30">3rd</Badge>
            <span>Last Resort (hardcoded)</span>
          </div>

          {/* Primary Transcription Model */}
          <div className="space-y-1">
            <label className="text-xs font-medium flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">1st</Badge>
              Primary Transcription Model
            </label>
            <Select
              value={getValue("transcription_primary_model")}
              onValueChange={(v) => saveMutation.mutate({ key: "transcription_primary_model", value: v })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gpt-4o-mini-transcribe">
                  <span className="flex items-center gap-1">GPT-4o Mini Transcribe <span className="text-amber-500">⭐</span></span>
                </SelectItem>
                <SelectItem value="whisper-1">Whisper-1 (OpenAI)</SelectItem>
                <SelectItem value="nova-3">Nova-3 (Deepgram) — requires DEEPGRAM_API_KEY</SelectItem>
                <SelectItem value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Google) — uses audio input</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Fallback Model */}
          <div className="space-y-1">
            <label className="text-xs font-medium flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/10 text-amber-600 border-amber-500/30">2nd</Badge>
              Fallback Transcription Model
            </label>
            <Select
              value={getValue("transcription_fallback_model")}
              onValueChange={(v) => saveMutation.mutate({ key: "transcription_fallback_model", value: v })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="whisper-1">Whisper-1 (OpenAI)</SelectItem>
                <SelectItem value="nova-3">Nova-3 (Deepgram)</SelectItem>
                <SelectItem value="gpt-4o-mini-transcribe">GPT-4o Mini Transcribe</SelectItem>
                <SelectItem value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Google)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Built-in last resort */}
          <div className="flex items-center gap-2 p-2 rounded border border-border/50 bg-card">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-500/10 text-red-600 border-red-500/30">3rd</Badge>
            <Shield className="w-3.5 h-3.5 text-emerald-500" />
            <span className="text-xs text-muted-foreground">Built-in Safety Fallback: <strong>whisper-1</strong> — Always Available 🔒</span>
          </div>

          <p className="text-[10px] text-muted-foreground">
            If all 3 tiers fail, check your API keys in Supabase Edge Function Secrets.
          </p>
        </div>

      </CardContent>
    </Card>
  );
}
