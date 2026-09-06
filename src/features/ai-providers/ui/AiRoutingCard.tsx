import { useState } from "react";
import { ChevronDown, Route } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { PROVIDERS, type AiProvidersGateway, type Capability, type KeyStatus, type ProviderCode, type ProviderModel, type RoutingMode, type RoutingPreference } from "../application/ports";
import { useAiProviderKeys } from "./useAiProviderKeys";
import { useAiProviderModels } from "./useAiProviderModels";
import { useAiRoutingPreferences } from "./useAiRoutingPreferences";

const MODES: Record<RoutingMode, string> = {
  postora_only: "Use POSTORA providers",
  user_first: "Use my keys first, then POSTORA",
  user_only: "Use only my keys",
};

function RoutingForm({ capability, preference, keys, models, routing }: {
  capability: Capability; preference?: RoutingPreference; keys: KeyStatus[]; models: ProviderModel[];
  routing: ReturnType<typeof useAiRoutingPreferences>;
}) {
  const [mode, setMode] = useState<RoutingMode | "follow">(preference?.mode ?? (capability === "*" ? "postora_only" : "follow"));
  const [provider, setProvider] = useState<ProviderCode | "">(preference?.preferred_provider_code ?? "");
  const [model, setModel] = useState(preference?.preferred_model_id ?? "");
  const [consent, setConsent] = useState(preference?.allow_platform_fallback ?? false);
  const connected = keys.filter(key => key.status === "active");
  const availableModels = models.filter(row => row.provider_code === provider);
  const usesKey = mode === "user_first" || mode === "user_only";
  const valid = !usesKey || (connected.some(key => key.provider_code === provider) && availableModels.some(row => row.model_id === model) && (mode !== "user_first" || consent));
  const busy = routing.save.isPending || routing.remove.isPending;
  function save() {
    if (!valid || busy) return;
    if (mode === "follow") {
      routing.remove.mutate(capability);
      return;
    }
    routing.save.mutate({
      capability, mode,
      preferred_provider_code: usesKey ? provider as ProviderCode : null,
      preferred_model_id: usesKey ? model : null,
      allow_platform_fallback: mode === "user_first",
    });
  }
  return <div className="space-y-4">
    <RadioGroup aria-label={`${capability} routing mode`} value={mode} disabled={busy} onValueChange={value => { setMode(value as typeof mode); setConsent(false); }}>
      {capability !== "*" && <label className="flex items-center gap-2"><RadioGroupItem value="follow" />Follow global</label>}
      {(Object.entries(MODES) as [RoutingMode, string][]).map(([value, label]) => <label key={value} className="flex items-center gap-2"><RadioGroupItem value={value} />{label}</label>)}
    </RadioGroup>
    {usesKey && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select value={provider} disabled={busy} onValueChange={value => { setProvider(value as ProviderCode); setModel(""); }}>
          <SelectTrigger aria-label={`${capability} provider`}><SelectValue placeholder="Choose connected provider" /></SelectTrigger>
          <SelectContent>{connected.map(key => <SelectItem key={key.provider_code} value={key.provider_code}>{PROVIDERS[key.provider_code]}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={model} disabled={!provider || busy} onValueChange={setModel}>
          <SelectTrigger aria-label={`${capability} model`}><SelectValue placeholder="Choose model" /></SelectTrigger>
          <SelectContent>{availableModels.map(row => <SelectItem key={row.id} value={row.model_id}>{row.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {!connected.length && <p className="text-sm text-muted-foreground">Connect an AI key above to choose a provider.</p>}
      {provider && !availableModels.length && <p className="text-sm text-muted-foreground">No active models are available for this provider.</p>}
    </>}
    {mode === "user_first" && <label className="flex items-start gap-2 text-sm"><Checkbox checked={consent} disabled={busy} onCheckedChange={value => setConsent(value === true)} />If my key fails or is invalid, run the request on POSTORA&apos;s providers and quota instead.</label>}
    <Button onClick={save} disabled={!valid || busy}>Save routing</Button>
  </div>;
}

export function AiRoutingCard({ gateway, userId }: { gateway: AiProvidersGateway; userId: string }) {
  const routing = useAiRoutingPreferences(gateway, userId);
  const keys = useAiProviderKeys(gateway, userId);
  const models = useAiProviderModels(gateway);
  const loading = routing.isPending || keys.isPending || models.isPending;
  const error = routing.isError || keys.isError || models.isError;
  const form = (capability: Capability) => {
    const preference = routing.data?.find(row => row.capability === capability);
    // Remount only this capability after its persisted value changes. Background
    // refetches with identical data must not erase unsaved edits in another form.
    return <RoutingForm key={`${capability}:${JSON.stringify(preference)}`} capability={capability} preference={preference} keys={keys.data ?? []} models={models.data ?? []} routing={routing} />;
  };
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><Route className="h-5 w-5" aria-hidden="true" />Routing</CardTitle></CardHeader>
    <CardContent className="space-y-6">
      {loading ? <Skeleton className="h-40" aria-label="Loading routing" /> : error ? <div role="alert">Could not load routing settings. <Button variant="outline" onClick={() => { void routing.refetch(); void keys.refetch(); void models.refetch(); }}>Retry</Button></div> : <>
        <section aria-label="Global routing">{form("*")}</section>
        {([ ["chat", "Chat (captions & hashtags)"], ["agent", "Agent replies"] ] as const).map(([capability, label]) => <Collapsible key={capability} className="rounded-lg border p-4">
          <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between">{label}<ChevronDown className="h-4 w-4" aria-hidden="true" /></Button></CollapsibleTrigger>
          <CollapsibleContent className="pt-4"><section aria-label={label}>{form(capability)}</section></CollapsibleContent>
        </Collapsible>)}
      </>}
    </CardContent>
  </Card>;
}
