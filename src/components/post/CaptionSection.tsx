import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sparkles, Loader2, AlertTriangle, Check, Save, Copy } from "lucide-react";
import { Platform } from "@/lib/types";
import { CharacterCounter } from "./CharacterCounter";
import { HashtagSuggestions } from "./HashtagSuggestions";
import { UnsplashAttributionAlert, UnsplashAttributionBadge } from "./UnsplashAttributionAlert";
import { CaptionHistorySection } from "./CaptionHistorySection";
import { supabase } from "@/integrations/supabase/client";
import { handleAIError } from "@/lib/aiErrorHandler";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useAIRateLimit } from "@/hooks/useAIRateLimit";
import { useCaptionHistory } from "@/hooks/useCaptionHistory";
import { RateLimitIndicator } from "./RateLimitIndicator";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { UnsplashAttributionData } from "@/lib/unsplashAttribution";
import { Icon3D, GradientHeading, GradientRingCard } from "@/components/fx";

interface CaptionSectionProps {
  caption: string;
  setCaption: (caption: string) => void;
  selectedPlatforms: Platform[];
  aiModel?: string;
  showSuccessToast: (title: string, description: string) => void;
  /** Unsplash attribution data if an Unsplash image is selected */
  unsplashAttribution?: UnsplashAttributionData | null;
  /** Whether the caption has valid attribution */
  isAttributionValid?: boolean;
}

// Platform character limits
const platformLimits: Record<Platform, number> = {
  facebook: 63206,
  instagram: 2200,
  tiktok: 4000,
  twitter: 280,
  linkedin: 3000,
  pinterest: 500,
  youtube: 5000,
  threads: 500,
  bluesky: 300,
  reddit: 40000,
  whatsapp: 4096,
};

