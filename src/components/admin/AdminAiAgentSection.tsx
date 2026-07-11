/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Bot } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { AllowedAiModel } from "@/hooks/useAllowedAiAgentModels";

const PROVIDER_PLACEHOLDERS = "openai, anthropic, google, openrouter, xai …";

export function AdminAiAgentSection() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");

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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-ai-agent-allowed-models"] });

  const addModel = useMutation({
    mutationFn: async () => {
      if (!provider.trim() || !modelId.trim() || !label.trim()) {
        throw new Error("Provider, model id, and label are required");
      }
      const { error } = await (supabase as any).from("ai_agent_allowed_models").insert({
        provider: provider.trim(),
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
          <div className="space-y-1"><Label>Provider</Label><Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder={PROVIDER_PLACEHOLDERS} /></div>
          <div className="space-y-1"><Label>Model ID</Label><Input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="gpt-4o-mini" /></div>
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
