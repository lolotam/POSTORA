import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCdnConfig, type CdnStorageConfig } from "@/hooks/useCdnConfig";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

type Counts = { cloudinaryOnly: number; both: number; openinaryOnly: number };
const emptyCounts: Counts = { cloudinaryOnly: 0, both: 0, openinaryOnly: 0 };

export function CdnStorageSettings() {
  const { data: config, isLoading } = useCdnConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<CdnStorageConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const current = draft ?? config;
  const { data: counts = emptyCounts } = useQuery({
    queryKey: ["cdn-provider-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("media_file_providers").select("media_file_id, provider, status, object_version");
      if (error) throw error;
      const byMedia = new Map<string, Set<string>>();
      for (const row of data ?? []) {
        if (row.status !== "ready") continue;
        const key = `${row.media_file_id}:${row.object_version}`;
        if (!byMedia.has(key)) byMedia.set(key, new Set());
        byMedia.get(key)!.add(row.provider);
      }
      return [...byMedia.values()].reduce((result, providers) => {
        if (providers.has("cloudinary") && providers.has("openinary")) result.both++;
        else if (providers.has("cloudinary")) result.cloudinaryOnly++;
        else if (providers.has("openinary")) result.openinaryOnly++;
        return result;
      }, { ...emptyCounts });
    },
  });
  const saving = useMutation({
    mutationFn: async (value: CdnStorageConfig) => {
      const { error } = await supabase.from("app_settings").upsert({ key: "cdn_storage", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["cdn-storage-config"] }); toast({ title: "CDN settings saved" }); setDraft(null); },
    onError: (error) => toast({ title: "Could not save CDN settings", description: error.message, variant: "destructive" }),
  });
  const providers = current?.write_policy.providers ?? ["cloudinary"];
  const openinary = current?.openinary;
  const update = (next: Partial<CdnStorageConfig>) => setDraft({ ...(current as CdnStorageConfig), ...next });
  const toggleProvider = (provider: "cloudinary" | "openinary", checked: boolean) => {
    if (provider === "cloudinary" && !checked && counts.cloudinaryOnly > 0) return;
    const next = checked ? [...new Set([...providers, provider])] : providers.filter((item) => item !== provider);
    const required = (current?.write_policy.required ?? []).filter((item) => next.includes(item));
    update({ write_policy: { providers: next, required } });
  };
  const canSave = useMemo(() => Boolean(current && (!openinary?.enabled || serverUrl === "" || serverUrl === openinary.serverUrl)), [current, openinary, serverUrl]);
  if (isLoading || !current) return <Card><CardContent className="p-6">Loading CDN settings…</CardContent></Card>;
  return <Card>
    <CardHeader><CardTitle>CDN storage</CardTitle></CardHeader>
    <CardContent className="space-y-6">
      <div><p className="text-sm font-medium">Write providers</p><p className="text-xs text-muted-foreground mb-3">Choose where new media is written.</p>
        {(["cloudinary", "openinary"] as const).map((provider) => <div className="flex items-center justify-between py-2" key={provider}><Label className="capitalize">{provider}</Label><Switch checked={providers.includes(provider)} onCheckedChange={(checked) => toggleProvider(provider, checked)} disabled={provider === "cloudinary" && counts.cloudinaryOnly > 0 && providers.includes("cloudinary")} /></div>)}
      </div>
      <div><p className="text-sm font-medium">Read preference</p><p className="text-xs text-muted-foreground mb-3">This is the provider the app serves when it is ready.</p><RadioGroup value={current.read_preference ?? "cloudinary"} onValueChange={(value) => update({ read_preference: value as "cloudinary" | "openinary" })}>{["cloudinary", "openinary"].map((value) => <div className="flex items-center gap-2" key={value}><RadioGroupItem value={value} id={`cdn-read-${value}`} /><Label htmlFor={`cdn-read-${value}`} className="capitalize">{value}</Label></div>)}</RadioGroup></div>
      <div className="rounded-lg border p-4 space-y-2"><p className="font-medium">Retirement gate</p><p className="text-sm">Cloudinary-only: {counts.cloudinaryOnly.toLocaleString()} {counts.cloudinaryOnly > 0 && <span className="text-destructive">← must reach 0</span>}</p><p className="text-sm">Both providers: {counts.both.toLocaleString()}</p><p className="text-sm">Openinary-only: {counts.openinaryOnly.toLocaleString()}</p><p className="text-xs text-muted-foreground">Disable Cloudinary means stop writing to it, never stop reading it.</p></div>
      <div className="space-y-2"><Label>Openinary server URL</Label><Input value={serverUrl || openinary?.serverUrl || ""} onChange={(event) => { setServerUrl(event.target.value); update({ openinary: { ...openinary, serverUrl: event.target.value } }); }} placeholder="https://openinary.example" /><p className="text-xs text-muted-foreground">Uploads use the edge-function server URL; this value must match it.</p><Button variant="outline" onClick={() => toast({ title: "Connection test unavailable", description: "The edge connection-test endpoint is not present in this checkout." })}>Test connection</Button></div>
      <Button disabled={!canSave || saving.isPending} onClick={() => saving.mutate(current)}>Save CDN settings</Button>
    </CardContent>
  </Card>;
}
