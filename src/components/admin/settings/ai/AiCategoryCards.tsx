import { AudioLines, ImageIcon, Layers, MessageSquare, Mic, Search, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
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
  const { data: aiConfig } = useAIConfiguration();
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
      // Embedding has no per-model admin params to tune, and offering the controls
      // would suggest a knob that changes nothing about how vectors are produced.
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

export function TextToSpeechCard() {
  return (
    <AiCategoryCard
      category="tts"
      capability="tts"
      title="Text to Speech"
      description="Default model for text-to-speech conversion"
      icon={AudioLines}
    />
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
