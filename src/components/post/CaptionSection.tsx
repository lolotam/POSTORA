import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("post");
  const { captionLimit, refreshLimits } = useAIRateLimit();
  const { save: saveToHistory } = useCaptionHistory();
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGeneratingCaption, setIsGeneratingCaption] = useState(false);
  const [language, setLanguage] = useState<"english" | "arabic">("english");
  const [selectedTone, setSelectedTone] = useState<string>("Engaging");
  // Opt-in: searching the web first makes generation a few seconds slower.
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [captionOptions, setCaptionOptions] = useState<string[]>([]);
  const [savedIndices, setSavedIndices] = useState<Set<number>>(new Set());

  const tones = [
    { id: "Engaging", label: t("caption.toneEngaging", "Engaging") },
    { id: "Professional", label: t("caption.toneProfessional", "Professional") },
    { id: "Funny", label: t("caption.toneFunny", "Funny") },
    { id: "Inspirational", label: t("caption.toneInspirational", "Inspirational") },
  ];

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
          model: aiModel || "google/gemini-3.1-flash-lite",
          webSearch: useWebSearch,
        },
      });

      if (error) throw error;

      // Structured failure (200 + success:false) from edge function
      if (data && data.success === false) {
        throw new Error(data.message || "AI caption generation failed. Please try again.");
      }

      if (data?.captions && Array.isArray(data.captions) && data.captions.length > 0) {
        setCaptionOptions(data.captions);
        showSuccessToast(t("caption.generatedSuccessTitle", "Captions generated!"), t("caption.generatedSuccessDesc", "Pick one of the 5 options below."));
        refreshLimits();
      } else if (data?.caption) {
        // Fallback for single caption response
        setCaptionOptions([data.caption]);
        showSuccessToast(t("caption.singleGeneratedTitle", "Caption generated!"), t("caption.singleGeneratedDesc", "Your AI-generated caption is ready."));
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
    toast({
      title: t("caption.copiedTitle", "Copied"),
      description: t("caption.copiedDesc", "Caption copied to clipboard."),
    });
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
            <Label className="text-sm font-semibold text-foreground">
              {t("caption.hashtagGenTitle", "Tags / Hashtag Generator")}
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
            <Label className="text-sm">{t("caption.titleLabel", "Title")}</Label>
            {flags.titleRequired && (
              <span className="text-xs text-destructive">{t("caption.requiredMedia", "Required for all media posts")}</span>
            )}
          </div>
          {flags.aiCaption && (
            <Dialog open={aiDialogOpen} onOpenChange={setAiDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1.5 text-foreground dark:text-neutral-200 border border-input hover:text-white hover:shadow-md transition-all bg-muted hover:bg-neutral-800 dark:hover:bg-neutral-700"
                >
                  <Sparkles className="w-3 h-3 me-1" />
                  {t("caption.generateAi", "Generate with AI")}
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border/50 shadow-2xl">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-3 group">
                    <Icon3D icon={Sparkles} variant="sky" size="sm" />
                    <GradientHeading as="h2" size="lg" preset="sky-violet-pink" className="!text-2xl md:!text-3xl">
                      {t("caption.aiGeneratorTitle", "AI Caption Generator")}
                    </GradientHeading>
                    {captionLimit.limitPerHour > 0 && (
                      <RateLimitIndicator
                        limitPerHour={captionLimit.limitPerHour}
                        limitPerDay={captionLimit.limitPerDay}
                        remainingHour={captionLimit.remainingHour}
                        remainingDay={captionLimit.remainingDay}
                        resetTimeHour={captionLimit.resetTimeHour}
                        resetTimeDay={captionLimit.resetTimeDay}
                        label={t("caption.rateLimitLabel", "Caption Generation")}
                        compact
                        className="ms-auto"
                      />
                    )}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                  {/* Language Toggle */}
                  <div className="space-y-2">
                    <Label className="text-sm">{t("caption.languageLabel", "Language")}</Label>
                    <div className="flex gap-2">
                      <Button
                        variant={language === "english" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setLanguage("english")}
                        disabled={isRateLimited}
                        className={cn(
                          "flex-1 transition-all",
                          language === "english"
                            ? "text-white border-0 shadow-md bg-neutral-900 dark:bg-neutral-800"
                            : "bg-card border-border/50 hover:border-input"
                        )}
                      >
                        {t("caption.english", "English")}
                      </Button>
                      <Button
                        variant={language === "arabic" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setLanguage("arabic")}
                        disabled={isRateLimited}
                        className={cn(
                          "flex-1 transition-all",
                          language === "arabic"
                            ? "text-white border-0 shadow-md bg-neutral-900 dark:bg-neutral-800"
                            : "bg-card border-border/50 hover:border-input"
                        )}
                      >
                        {t("caption.arabic", "العربية")}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>{t("caption.promptLabel", "What's your post about?")}</Label>
                    <Textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder={language === "arabic" 
                        ? t("caption.promptPlaceholder", "مثال: إطلاق منتج جديد لخط الأزياء المستدامة...")
                        : "e.g., New product launch for our sustainable fashion line..."}
                      className="min-h-[100px] bg-background border-border/50 focus-visible:border-input focus-visible:ring-ring"
                      dir={language === "arabic" ? "rtl" : "ltr"}
                      disabled={isRateLimited}
                    />
                  </div>

                  {/* Tone Selector */}
                  <div className="space-y-2">
                    <Label className="text-sm">{t("caption.toneLabel", "Tone")}</Label>
                    <div className="flex gap-2 flex-wrap">
                      {tones.map((tone) => (
                        <Button
                          key={tone.id}
                          variant={selectedTone === tone.id ? "default" : "outline"}
                          size="sm"
                          onClick={() => setSelectedTone(tone.id)}
                          disabled={isRateLimited}
                          className={cn(
                            "transition-all",
                            selectedTone === tone.id
                              ? "text-white border-0 shadow-md bg-neutral-900 dark:bg-neutral-800"
                              : "bg-card border-border/50 hover:border-input"
                          )}
                        >
                          {tone.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                    <div className="space-y-1">
                      <Label htmlFor="caption-web-search" className="font-normal">
                        {t("caption.webSearch", "Use web search")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("caption.webSearchHint", "Looks up current information about your topic first. Takes a few seconds longer.")}
                      </p>
                    </div>
                    <Switch
                      id="caption-web-search"
                      aria-label={t("caption.webSearch", "Use web search")}
                      checked={useWebSearch}
                      onCheckedChange={setUseWebSearch}
                      disabled={isGeneratingCaption}
                    />
                  </div>

                  <Button 
                    onClick={handleGenerateCaption} 
                    disabled={isGeneratingCaption || !aiPrompt.trim() || isRateLimited} 
                    className="w-full text-white border-0 shadow-lg hover:opacity-95 transition-all bg-neutral-900 dark:bg-neutral-800"
                  >
                    {isGeneratingCaption ? (
                      <>
                        <Loader2 className="w-4 h-4 me-2 animate-spin" />
                        {t("caption.generatingOptions", "Generating 5 options...")}
                      </>
                    ) : isRateLimited ? (
                      t("caption.rateLimitReached", "Rate limit reached")
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 me-2" />
                        {t("caption.generateFive", "Generate 5 Captions")}
                      </>
                    )}
                  </Button>

                  {isRateLimited && (
                    <GradientRingCard variant="rose" hoverLift={false} ringIntensity="subtle" padded={false} innerClassName="p-2.5">
                      <p className="text-xs text-rose-700 dark:text-rose-300 text-center font-medium">
                        {t("caption.rateLimitBanner", "You've reached your hourly limit. Please wait for it to reset.")}
                      </p>
                    </GradientRingCard>
                  )}

                  {/* Caption Options */}
                  {captionOptions.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-sm">{t("caption.pickCaption", "Pick a caption:")}</Label>
                      <div className="space-y-2 max-h-[300px] overflow-y-auto pe-1">
                        {captionOptions.map((opt, index) => {
                          const isSaved = savedIndices.has(index);
                          return (
                            <div
                              key={index}
                              className="p-3 rounded-xl border border-border/40 bg-card space-y-2 hover:border-input hover:shadow-md transition-all"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-muted-foreground">
                                  {t("caption.optionNumber", "Option {{number}}", { number: index + 1 })}
                                </span>
                                <div className="flex items-center gap-1">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => handleCopyOption(opt)}
                                    title={t("caption.copyTitle", "Copy")}
                                  >
                                    <Copy className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className={cn(
                                      "h-7 px-2 text-xs",
                                      isSaved && "text-foreground"
                                    )}
                                    onClick={() => handleSaveOption(index, opt)}
                                    disabled={isSaved}
                                    title={isSaved ? t("caption.savedTitle", "Saved") : t("caption.saveTitle", "Save to history")}
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
                                    className="h-7 px-2 text-xs text-white border-0 shadow-sm hover:shadow-md bg-neutral-900 dark:bg-neutral-800"
                                    onClick={() => handleSelectCaption(opt)}
                                  >
                                    {t("caption.use", "Use")}
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
                {t("caption.overLimitBanner", "Caption exceeds {{platform}} limit by {{count}} characters", { platform: getPlatformName(lowestPlatform), count: caption.length - lowestLimit })}
              </span>
            </div>
          </GradientRingCard>
        )}
        
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={t("caption.placeholder", "Enter title for your post")}
          className={cn(
            "min-h-[120px] resize-none transition-all duration-200 bg-background border-border/50 focus-visible:border-input focus-visible:ring-ring",
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
