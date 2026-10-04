import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Pencil, Rocket, ThumbsUp, ThumbsDown, Save, Sparkles, Loader2 } from "lucide-react";
import { useContentGeneration } from "@/hooks/useContentGeneration";
import { useToast } from "@/hooks/use-toast";
import type { BrandPost, ContentLanguage, ContentTone, BrandPlatform } from "@/types/brand-intelligence";

interface ContentGenerationPanelProps {
  sourceText: string;
  sourcePost: BrandPost;
}

function PromptCard({ text, index, onUse, showGenerateImage }: { text: string; index: number; onUse: (text: string) => void; showGenerateImage?: boolean }) {
  const { t } = useTranslation("analytics");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleGenerateImage = () => {
    // Store prompt in localStorage for image generation page to pick up
    localStorage.setItem("bi_image_prompt", text);
    navigate("/post", { state: { caption: `🎨 Image Prompt:\n${text}` } });
    toast({ title: t("content.promptCopied", "Prompt copied to post"), description: t("content.promptCopiedDesc", "You can now generate the image using AI") });
  };

  const isLong = text.length > 200;

  return (
    <Card className="animate-[fadeSlideUp_0.3s_ease-out_both]" style={{ animationDelay: `${index * 60}ms` }}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">
            {String(index + 1).padStart(2, "0")}
          </Badge>
          <p className={`text-sm flex-1 ${!expanded && isLong ? "line-clamp-3" : ""}`}>{text}</p>
        </div>
        {isLong && (
          <button className="text-xs text-foreground hover:underline" onClick={() => setExpanded(!expanded)}>
            {expanded ? t("actions.showLess", "Show less") : t("actions.showMore", "Show more")}
          </button>
        )}
        <div className="flex items-center gap-1 flex-wrap">
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleCopy}>
            {copied ? <><Check className="w-3 h-3 text-emerald-500" /> {t("content.copiedBang", "Copied!")}</> : <><Copy className="w-3 h-3" /> {t("common:copy", "Copy")}</>}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => onUse(text)}>
            <Rocket className="w-3 h-3" /> {t("actions.useInPost", "Use in Post")}
          </Button>
          {showGenerateImage && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleGenerateImage}>
              <Pencil className="w-3 h-3" /> {t("actions.generateImage", "🎨 Generate Image")}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"><ThumbsUp className="w-3 h-3" /></Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"><ThumbsDown className="w-3 h-3" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ContentGenerationPanel({ sourceText, sourcePost }: ContentGenerationPanelProps) {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const [language, setLanguage] = useState<ContentLanguage>("english");
  const [tone, setTone] = useState<ContentTone>("professional");
  const [platform, setPlatform] = useState<BrandPlatform>("instagram");
  const { content, isGenerating, generate, saveCollection } = useContentGeneration();

  const handleGenerate = () => {
    generate({ sourceText, language, tone, platform });
  };

  const handleUseInPost = (caption: string) => {
    navigate("/post", { state: { caption } });
  };

  const handleSave = () => {
    saveCollection({
      sourcePostUrl: sourcePost.permalink,
      sourceUsername: "",
      sourcePlatform: "instagram",
      sourceCaption: sourcePost.caption,
      language,
      tone,
      targetPlatform: platform,
    });
  };

  const hasContent = content.captions.length > 0 || content.imagePrompts.length > 0 || content.videoPrompts.length > 0;

  return (
    <div className="space-y-3 animate-[fadeSlideUp_0.3s_ease-out]">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" value={language} onValueChange={(v) => v && setLanguage(v as ContentLanguage)} className="gap-0.5">
          <ToggleGroupItem value="arabic" className="text-xs h-8 px-2">{t("content.arabic", "🇸🇦 Arabic")}</ToggleGroupItem>
          <ToggleGroupItem value="english" className="text-xs h-8 px-2">{t("content.english", "🇺🇸 English")}</ToggleGroupItem>
          <ToggleGroupItem value="both" className="text-xs h-8 px-2">{t("content.both", "Both")}</ToggleGroupItem>
        </ToggleGroup>

        <Select value={tone} onValueChange={(v) => setTone(v as ContentTone)}>
          <SelectTrigger className="w-[130px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="professional">{t("content.professional", "Professional")}</SelectItem>
            <SelectItem value="casual">{t("content.casual", "Casual")}</SelectItem>
            <SelectItem value="inspirational">{t("content.inspirational", "Inspirational")}</SelectItem>
            <SelectItem value="educational">{t("content.educational", "Educational")}</SelectItem>
            <SelectItem value="humorous">{t("content.humorous", "Humorous")}</SelectItem>
          </SelectContent>
        </Select>

        <ToggleGroup type="single" value={platform} onValueChange={(v) => v && setPlatform(v as BrandPlatform)} className="gap-0.5">
          <ToggleGroupItem value="instagram" className="text-xs h-8 px-2">{t("content.ig", "📸 IG")}</ToggleGroupItem>
          <ToggleGroupItem value="threads" className="text-xs h-8 px-2">{t("content.threadsShort", "🧵 Threads")}</ToggleGroupItem>
          <ToggleGroupItem value="facebook" className="text-xs h-8 px-2">{t("content.fb", "👍 FB")}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Button
        className="w-full gap-2 text-white border-0 bg-neutral-900 dark:bg-neutral-800 hover:bg-neutral-800 dark:hover:bg-neutral-700"
        onClick={handleGenerate}
        disabled={isGenerating}
      >
        {isGenerating ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> {t("content.generating", "Generating...")}</>
        ) : (
          <><Sparkles className="w-4 h-4" /> {t("content.generate30", "✨ Generate 30 Ideas")}</>
        )}
      </Button>

      {/* Loading skeletons */}
      {isGenerating && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {/* Results */}
      {hasContent && !isGenerating && (
        <>
          <Tabs defaultValue="captions">
            <TabsList className="w-full">
              <TabsTrigger value="captions" className="flex-1 text-xs">
                {t("content.captions", "📝 Captions ({{count}})", { count: content.captions.length })}
              </TabsTrigger>
              <TabsTrigger value="images" className="flex-1 text-xs">
                {t("content.imagePrompts", "🖼 Image Prompts ({{count}})", { count: content.imagePrompts.length })}
              </TabsTrigger>
              <TabsTrigger value="videos" className="flex-1 text-xs">
                {t("content.videoPrompts", "🎬 Video Prompts ({{count}})", { count: content.videoPrompts.length })}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="captions" className="space-y-2 mt-2">
              {content.captions.map((c, i) => (
                <PromptCard key={i} text={c} index={i} onUse={handleUseInPost} />
              ))}
            </TabsContent>

            <TabsContent value="images" className="space-y-2 mt-2">
              {content.imagePrompts.map((c, i) => (
                <PromptCard key={i} text={c} index={i} onUse={handleUseInPost} showGenerateImage />
              ))}
            </TabsContent>

            <TabsContent value="videos" className="space-y-2 mt-2">
              {content.videoPrompts.map((c, i) => (
                <PromptCard key={i} text={c} index={i} onUse={handleUseInPost} />
              ))}
            </TabsContent>
          </Tabs>

          <Button variant="outline" className="w-full gap-2" onClick={handleSave}>
            <Save className="w-4 h-4" /> {t("content.saveCollection", "💾 Save Collection")}
          </Button>
        </>
      )}
    </div>
  );
}
