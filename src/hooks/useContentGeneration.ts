import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { ContentTone, ContentLanguage, BrandPlatform, GeneratedContent } from "@/types/brand-intelligence";

export function useContentGeneration() {
  const { toast } = useToast();
  const [content, setContent] = useState<GeneratedContent>({ captions: [], imagePrompts: [], videoPrompts: [] });
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async ({
    sourceText,
    language = "english",
    tone = "professional",
    platform = "instagram",
  }: {
    sourceText: string;
    language?: ContentLanguage;
    tone?: ContentTone;
    platform?: BrandPlatform;
  }) => {
    setIsGenerating(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: sourceText,
          platform,
          tone,
          language,
          requestType: "brand_intelligence",
        },
      });
      if (fnError) throw new Error(fnError.message || "Generation failed");
      if (data?.error) throw new Error(data.error);

      // Parse structured response
      const generated: GeneratedContent = {
        captions: data?.captions || [],
        imagePrompts: data?.imagePrompts || [],
        videoPrompts: data?.videoPrompts || [],
      };
      setContent(generated);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast({ title: "Generation failed", description: msg, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  }, [toast]);

  const saveCollection = useCallback(async ({
    sourcePostUrl,
    sourceUsername,
    sourcePlatform,
    sourceCaption,
    transcript,
    language,
    tone,
    targetPlatform,
  }: {
    sourcePostUrl?: string;
    sourceUsername?: string;
    sourcePlatform?: string;
    sourceCaption?: string;
    transcript?: string;
    language?: string;
    tone?: string;
    targetPlatform?: string;
  }) => {
    try {
      const { error } = await supabase.from("generated_content_collections").insert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        source_post_url: sourcePostUrl,
        source_username: sourceUsername,
        source_platform: sourcePlatform,
        source_caption: sourceCaption,
        transcript,
        post_prompts: content.captions,
        image_prompts: content.imagePrompts,
        video_prompts: content.videoPrompts,
        language: language || "english",
        tone: tone || "professional",
        target_platform: targetPlatform || "instagram",
      });
      if (error) throw error;
      toast({ title: "Collection saved!" });
    } catch (err) {
      toast({ title: "Failed to save", description: (err as Error).message, variant: "destructive" });
    }
  }, [content, toast]);

  return { content, isGenerating, error, generate, saveCollection };
}
