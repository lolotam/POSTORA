import { useState } from 'react';
import { AudioLines, ImageIcon, Layers, Loader2, MessageSquare, Mic, Search, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DefaultModelSelector } from '@/components/admin/DefaultModelSelector';
import {
  useAIConfiguration,
  useSetDefaultModel,
  useSetFallbackModel,
  useSetFallback2Model,
  useSetModelAdminParams,
} from '@/hooks/useAIConfiguration';
import type { AIModel, ModelCategory } from '@/hooks/useAIConfiguration';
import { embeddingModelNote } from '@/hooks/ai-config/embeddingDimensions';
import { reEmbedWarningFor, useEmbeddingColumnOwners } from '@/hooks/useEmbeddingColumnOwners';
import { supabase } from '@/integrations/supabase/client';

/**
 * One model category, rendered on its own so the settings page can put each behind a
 * sub-tab. Every card reads the same `useAIConfiguration` query — React Query serves all
 * of them from one cached fetch, which is why these can be independent components rather
 * than one parent threading props down.
 */
function AiCategoryCard({
  category,
  capability,
  title,
  description,
  icon,
  modelNote,
}: {
  category: ModelCategory;
  capability: string;
  title: string;
  description: string;
  icon: LucideIcon;
  modelNote?: (model: AIModel) => string | null;
}) {
  const { data: aiConfig, isLoading } = useAIConfiguration();
  const setDefaultModel = useSetDefaultModel();
  const setFallbackModel = useSetFallbackModel();
  const setFallback2Model = useSetFallback2Model();
  const setModelAdminParams = useSetModelAdminParams();
  const { data: columnOwners = {} } = useEmbeddingColumnOwners();

  const handleSetDefault = async (providerCode: string, modelId: string) => {
    // Embedding is the one category where changing the model destroys value: the stored
    // vectors stop being comparable to new queries. The edge function refuses, but only
    // after the click — ask first, and say what it costs.
    if (category === 'embedding') {
      const warning = reEmbedWarningFor(
        { provider_code: providerCode, model_id: modelId },
        aiConfig?.models || [],
        columnOwners,
        aiConfig?.providers || [],
      );
      if (warning && !window.confirm(`${warning}\n\nSwitch anyway?`)) return;
    }
    try {
      await setDefaultModel.mutateAsync({ provider_code: providerCode, model_id: modelId, category });
      toast.success('Default model updated');
    } catch {
      toast.error('Failed to update default');
    }
  };

  const handleSetFallback = async (providerCode: string, modelId: string) => {
    try {
      await setFallbackModel.mutateAsync({ provider_code: providerCode, model_id: modelId, category });
      toast.success('Fallback model updated');
    } catch {
      toast.error('Failed to update fallback');
    }
  };

  const handleSetFallback2 = (providerCode: string, modelId: string) => {
    setFallback2Model.mutate(
      { provider_code: providerCode, model_id: modelId, category },
      {
        onSuccess: () => toast.success('Second fallback updated'),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleSetAdminParams = (modelRowId: string, params: Record<string, string | number | boolean>) => {
    setModelAdminParams.mutate(
      { model_row_id: modelRowId, admin_params: params },
      {
        onSuccess: () => toast.success('Model parameters saved'),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  // The monolith this was split out of guarded the whole AI tab on `isLoading`. Without
  // the same guard here, DefaultModelSelector sees an empty model list on first render
  // and states "No models available for this category yet" — an answer, not a wait.
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <DefaultModelSelector
      category={category}
      capability={capability}
      title={title}
      description={description}
      icon={icon}
      providers={aiConfig?.providers || []}
      models={aiConfig?.models || []}
      currentDefault={aiConfig?.categoryDefaults?.[category] ?? null}
      currentFallback={aiConfig?.categoryFallbacks?.[category] ?? null}
      currentFallback2={aiConfig?.categoryFallbacks2?.[category] ?? null}
      onSetDefault={handleSetDefault}
      onSetFallback={handleSetFallback}
      onSetFallback2={handleSetFallback2}
      // Withheld from embedding for the reason DefaultModelSelector's own prop docs give:
      // a category whose engine does not read ai_models.admin_params must not show a Save
      // button that discards what the admin typed.
      onSetAdminParams={category === 'embedding' ? undefined : handleSetAdminParams}
      isSaving={setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
      modelNote={modelNote}
    />
  );
}

export function SearchModelsCard() {
  return (
    <AiCategoryCard
      category="search"
      capability="search"
      title="Search Models"
      description="Default model for AI-powered web search"
      icon={Search}
    />
  );
}

export function EmbeddingModelsCard() {
  return (
    <AiCategoryCard
      category="embedding"
      capability="embedding"
      title="Embedding Models"
      description="Default vector model for Knowledge Base & RAG search"
      icon={Layers}
      modelNote={embeddingModelNote}
    />
  );
}

export function SpeechToTextCard() {
  return (
    <AiCategoryCard
      category="stt"
      capability="stt"
      title="Speech to Text"
      description="Default model for voice-to-text transcription"
      icon={Mic}
    />
  );
}

/**
 * Admin-only preview for the configured TTS chain. Calls `generate-speech` directly
 * (no media-library write) and plays back the returned base64 audio in place.
 */
export function TryVoice() {
  const [text, setText] = useState('Hello from Postora.');
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setError(null); setSrc(null);
    const { data, error: invokeError } = await supabase.functions.invoke('generate-speech', { body: { text } });
    setBusy(false);
    if (invokeError || data?.error) { setError(data?.error ?? 'Speech generation failed'); return; }
    setSrc(`data:${data.mediaType};base64,${data.audio}`);
  };
  return (
    <div className="space-y-2 pt-3">
      <Label htmlFor="tts-preview-text" className="text-xs">Preview text</Label>
      <div className="flex gap-2">
        <Input id="tts-preview-text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} className="h-8 text-xs" />
        <Button size="sm" onClick={run} disabled={busy || !text.trim()}>{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}Try voice</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {src && <audio data-testid="tts-preview" controls src={src} className="w-full" />}
    </div>
  );
}

export function TextToSpeechCard() {
  return (
    <div className="space-y-3">
      <AiCategoryCard
        category="tts"
        capability="tts"
        title="Text to Speech"
        description="Default model for text-to-speech conversion"
        icon={AudioLines}
      />
      <TryVoice />
    </div>
  );
}

export function VideoGenerationCard() {
  return (
    <AiCategoryCard
      category="video"
      capability="video"
      title="Video Generation"
      description="Default model for AI video generation"
      icon={Video}
    />
  );
}

export function ChatModelsCard() {
  return (
    <AiCategoryCard
      category="chat"
      capability="chat"
      title="Chat Models"
      description="Default model for AI chat conversations"
      icon={MessageSquare}
    />
  );
}

export function ImageGenerationCard() {
  return (
    <AiCategoryCard
      category="image"
      capability="image"
      title="Image Generation"
      description="Default model for AI image generation"
      icon={ImageIcon}
    />
  );
}