export function CaptionSection({
  caption,
  setCaption,
  selectedPlatforms,
  aiModel,
  showSuccessToast,
  unsplashAttribution,
  isAttributionValid = true,
}: CaptionSectionProps) {
  const { flags } = useFeatureFlags();
  const { captionLimit, refreshLimits } = useAIRateLimit();
  const { save: saveToHistory } = useCaptionHistory();
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGeneratingCaption, setIsGeneratingCaption] = useState(false);
  const [language, setLanguage] = useState<"english" | "arabic">("english");
  const [selectedTone, setSelectedTone] = useState<string>("Engaging");
  const [captionOptions, setCaptionOptions] = useState<string[]>([]);
  const [savedIndices, setSavedIndices] = useState<Set<number>>(new Set());

  // Calculate the lowest character limit among selected platforms
  const { lowestLimit, lowestPlatform, isOverLimit, isNearLimit } = useMemo(() => {
    if (selectedPlatforms.length === 0) {
      return { lowestLimit: Infinity, lowestPlatform: null, isOverLimit: false, isNearLimit: false };
    }
    
    let minLimit = Infinity;
    let minPlatform: Platform | null = null;
    
    for (const platform of selectedPlatforms) {
      const limit = platformLimits[platform];
      if (limit < minLimit) {
        minLimit = limit;
        minPlatform = platform;
      }
    }
    
    const percentage = (caption.length / minLimit) * 100;
    return {
      lowestLimit: minLimit,
      lowestPlatform: minPlatform,
      isOverLimit: caption.length > minLimit,
      isNearLimit: percentage >= 90 && caption.length <= minLimit,
    };
  }, [selectedPlatforms, caption.length]);

  const handleGenerateCaption = async () => {
    if (!aiPrompt.trim()) return;

    setIsGeneratingCaption(true);
    setCaptionOptions([]);

    try {
      const { data, error } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: aiPrompt,
          platform: selectedPlatforms[0] || "instagram",
          tone: selectedTone.toLowerCase(),
          language,
          model: aiModel || "google/gemini-2.5-flash",
        },
      });

      if (error) throw error;

      // Structured failure (200 + success:false) from edge function
      if (data && data.success === false) {
        throw new Error(data.message || "AI caption generation failed. Please try again.");
      }

      if (data?.captions && Array.isArray(data.captions) && data.captions.length > 0) {
        setCaptionOptions(data.captions);
        showSuccessToast("Captions generated!", "Pick one of the 5 options below.");
        refreshLimits();
      } else if (data?.caption) {
        // Fallback for single caption response
        setCaptionOptions([data.caption]);
        showSuccessToast("Caption generated!", "Your AI-generated caption is ready.");
        refreshLimits();
      } else if (data?.error) {
        throw new Error(data.error);
      }
    } catch (error) {
      handleAIError(error, "Caption generation");
    } finally {
      setIsGeneratingCaption(false);
    }
  };

  const handleSelectCaption = (selectedCaption: string) => {
    setCaption(selectedCaption);
    setAiDialogOpen(false);
    setAiPrompt("");
    setCaptionOptions([]);
    setSavedIndices(new Set());
  };

  const handleSaveOption = async (index: number, text: string) => {
    if (savedIndices.has(index)) return;
    try {
      await saveToHistory(text, {
        language,
        tone: selectedTone,
        platform: selectedPlatforms[0] || "instagram",
        prompt: aiPrompt,
      });
      setSavedIndices((prev) => new Set(prev).add(index));
    } catch {
      // toast already shown by hook
    }
  };

  const handleCopyOption = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "Caption copied to clipboard." });
  };

  const isRateLimited = captionLimit.remainingHour === 0 && captionLimit.limitPerHour > 0;

  // Get platform name for display
  const getPlatformName = (platform: Platform | null): string => {
    if (!platform) return "";
    const names: Record<Platform, string> = {
      facebook: "Facebook",
      instagram: "Instagram",
      tiktok: "TikTok",
      twitter: "X/Twitter",
      linkedin: "LinkedIn",
      pinterest: "Pinterest",
      youtube: "YouTube",
      threads: "Threads",
      bluesky: "Bluesky",
      reddit: "Reddit",
      whatsapp: "WhatsApp",
    };
    return names[platform];
  };

  return (
    <>
      {/* Hashtag Generator - only show if AI hashtags feature is enabled */}
      {flags.aiHashtags && (
        <GradientRingCard variant="sky" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Icon3D icon={Sparkles} variant="sky" size="sm" />
            <Label className="text-sm font-semibold bg-clip-text text-transparent bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500">
              Tags / Hashtag Generator
            </Label>
          </div>
          <HashtagSuggestions
            caption={caption}
            platform={selectedPlatforms[0] || "instagram"}
            onAddHashtags={(hashtags) => {
              setCaption(caption + "\n\n" + hashtags.join(" "));
            }}
          />
        </GradientRingCard>
      )}

      {/* Caption Textarea */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label className="text-sm">Title</Label>
            {flags.titleRequired && (
              <span className="text-xs text-destructive">Required for all media posts</span>
            )}
          </div>
          {flags.aiCaption && (
            <Dialog open={aiDialogOpen} onOpenChange={setAiDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1.5 bg-gradient-to-r from-sky-500/15 to-violet-500/15 text-sky-700 dark:text-sky-300 border border-sky-400/40 hover:from-sky-500 hover:to-violet-500 hover:text-white hover:shadow-md hover:shadow-sky-500/30 transition-all"
                >
                  <Sparkles className="w-3 h-3 mr-1" />
                  Generate with AI
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card/80 backdrop-blur-xl border-border/50 shadow-2xl shadow-sky-500/10">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-3 group">
                    <Icon3D icon={Sparkles} variant="sky" size="sm" />
                    <GradientHeading as="h2" size="lg" preset="sky-violet-pink" className="!text-2xl md:!text-3xl">
                      AI Caption Generator
                    </GradientHeading>
                    {captionLimit.limitPerHour > 0 && (
                      <RateLimitIndicator
                        limitPerHour={captionLimit.limitPerHour}
                        limitPerDay={captionLimit.limitPerDay}
                        remainingHour={captionLimit.remainingHour}
                        remainingDay={captionLimit.remainingDay}
                        resetTimeHour={captionLimit.resetTimeHour}
                        resetTimeDay={captionLimit.resetTimeDay}
                        label="Caption Generation"
                        compact
                        className="ml-auto"
                      />
                    )}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  {/* Language Toggle */}
                  <div className="space-y-2">
                    <Label className="text-sm">Language</Label>
                    <div className="flex gap-2">
                      <Button
                        variant={language === "english" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setLanguage("english")}
                        disabled={isRateLimited}
                        className={cn(
                          "flex-1 transition-all",
                          language === "english"
                            ? "bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white border-0 shadow-md shadow-sky-500/30"
                            : "bg-card/50 backdrop-blur-sm border-border/50 hover:border-sky-400/60"
                        )}
                      >
                        English
                      </Button>
                      <Button
                        variant={language === "arabic" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setLanguage("arabic")}
                        disabled={isRateLimited}
                        className={cn(
                          "flex-1 transition-all",
                          language === "arabic"
                            ? "bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white border-0 shadow-md shadow-sky-500/30"
                            : "bg-card/50 backdrop-blur-sm border-border/50 hover:border-sky-400/60"
                        )}
                      >
                        العربية
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>What's your post about?</Label>
                    <Textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder={language === "arabic" 
                        ? "مثال: إطلاق منتج جديد لخط الأزياء المستدامة..."
                        : "e.g., New product launch for our sustainable fashion line..."}
                      className="min-h-[100px] bg-background/60 backdrop-blur-sm border-border/50 focus-visible:border-sky-400 focus-visible:ring-sky-400/30"
                      dir={language === "arabic" ? "rtl" : "ltr"}
                      disabled={isRateLimited}
                    />
                  </div>

                  {/* Tone Selector */}
                  <div className="space-y-2">
                    <Label className="text-sm">Tone</Label>
                    <div className="flex gap-2 flex-wrap">
                      {["Engaging", "Professional", "Funny", "Inspirational"].map((tone) => (
                        <Button
                          key={tone}
                          variant={selectedTone === tone ? "default" : "outline"}
                          size="sm"
                          onClick={() => setSelectedTone(tone)}
                          disabled={isRateLimited}
                          className={cn(
                            "transition-all",
                            selectedTone === tone
                              ? "bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white border-0 shadow-md shadow-sky-500/30"
                              : "bg-card/50 backdrop-blur-sm border-border/50 hover:border-sky-400/60"
                          )}
                        >
                          {tone}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <Button 
                    onClick={handleGenerateCaption} 
                    disabled={isGeneratingCaption || !aiPrompt.trim() || isRateLimited} 
                    className="w-full bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 text-white border-0 shadow-lg shadow-sky-500/30 hover:shadow-sky-500/50 hover:opacity-95 transition-all"
                  >
                    {isGeneratingCaption ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Generating 5 options...
                      </>
                    ) : isRateLimited ? (
                      "Rate limit reached"
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 mr-2" />
                        Generate 5 Captions
                      </>
                    )}
                  </Button>

                  {isRateLimited && (
                    <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-2.5">
                      <p className="text-xs text-rose-700 dark:text-rose-300 text-center font-medium">
                        You've reached your hourly limit. Please wait for it to reset.
                      </p>
                    </GradientRingCard>
                  )}

                  {/* Caption Options */}
                  {captionOptions.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-sm">Pick a caption:</Label>
                      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                        {captionOptions.map((opt, index) => {
                          const isSaved = savedIndices.has(index);
                          return (
                            <div
                              key={index}
                              className="p-3 rounded-xl border border-border/40 bg-card/40 backdrop-blur-sm space-y-2 hover:border-sky-400/60 hover:shadow-md hover:shadow-sky-500/20 transition-all"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-muted-foreground">
                                  Option {index + 1}
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => handleCopyOption(opt)}
                                    title="Copy"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className={cn(
                                      "h-7 px-2 text-xs",
                                      isSaved && "text-sky-500"
                                    )}
                                    onClick={() => handleSaveOption(index, opt)}
                                    disabled={isSaved}
                                    title={isSaved ? "Saved" : "Save to history"}
                                  >
                                    {isSaved ? (
                                      <Check className="w-3 h-3" />
                                    ) : (
                                      <Save className="w-3 h-3" />
                                    )}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="default"
                                    className="h-7 px-2 text-xs bg-gradient-to-r from-sky-500 to-violet-500 text-white border-0 shadow-sm shadow-sky-500/30 hover:shadow-md hover:shadow-sky-500/50"
                                    onClick={() => handleSelectCaption(opt)}
                                  >
                                    Use
                                  </Button>
                                </div>
                              </div>
                              <p
                                className="text-sm leading-relaxed cursor-pointer"
                                dir={language === "arabic" ? "rtl" : "ltr"}
                                onClick={() => handleSelectCaption(opt)}
                              >
                                {opt}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Caption History */}
                  <CaptionHistorySection onUseCaption={handleSelectCaption} />
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
        
        {/* Warning banner for over limit */}
        {isOverLimit && lowestPlatform && (
          <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-2.5">
            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 animate-pulse" />
              <span>
                Caption exceeds {getPlatformName(lowestPlatform)} limit by {(caption.length - lowestLimit).toLocaleString()} characters
              </span>
            </div>
          </GradientRingCard>
        )}
        
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Enter title for your post"
          className={cn(
            "min-h-[120px] resize-none transition-all duration-200 bg-background/60 backdrop-blur-sm border-border/50 focus-visible:border-sky-400 focus-visible:ring-sky-400/30",
            isOverLimit && "border-rose-400 ring-rose-400/30 ring-2 bg-rose-500/5 focus-visible:border-rose-400 focus-visible:ring-rose-400/40",
            isNearLimit && !isOverLimit && "border-amber-400 ring-amber-400/20 ring-1 bg-amber-500/5"
          )}
        />
        
        {/* Unsplash attribution badge inline */}
        {unsplashAttribution && (
          <div className="flex items-center justify-between">
            <CharacterCounter caption={caption} selectedPlatforms={selectedPlatforms} />
            <UnsplashAttributionBadge
              photographerName={unsplashAttribution.photographerName}
              isValid={isAttributionValid}
            />
          </div>
        )}
        {!unsplashAttribution && (
          <CharacterCounter caption={caption} selectedPlatforms={selectedPlatforms} />
        )}
      </div>
      
      {/* Unsplash Attribution Alert */}
      {unsplashAttribution && (
        <UnsplashAttributionAlert
          attribution={unsplashAttribution}
          hasValidAttribution={isAttributionValid}
          className="mt-3"
        />
      )}
    </>
  );
}
