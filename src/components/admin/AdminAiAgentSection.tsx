/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, Plus, Trash2, Bot } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useAIConfiguration } from "@/hooks/useAIConfiguration";
import { useOpenRouterModels, extractSeries, formatPrice } from "@/hooks/useOpenRouterModels";
import type { AllowedAiModel } from "@/hooks/useAllowedAiAgentModels";

// Must stay in sync with PROVIDER_ENDPOINTS in supabase/functions/ai-agent-reply/index.ts —
// the reply engine can only call providers it has an endpoint and API key for.
const SUPPORTED_PROVIDERS = [
  { code: "openai", label: "OpenAI" },
  { code: "openrouter", label: "OpenRouter" },
  { code: "gemini", label: "Google (Gemini)" },
];

export function AdminAiAgentSection() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [orOpen, setOrOpen] = useState(false);
  const [orSearch, setOrSearch] = useState("");

  const { data: aiConfig } = useAIConfiguration();
  const { data: openRouterModels, isLoading: orLoading } = useOpenRouterModels();

  // Chat-capable models from the admin catalog for the selected provider
  // (OpenRouter uses its live model list instead).
  const catalogModels = useMemo(() => {
    if (!provider || provider === "openrouter" || !aiConfig) return [];
    const providerRow = aiConfig.providers.find((p: any) => p.provider_code === provider);
    if (!providerRow) return [];
    return aiConfig.models
      .filter((m: any) => m.provider_id === providerRow.id && m.is_active && m.capabilities?.includes("chat"))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }, [provider, aiConfig]);

  const visibleOrModels = useMemo(() => {
    const chatModels = (openRouterModels || [])
      .filter((m) => m.architecture.output_modalities?.includes("text"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!orSearch) return chatModels.slice(0, 100);
    const q = orSearch.toLowerCase();
    return chatModels.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 100);
  }, [openRouterModels, orSearch]);

  const pickModel = (id: string, name: string) => {
    setModelId(id);
    // Pre-fill the display label from the catalog name; admin can still edit it.
    setLabel((current) => current.trim() ? current : name);
  };

  const { data: models = [], isLoading } = useQuery({
    queryKey: ["admin-ai-agent-allowed-models"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_agent_allowed_models")
        .select("*")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data || []) as AllowedAiModel[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-ai-agent-allowed-models"] });
    qc.invalidateQueries({ queryKey: ["ai-agent-allowed-models"] });
  };

  const addModel = useMutation({
    mutationFn: async () => {
      if (!provider || !modelId.trim() || !label.trim()) {
        throw new Error("Provider, model, and label are required");
      }
      const { error } = await (supabase as any).from("ai_agent_allowed_models").insert({
        provider,
        model_id: modelId.trim(),
        label: label.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setProvider(""); setModelId(""); setLabel("");
      toast.success("Model added");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || "Could not add model"),
  });

  const toggleModel = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await (supabase as any)
        .from("ai_agent_allowed_models")
        .update({ is_active, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.message || "Update failed"),
  });

  const deleteModel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("ai_agent_allowed_models").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Model removed"); invalidate(); },
    onError: (e: any) => toast.error(e.message || "Delete failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> AI Agent Models</CardTitle>
        <CardDescription>
          Curate the models users can pick as primary and fallback for their messaging AI agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label>Provider</Label>
            <Select
              value={provider || undefined}
              onValueChange={(value) => { setProvider(value); setModelId(""); setOrSearch(""); }}
            >
              <SelectTrigger><SelectValue placeholder="Choose a provider" /></SelectTrigger>
              <SelectContent>
                {SUPPORTED_PROVIDERS.map((p) => (
                  <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Model</Label>
            {provider === "openrouter" ? (
              <Popover open={orOpen} onOpenChange={setOrOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={orOpen} className="w-full justify-between font-normal" disabled={orLoading}>
                    {orLoading ? (
                      <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
                    ) : modelId ? (
                      <span className="truncate">{modelId}</span>
                    ) : "Choose a model"}
                    <ChevronsUpDown className="ms-1 h-3 w-3 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search models…" value={orSearch} onValueChange={setOrSearch} />
                    <CommandList className="max-h-[300px]">
                      <CommandEmpty>No models found.</CommandEmpty>
                      <CommandGroup>
                        {visibleOrModels.map((m) => (
                          <CommandItem key={m.id} value={m.id} onSelect={() => { pickModel(m.id, m.name); setOrOpen(false); setOrSearch(""); }}>
                            <div className="flex w-full min-w-0 items-center gap-2">
                              <Check className={`h-3 w-3 shrink-0 ${modelId === m.id ? "opacity-100" : "opacity-0"}`} />
                              <span className="flex-1 truncate">{m.name}</span>
                              <Badge variant="outline" className="shrink-0 py-0 text-[10px]">{extractSeries(m.id)}</Badge>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{formatPrice(m.pricing.prompt)}</span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <Select
                value={modelId || undefined}
                onValueChange={(value) => {
                  const row = catalogModels.find((m: any) => m.model_id === value);
                  pickModel(value, row?.name || value);
                }}
                disabled={!provider}
              >
                <SelectTrigger>
                  <SelectValue placeholder={!provider ? "Pick a provider first" : catalogModels.length ? "Choose a model" : "No chat models in catalog"} />
                </SelectTrigger>
                <SelectContent>
                  {catalogModels.map((m: any) => (
                    <SelectItem key={m.id} value={m.model_id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1"><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GPT-4o mini (OpenAI)" /></div>
          <div className="flex items-end">
            <Button onClick={() => addModel.mutate()} disabled={addModel.isPending} className="w-full">
              {addModel.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />} Add
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : models.length === 0 ? (
            <p className="text-sm text-muted-foreground">No models configured yet.</p>
          ) : (
            models.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{m.provider}</Badge>
                  <div>
                    <p className="text-sm font-medium">{m.label}</p>
                    <p className="text-xs text-muted-foreground">{m.model_id}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch checked={m.is_active} onCheckedChange={(v) => toggleModel.mutate({ id: m.id, is_active: v })} />
                    <span className="text-xs text-muted-foreground">{m.is_active ? "Active" : "Hidden"}</span>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => deleteModel.mutate(m.id)} aria-label="Delete model">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
