/**
 * Hook for managing YouTube thumbnail generation and download
 * Extracts thumbnail logic from CreatePost.tsx for better maintainability
 */

import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { UploadedFile } from "@/hooks/usePostForm";

interface UseYouTubeThumbnailsProps {
  files: UploadedFile[];
  setYoutubeAutoThumbnails: React.Dispatch<React.SetStateAction<string[]>>;
  setYoutubeSelectedAutoThumbnail: React.Dispatch<React.SetStateAction<number | null>>;
  setYoutubeAiGeneratedThumbnails: React.Dispatch<React.SetStateAction<string[]>>;
  setYoutubeGeneratingAiThumbnail: React.Dispatch<React.SetStateAction<boolean>>;
}

interface UseYouTubeThumbnailsReturn {
  /** Generate auto thumbnails from video frames */
  generateAutoThumbnails: () => Promise<void>;
  /** Generate AI-powered thumbnail */
  generateAiThumbnail: (prompt: string, refImage?: string) => Promise<void>;
  /** Download a thumbnail image */
  downloadThumbnail: (imageUrl: string, filename: string) => Promise<void>;
  /** Whether AI thumbnail generation is in progress */
  isGeneratingAi: boolean;
}

/**
 * Hook for managing YouTube thumbnail operations
 */
export function useYouTubeThumbnails({
  files,
  setYoutubeAutoThumbnails,
  setYoutubeSelectedAutoThumbnail,
  setYoutubeAiGeneratedThumbnails,
  setYoutubeGeneratingAiThumbnail,
}: UseYouTubeThumbnailsProps): UseYouTubeThumbnailsReturn {
  const { toast } = useToast();
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);

  /**
   * Generate auto thumbnails from video at different timestamps
   */
  const generateAutoThumbnails = useCallback(async () => {
    const videoFile = files.find(f => f.fileType === "video");
    if (!videoFile) {
      toast({ 
        title: "No video found", 
        description: "Please upload a video first.", 
        variant: "destructive" 
      });
      return;
    }

    const video = document.createElement("video");
    video.src = videoFile.previewUrl;
    video.crossOrigin = "anonymous";
    video.muted = true;

    return new Promise<void>((resolve) => {
      video.onloadedmetadata = async () => {
        const duration = video.duration;
        const timestamps = [duration * 0.1, duration * 0.5, duration * 0.8];
        const thumbnails: string[] = [];

        for (const time of timestamps) {
          video.currentTime = time;
          await new Promise<void>((seekResolve) => {
            video.onseeked = () => {
              try {
                const canvas = document.createElement("canvas");
                canvas.width = 1280;
                canvas.height = 720;
                const ctx = canvas.getContext("2d");
                if (ctx) {
                  const videoAspect = video.videoWidth / video.videoHeight;
                  const targetAspect = 16 / 9;
                  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;

                  if (videoAspect > targetAspect) {
                    sw = video.videoHeight * targetAspect;
                    sx = (video.videoWidth - sw) / 2;
                  } else {
                    sh = video.videoWidth / targetAspect;
                    sy = (video.videoHeight - sh) / 2;
                  }

                  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 1280, 720);
                  thumbnails.push(canvas.toDataURL("image/jpeg", 0.9));
                }
              } catch (err) {
                console.error("Failed to generate thumbnail frame:", err);
              }
              seekResolve();
            };
          });
        }

        setYoutubeAutoThumbnails(thumbnails);
        setYoutubeSelectedAutoThumbnail(1);
        resolve();
      };
    });
  }, [files, setYoutubeAutoThumbnails, setYoutubeSelectedAutoThumbnail, toast]);

  /**
   * Generate AI-powered thumbnail using image generation
   */
  const generateAiThumbnail = useCallback(async (
    prompt: string,
    refImage?: string
  ) => {
    setIsGeneratingAi(true);
    setYoutubeGeneratingAiThumbnail(true);

    try {
      const { data, error } = await supabase.functions.invoke("generate-image", {
        body: {
          // No model and no quality: generate-image resolves the chain from
          // admin settings and applies the administrator's knobs. 16:9 is the
          // YouTube thumbnail ratio and stays fixed here.
          prompt,
          aspectRatio: "16:9",
          referenceImage: refImage || undefined,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      if (data?.imageUrl) {
        setYoutubeAiGeneratedThumbnails(prev => [...prev, data.imageUrl]);
        toast({ title: "Thumbnail generated!", description: "AI thumbnail has been created." });
      }
    } catch (error) {
      console.error("AI thumbnail generation error:", error);
      toast({ 
        title: "Failed to generate", 
        description: "Could not generate AI thumbnail.", 
        variant: "destructive" 
      });
    } finally {
      setIsGeneratingAi(false);
      setYoutubeGeneratingAiThumbnail(false);
    }
  }, [setYoutubeAiGeneratedThumbnails, setYoutubeGeneratingAiThumbnail, toast]);

  /**
   * Download a thumbnail image
   */
  const downloadThumbnail = useCallback(async (imageUrl: string, filename: string) => {
    try {
      if (imageUrl.startsWith("data:")) {
        const link = document.createElement("a");
        link.href = imageUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
      toast({ title: "Downloaded!", description: "Thumbnail saved to downloads." });
    } catch (error) {
      toast({ 
        title: "Download failed", 
        description: "Could not download thumbnail.", 
        variant: "destructive" 
      });
    }
  }, [toast]);

  return {
    generateAutoThumbnails,
    generateAiThumbnail,
    downloadThumbnail,
    isGeneratingAi,
  };
}
