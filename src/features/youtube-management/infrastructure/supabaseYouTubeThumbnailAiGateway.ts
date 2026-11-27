import { supabase } from "@/integrations/supabase/client";
import { resolveAiImageResponse } from "@/lib/aiGenerationJobWatcher";
import type { YouTubeThumbnailAiGateway } from "../application/ports";

/**
 * Generates a thumbnail with the app's own image generator.
 *
 * The request is the one `/post` sends today — `prompt`, `aspectRatio: "16:9"`,
 * the first reference image and `async: true` — so the generator, its limits
 * and its billing stay where they are.
 */
export class SupabaseYouTubeThumbnailAiGateway implements YouTubeThumbnailAiGateway {
  async generate(params: {
    prompt: string;
    referenceImage?: string;
    referenceImages?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ imageUrl: string }> {
    // The Supabase Functions client has no abort seam, so a cancelled request
    // is refused before it is sent rather than pretended to be cancelled.
    if (params.signal?.aborted) throw new Error("Image generation was cancelled");

    const refs = (params.referenceImages ?? []).filter((url) => typeof url === "string" && url.length > 0).slice(0, 5);
    const firstReference = params.referenceImage || refs[0] || undefined;
    const referenceImages = refs.length > 0 ? refs.map((url, idx) => ({ url, priority: idx + 1 })) : undefined;

    const { data: raw, error } = await supabase.functions.invoke("generate-image", {
      body: {
        prompt: params.prompt,
        aspectRatio: "16:9",
        referenceImage: firstReference,
        ...(referenceImages ? { referenceImages } : {}),
        async: true,
      },
    });
    if (error) throw error;

    const data = await resolveAiImageResponse(raw);
    if (!data) throw new Error("Image generation failed");
    if (data.success === false) throw new Error(String(data.message ?? "Image generation failed"));
    if (data.error) throw new Error(String(data.error));
    const imageUrl = data.imageUrl;
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new Error("Image generation failed");
    }
    return { imageUrl };
  }
}

export const defaultYouTubeThumbnailAiGateway = new SupabaseYouTubeThumbnailAiGateway();
