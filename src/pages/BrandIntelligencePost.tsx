import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation, useParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Mic, Loader2, Sparkles, Copy, Check, Heart, MessageCircle, Eye, Share2, Bookmark, TrendingUp, Image, Video, FileText, ExternalLink, Calendar, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTranscription } from "@/hooks/useTranscription";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { format } from "date-fns";
import type { BrandPost, GeneratedContent } from "@/types/brand-intelligence";

export default function BrandIntelligencePost() {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const location = useLocation();
  const { postId } = useParams<{ postId: string }>();
  const { session } = useAuth();
  const { transcript, language, duration, isTranscribing, error: transcriptionError, transcribe, reset: resetTranscription } = useTranscription();

  const post = (location.state as { post?: BrandPost })?.post;
  const platform = (location.state as { platform?: string })?.platform || "instagram";

  const [cachedTranscript, setCachedTranscript] = useState<string | null>(null);
  const [cachedLanguage, setCachedLanguage] = useState<string | null>(null);
  const [cachedDuration, setCachedDuration] = useState<number | null>(null);
  const [editableTranscript, setEditableTranscript] = useState("");
  const [generatedContent, setGeneratedContent] = useState<GeneratedContent>({ captions: [], imagePrompts: [], videoPrompts: [] });
  const [isGenerating, setIsGenerating] = useState(false);
  const [genLanguage, setGenLanguage] = useState("english");
  const [genTone, setGenTone] = useState("professional");
  const [genPlatform, setGenPlatform] = useState("instagram");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [contentTab, setContentTab] = useState("captions");
  const [dbRecordId, setDbRecordId] = useState<string | null>(null);

  // Redirect if no post data
  useEffect(() => {
    if (!post) {
      navigate("/brand-intelligence", { replace: true });
    }
  }, [post, navigate]);

  // Load cached content from DB
  useEffect(() => {
    if (!session?.user?.id || !postId || !post) return;
    const loadCached = async () => {
      const { data } = await supabase
        .from("bi_post_content")
        .select("*")
        .eq("user_id", session.user.id)
        .eq("post_id", postId)
        .eq("platform", platform)
        .maybeSingle();

      if (data) {
        setDbRecordId(data.id);
        if (data.transcript) {
          setCachedTranscript(data.transcript);
          setCachedLanguage(data.transcript_language);
          setCachedDuration(data.transcript_duration ? Number(data.transcript_duration) : null);
          setEditableTranscript(data.transcript);
        }
        const captions = (data.captions as string[] | null) || [];
        const imagePrompts = (data.image_prompts as string[] | null) || [];
        const videoPrompts = (data.video_prompts as string[] | null) || [];
        if (captions.length || imagePrompts.length || videoPrompts.length) {
          setGeneratedContent({ captions, imagePrompts, videoPrompts });
        }
        if (data.generation_language) setGenLanguage(data.generation_language);
        if (data.generation_tone) setGenTone(data.generation_tone);
        if (data.generation_platform) setGenPlatform(data.generation_platform);
      }
    };
    loadCached();
  }, [session?.user?.id, postId, platform, post]);

  // Sync transcript from hook to state
  useEffect(() => {
    if (transcript && !isTranscribing) {
      setEditableTranscript(transcript);
      setCachedTranscript(transcript);
      setCachedLanguage(language);
      setCachedDuration(duration);
      upsertContent({ transcript, transcript_language: language, transcript_duration: duration });
    }
  }, [transcript, isTranscribing]);

  const upsertContent = useCallback(async (updates: Record<string, unknown>) => {
    if (!session?.user?.id || !postId || !post) return;

    if (dbRecordId) {
      await supabase.from("bi_post_content").update(updates as any).eq("id", dbRecordId);
    } else {
      const payload = {
        user_id: session.user.id,
        post_id: postId,
        platform,
        username: (location.state as { username?: string })?.username || "",
        post_data: post as unknown as Record<string, unknown>,
        ...updates,
        updated_at: new Date().toISOString(),
      };
      const { data } = await supabase.from("bi_post_content").upsert(payload as any, { onConflict: "user_id,post_id,platform" }).select("id").single();
      if (data) setDbRecordId(data.id);
    }
  }, [session?.user?.id, postId, platform, post, dbRecordId, location.state]);

  const handleTranscribe = () => {
    if (!post?.mediaUrl) {
      toast.error(t("errors.noMediaUrl", "No media URL available for transcription"));
      return;
    }
    transcribe(post.mediaUrl);
  };

  const handleGenerate = async () => {
    if (!editableTranscript && !post?.caption) {
      toast.error(t("errors.transcribeFirst", "Transcribe the video first or ensure there's a caption"));
      return;
    }

    setIsGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-caption", {
        body: {
          transcript: editableTranscript || undefined,
          caption: post?.caption || "",
          platform: genPlatform,
          tone: genTone,
          language: genLanguage,
          mode: "brand-intelligence-30",
          postType: post?.mediaType,
        },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      const content: GeneratedContent = {
        captions: data?.captions || [],
        imagePrompts: data?.imagePrompts || [],
        videoPrompts: data?.videoPrompts || [],
      };

      setGeneratedContent(content);
      await upsertContent({
        captions: content.captions,
        image_prompts: content.imagePrompts,
        video_prompts: content.videoPrompts,
        generation_language: genLanguage,
        generation_tone: genTone,
        generation_platform: genPlatform,
      });

      toast.success(t("toast.generated30", "30 content ideas generated!"));
    } catch (err) {
      toast.error((err as Error).message || t("errors.generationFailed", "Generation failed"));
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleUseInPost = (text: string) => {
    navigate("/post", { state: { caption: text } });
  };

  if (!post) return null;

  const hasTranscript = !!cachedTranscript || !!transcript;
  const displayTranscript = editableTranscript || cachedTranscript || transcript || "";
  const displayLanguage = cachedLanguage || language || "unknown";
  const displayDuration = cachedDuration ?? duration ?? 0;

  const stats = [
    { id: "likes", icon: Heart, label: t("stats.likes", "Likes"), value: post.likesCount, color: "text-red-500" },
    { id: "comments", icon: MessageCircle, label: t("stats.comments", "Comments"), value: post.commentsCount, color: "text-blue-500" },
    { id: "views", icon: Eye, label: t("stats.views", "Views"), value: post.videoViewCount || 0, color: "text-green-500" },
    { id: "shares", icon: Share2, label: t("stats.shares", "Shares"), value: post.sharesCount || 0, color: "text-foreground" },
    { id: "saves", icon: Bookmark, label: t("stats.saves", "Saves"), value: post.savesCount || 0, color: "text-amber-500" },
    { id: "score", icon: TrendingUp, label: t("stats.score", "Score"), value: post.engagementScore, color: "text-foreground" },
  ];

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t("video.analysis", "Video Analysis")}</h1>
            <p className="text-sm text-muted-foreground">
              {post.mediaType} • {platform}
            </p>
          </div>
          {hasTranscript && (
            <Badge className="text-white border-0 ms-auto bg-neutral-900 dark:bg-neutral-800">
              <Sparkles className="w-3 h-3 me-1" /> {t("video.transcribed", "Transcribed")}
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Video + Stats */}
          <div className="space-y-4">
            {/* Video Player */}
            <Card>
              <CardContent className="p-0 overflow-hidden rounded-lg">
                {(() => {
                  const isTikTokEmbed = !!post.mediaUrl && /tiktok\.com\/(embed|player)/i.test(post.mediaUrl);
                  const formatDur = (s?: number) => {
                    if (!s || s <= 0) return null;
                    const m = Math.floor(s / 60);
                    const r = Math.floor(s % 60);
                    return `${m}:${r.toString().padStart(2, "0")}`;
                  };
                  const durationLabel = formatDur(post.duration);

                  let player;
                  if (isTikTokEmbed) {
                    player = (
                      <div className="relative w-full bg-black mx-auto" style={{ aspectRatio: "9 / 16", maxHeight: 600 }}>
                        <iframe
                          src={post.mediaUrl}
                          title={t("video.tiktokTitle", "TikTok video")}
                          allow="encrypted-media;"
                          allowFullScreen
                          className="absolute inset-0 w-full h-full border-0"
                        />
                      </div>
                    );
                  } else if (post.mediaUrl) {
                    player = (
                      <video
                        src={post.mediaUrl}
                        poster={post.thumbnailUrl}
                        controls
                        className="w-full aspect-video object-contain bg-black"
                      />
                    );
                  } else if (post.thumbnailUrl) {
                    player = (
                      <img
                        src={post.thumbnailUrl}
                        alt=""
                        className="w-full aspect-video object-cover"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          const t = e.currentTarget;
                          t.style.display = "none";
                          const parent = t.parentElement;
                          if (parent && !parent.querySelector(".thumb-fallback")) {
                            const fb = document.createElement("div");
                            fb.className = "thumb-fallback w-full aspect-video flex items-center justify-center bg-muted";
                            fb.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
                            parent.appendChild(fb);
                          }
                        }}
                      />
                    );
                  } else {
                    player = (
                      <div className="w-full aspect-video flex items-center justify-center bg-muted">
                        <Play className="w-12 h-12 text-muted-foreground" />
                      </div>
                    );
                  }

                  return (
                    <div className="relative">
                      {player}
                      {durationLabel && (
                        <Badge variant="secondary" className="absolute bottom-2 end-2 bg-black/70 text-white border-0 text-xs">
                          ⏱ {durationLabel}
                        </Badge>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Posted on + View on TikTok */}
            {(post.timestamp || post.permalink) && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                {post.timestamp ? (
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {format(new Date(post.timestamp), "MMMM d, yyyy • h:mm a")}
                  </span>
                ) : <span />}
                {post.permalink && (
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" asChild>
                    <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                      {platform === "tiktok" ? t("video.viewOnTikTok", "View on TikTok") : t("video.viewOnOriginal", "View on Original")}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </Button>
                )}
              </div>
            )}

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-2">
              {stats.map(({ id, icon: Icon, label, value, color }) => (
                <Card key={id}>
                  <CardContent className="p-3 text-center">
                    <Icon className={`w-4 h-4 mx-auto mb-1 ${color}`} />
                    <p className="text-sm font-bold">{value.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Caption */}
            {post.caption && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{t("video.description", "Video Description")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{post.caption}</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: Transcription + Generation */}
          <div className="space-y-4">
            {/* Transcription */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Mic className="w-4 h-4 text-foreground" />
                    {t("transcript.title", "Transcription")}
                  </CardTitle>
                  {displayLanguage !== "unknown" && (
                    <Badge variant="secondary" className="text-[10px]">🌐 {displayLanguage}</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {!hasTranscript && !isTranscribing && (
                  <div className="text-center py-6">
                    <Mic className="w-10 h-10 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground mb-3">{t("transcript.extractText", "Extract text from this video")}</p>
                    <Button onClick={handleTranscribe} className="gap-2 text-primary-foreground bg-primary">
                      <Mic className="w-4 h-4" /> {t("actions.transcribeVideo", "Transcribe Video")}
                    </Button>
                  </div>
                )}

                {isTranscribing && (
                  <div className="text-center py-6">
                    <Loader2 className="w-8 h-8 animate-spin text-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{t("transcript.transcribingShort", "Transcribing audio...")}</p>
                  </div>
                )}

                {transcriptionError && (
                  <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                    {transcriptionError}
                    <Button variant="outline" size="sm" className="mt-2 w-full" onClick={handleTranscribe}>
                      {t("common:retry", "Retry")}
                    </Button>
                  </div>
                )}

                {hasTranscript && !isTranscribing && (
                  <>
                    <Textarea
                      value={editableTranscript}
                      onChange={(e) => setEditableTranscript(e.target.value)}
                      rows={6}
                      className="text-sm resize-none"
                    />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">{t("transcript.chars", "{{count}} chars", { count: editableTranscript.length })}</span>
                        {displayDuration > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            ⏱ {Math.floor(displayDuration / 60)}:{Math.round(displayDuration % 60).toString().padStart(2, "0")}
                          </span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs gap-1"
                        onClick={() => {
                          upsertContent({ transcript: editableTranscript });
                          toast.success(t("toast.transcriptSaved", "Transcript saved"));
                        }}
                      >
                        {t("common:saveChanges", "Save Changes")}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Content Generation */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-foreground" />
                  {t("video.aiIdeas", "AI Content Ideas")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Generation Controls */}
                <div className="grid grid-cols-3 gap-2">
                  <Select value={genLanguage} onValueChange={setGenLanguage}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="english">{t("content.englishPlain", "English")}</SelectItem>
                      <SelectItem value="arabic">{t("content.arabicPlain", "Arabic")}</SelectItem>
                      <SelectItem value="both">{t("content.both", "Both")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={genTone} onValueChange={setGenTone}>
                    <SelectTrigger className="h-8 text-xs">
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
                  <Select value={genPlatform} onValueChange={setGenPlatform}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="instagram">{t("brand.instagram", "Instagram")}</SelectItem>
                      <SelectItem value="tiktok">{t("brand.tiktok", "TikTok")}</SelectItem>
                      <SelectItem value="facebook">{t("brand.facebook", "Facebook")}</SelectItem>
                      <SelectItem value="threads">{t("brand.threads", "Threads")}</SelectItem>
                      <SelectItem value="twitter">{t("brand.twitter", "Twitter/X")}</SelectItem>
                      <SelectItem value="linkedin">{t("brand.linkedin", "LinkedIn")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="w-full gap-2 border-0 text-white bg-neutral-900 dark:bg-neutral-800"
                >
                  {isGenerating ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> {t("content.generating", "Generating...")}</>
                  ) : (
                    <><Sparkles className="w-4 h-4" /> {t("actions.generate30Plain", "Generate 30 Ideas")}</>
                  )}
                </Button>

                {/* Results */}
                {(generatedContent.captions.length > 0 || generatedContent.imagePrompts.length > 0 || generatedContent.videoPrompts.length > 0) && (
                  <>
                    <Separator />
                    <Tabs value={contentTab} onValueChange={setContentTab}>
                      <TabsList className="w-full">
                        <TabsTrigger value="captions" className="flex-1 gap-1 text-xs">
                          <FileText className="w-3 h-3" />
                          {t("content.captionsShort", "Captions ({{count}})", { count: generatedContent.captions.length })}
                        </TabsTrigger>
                        <TabsTrigger value="images" className="flex-1 gap-1 text-xs">
                          <Image className="w-3 h-3" />
                          {t("content.imagesShort", "Images ({{count}})", { count: generatedContent.imagePrompts.length })}
                        </TabsTrigger>
                        <TabsTrigger value="videos" className="flex-1 gap-1 text-xs">
                          <Video className="w-3 h-3" />
                          {t("content.videosShort", "Videos ({{count}})", { count: generatedContent.videoPrompts.length })}
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="captions" className="mt-3 max-h-[400px] overflow-y-auto space-y-2">
                        {generatedContent.captions.map((caption, i) => (
                          <div key={i} className="group p-3 rounded-lg border border-border/50 bg-muted/30 hover:bg-muted/50 transition-colors">
                            <p className="text-sm whitespace-pre-wrap mb-2">{caption}</p>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1" onClick={() => copyToClipboard(caption, i)}>
                                {copiedIndex === i ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                {copiedIndex === i ? t("common:copied", "Copied") : t("common:copy", "Copy")}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1" onClick={() => handleUseInPost(caption)}>
                                {t("actions.useInPost", "Use in Post")}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </TabsContent>

                      <TabsContent value="images" className="mt-3 max-h-[400px] overflow-y-auto space-y-2">
                        {generatedContent.imagePrompts.map((prompt, i) => (
                          <div key={i} className="group p-3 rounded-lg border border-border/50 bg-muted/30 hover:bg-muted/50 transition-colors">
                            <p className="text-sm whitespace-pre-wrap mb-2">{prompt}</p>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1" onClick={() => copyToClipboard(prompt, 1000 + i)}>
                                {copiedIndex === 1000 + i ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                {copiedIndex === 1000 + i ? t("common:copied", "Copied") : t("common:copy", "Copy")}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </TabsContent>

                      <TabsContent value="videos" className="mt-3 max-h-[400px] overflow-y-auto space-y-2">
                        {generatedContent.videoPrompts.map((prompt, i) => (
                          <div key={i} className="group p-3 rounded-lg border border-border/50 bg-muted/30 hover:bg-muted/50 transition-colors">
                            <p className="text-sm whitespace-pre-wrap mb-2">{prompt}</p>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] gap-1" onClick={() => copyToClipboard(prompt, 2000 + i)}>
                                {copiedIndex === 2000 + i ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                {copiedIndex === 2000 + i ? t("common:copied", "Copied") : t("common:copy", "Copy")}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </TabsContent>
                    </Tabs>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
