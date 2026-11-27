import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, Sparkles, Loader2, Check, Download, AudioLines } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTranscription } from "@/hooks/useTranscription";
import { getErrorStatus, handleAIError } from "@/lib/aiErrorHandler";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { upsertChaptersBlock } from "../../../../supabase/functions/_shared/youtubeChapters";
import {
  segmentsToSrt,
  segmentsToTimedOutline,
  segmentsToVtt,
} from "../../../../supabase/functions/_shared/youtubeTranscriptFormats";
import { buildYouTubeSuggestContext } from "./youtubeSuggestContext";

interface YouTubeAISuggestionsProps {
  type: "title" | "description" | "tags" | "chapters";
  context?: string;
  secondaryContext?: string;
  durationSeconds?: number | null;
  videoSourceUrl?: string | null;
  currentDescription?: string;
  onSelect: (value: string) => void;
  onAudioSubtitlesReady?: (captions: { srt: string; vtt: string } | null) => void;
}

export function YouTubeAISuggestions(props: YouTubeAISuggestionsProps) {
  if (props.type === "chapters") return <YouTubeChapterSuggestions {...props} />;
  return <YouTubeLegacyAISuggestions {...props} type={props.type} />;
}

type YouTubeLegacyAISuggestionsProps = Omit<YouTubeAISuggestionsProps, "type"> & {
  type: "title" | "description" | "tags";
};

function YouTubeLegacyAISuggestions({ type, context = "", secondaryContext, onSelect }: YouTubeLegacyAISuggestionsProps) {
  const { t } = useTranslation("postsettings");
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [language, setLanguage] = useState<"english" | "arabic">("english");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { toast } = useToast();

  const handleGenerate = async () => {
    if (!context.trim()) {
      toast({
        title: t("youtubeAI.enterContentFirstTitle", "Enter content first"),
        description: type === "title"
          ? t("youtubeAI.writeTitleOrCaption", "Write a title or caption to get AI suggestions.")
          : type === "description"
          ? t("youtubeAI.writeTitleFirst", "Write a title first to generate a description.")
          : t("youtubeAI.writeTitleAndDesc", "Write a title and description to get tag suggestions."),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setSuggestions([]);
    setSelectedIndex(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error(t("youtubeAI.signInRequired", "Please sign in to use AI features."));

      const requestType = type === "title" ? "youtube_title"
        : type === "description" ? "youtube_description"
        : "youtube_tags";

      const { data, error } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: buildYouTubeSuggestContext(type, context, secondaryContext),
          platform: "youtube",
          language,
          requestType,
        },
      });

      if (error) {
        const status = getErrorStatus(error);
        if (status === 401 || status === 402 || status === 429) {
          handleAIError({ status, message: error.message }, "YouTube AI");
          return;
        }
        throw error;
      }

      if (data?.error) throw new Error(data.error);

      if (data?.suggestions) {
        setSuggestions(data.suggestions);
      } else if (data?.captions) {
        setSuggestions(data.captions);
      }
    } catch (err) {
      handleAIError(err, "YouTube AI suggestion");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelect = (index: number) => {
    setSelectedIndex(index);
    onSelect(suggestions[index]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select value={language} onValueChange={(v) => setLanguage(v as "english" | "arabic")}>
          <SelectTrigger className="w-28 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="english">{t("youtubeAI.langEnglish", "English")}</SelectItem>
            <SelectItem value="arabic">{t("youtubeAI.langArabic", "العربية")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={isLoading || !context.trim()}
          className="gap-1.5"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {t("youtubeAI.aiSuggestBtn", "AI Suggest")}
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="space-y-1.5">
          {type === "tags" ? (
            <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-secondary/50 border border-border">
              {suggestions.map((tagSet, idx) => (
                <Badge
                  key={idx}
                  variant={selectedIndex === idx ? "default" : "outline"}
                  className="cursor-pointer transition-all hover:scale-105 text-xs"
                  onClick={() => handleSelect(idx)}
                >
                  {selectedIndex === idx && <Check className="w-3 h-3 me-1" />}
                  {tagSet}
                </Badge>
              ))}
            </div>
          ) : (
            suggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSelect(idx)}
                className={`w-full text-start p-2.5 rounded-lg border text-sm transition-all ${
                  selectedIndex === idx
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border hover:border-primary/40 hover:bg-secondary/50"
                }`}
              >
                <div className="flex items-start gap-2">
                  {selectedIndex === idx && <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />}
                  <span className="line-clamp-3">{suggestion}</span>
                </div>
              </button>
            ))
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("youtubeAI.clickSuggestionHelp", "Click a suggestion to use it")}
          </p>
        </div>
      )}
    </div>
  );
}

function formatVideoDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function normalizeDurationSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 30 && floored <= 43200 ? floored : null;
}

function useDetectedVideoDuration(
  videoSourceUrl: string | null | undefined,
  explicitDurationSeconds: number | null | undefined,
): number | null {
  const explicit = normalizeDurationSeconds(explicitDurationSeconds);
  const [probed, setProbed] = useState<{ url: string; seconds: number | null } | null>(null);

  useEffect(() => {
    if (explicit !== null || !videoSourceUrl) return;
    let active = true;
    const video = document.createElement("video");
    video.preload = "metadata";
    const handleLoaded = () => {
      if (!active) return;
      setProbed({ url: videoSourceUrl, seconds: normalizeDurationSeconds(video.duration) });
    };
    const handleError = () => {
      if (!active) return;
      setProbed({ url: videoSourceUrl, seconds: null });
    };
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("error", handleError);
    video.src = videoSourceUrl;
    return () => {
      active = false;
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      video.removeAttribute("src");
    };
  }, [explicit, videoSourceUrl]);

  if (explicit !== null) return explicit;
  if (!videoSourceUrl) return null;
  return probed?.url === videoSourceUrl ? probed.seconds : null;
}

type AudioExtractState =
  | {
      sourceKey: string;
      status: "ready";
      srt: string;
      vtt: string;
    }
  | {
      sourceKey: string;
      status: "no_timing";
    };

function downloadSubtitlesFile(content: string, format: "srt" | "vtt"): void {
  const mimeType =
    format === "srt"
      ? "application/x-subrip;charset=utf-8"
      : "text/vtt;charset=utf-8";
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `subtitles.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function YouTubeChapterSuggestions({
  durationSeconds,
  videoSourceUrl,
  currentDescription,
  onSelect,
  onAudioSubtitlesReady,
}: YouTubeAISuggestionsProps) {
  const { t } = useTranslation("postsettings");
  const { toast } = useToast();
  const {
    transcribe,
    isTranscribing,
    error: transcriptionError,
    reset: resetTranscription,
  } = useTranscription();
  const [outline, setOutline] = useState("");
  const [language, setLanguage] = useState<"english" | "arabic">("english");
  const [timing, setTiming] = useState<"provided" | "estimated">("provided");
  const [isLoading, setIsLoading] = useState(false);
  const [previewState, setPreviewState] = useState<{
    block: string;
    timing: "provided" | "estimated";
    videoKey: string;
  } | null>(null);
  const [audioExtractState, setAudioExtractState] = useState<AudioExtractState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolvedDurationSeconds = useDetectedVideoDuration(videoSourceUrl, durationSeconds);
  const currentVideoKey = `${videoSourceUrl ?? ""}::${resolvedDurationSeconds ?? "unknown"}`;
  const preview = previewState?.videoKey === currentVideoKey ? previewState : null;

  const trimmedVideoSourceUrl = typeof videoSourceUrl === "string" ? videoSourceUrl.trim() : "";
  const isHttpsVideoUrl = /^https:\/\//i.test(trimmedVideoSourceUrl);
  const activeAudioExtract =
    isHttpsVideoUrl && audioExtractState?.sourceKey === trimmedVideoSourceUrl
      ? audioExtractState
      : null;

  useEffect(() => {
    resetTranscription();
  }, [trimmedVideoSourceUrl, resetTranscription]);

  const handleExtractFromAudio = async () => {
    if (!isHttpsVideoUrl || isTranscribing || isLoading) return;
    const requestSourceKey = trimmedVideoSourceUrl;
    setError(null);
    setAudioExtractState(null);
    const result = await transcribe(requestSourceKey);
    if (!result) {
      onAudioSubtitlesReady?.(null);
      return;
    }
    const segments = result.segments;
    if (Array.isArray(segments) && segments.length > 0) {
      const timedOutline = segmentsToTimedOutline(segments, 8000);
      const srt = segmentsToSrt(segments);
      const vtt = segmentsToVtt(segments);
      if (timedOutline.length > 0) {
        setOutline(timedOutline);
        setTiming("provided");
        setAudioExtractState({
          sourceKey: requestSourceKey,
          status: "ready",
          srt,
          vtt,
        });
        onAudioSubtitlesReady?.({ srt, vtt });
        return;
      }
    }
    setAudioExtractState({
      sourceKey: requestSourceKey,
      status: "no_timing",
    });
    onAudioSubtitlesReady?.(null);
  };

  const handleGenerate = async () => {
    const requestVideoKey = currentVideoKey;
    const requestDurationSeconds = resolvedDurationSeconds;
    setIsLoading(true);
    setPreviewState(null);
    setError(null);
    resetTranscription();
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error(t("youtubeAI.signInRequired", "Please sign in to use AI features."));
      const { data, error: invokeError } = await supabase.functions.invoke("generate-caption", {
        body: {
          context: outline,
          platform: "youtube",
          language,
          requestType: "youtube_chapters",
          durationSeconds: requestDurationSeconds ?? undefined,
          timing,
        },
        timeout: 45000,
      });
      if (invokeError) {
        const status = getErrorStatus(invokeError);
        if (status === 401 || status === 402 || status === 429) {
          handleAIError({ status, message: invokeError.message }, "YouTube AI");
          return;
        }
        if (status === 422) {
          setError(t("youtubeAI.chapters.invalid", "The AI returned invalid chapters. Check your outline and try again."));
          return;
        }
        throw invokeError;
      }
      if (data?.error === "chapters_invalid") {
        setError(t("youtubeAI.chapters.invalid", "The AI returned invalid chapters. Check your outline and try again."));
        return;
      }
      if (data?.error) throw new Error(data.error);
      const block = Array.isArray(data?.suggestions) && typeof data.suggestions[0] === "string" ? data.suggestions[0] : null;
      if (!block) {
        setError(t("youtubeAI.chapters.invalid", "The AI returned invalid chapters. Check your outline and try again."));
        return;
      }
      setPreviewState({
        block,
        timing: data.timing === "estimated" ? "estimated" : timing,
        videoKey: requestVideoKey,
      });
    } catch (err) {
      handleAIError(err, "YouTube AI chapters");
    } finally {
      setIsLoading(false);
    }
  };

  const handleInsert = () => {
    if (!preview || preview.videoKey !== currentVideoKey) return;
    const result = upsertChaptersBlock(currentDescription ?? "", preview.block, 5000);
    if (!result.ok) {
      const message = t("youtubeAI.chapters.tooLong", "The description would exceed 5,000 characters. Shorten it before inserting chapters.");
      setError(message);
      toast({ title: t("youtubeAI.chapters.insertFailed", "Chapters were not inserted"), description: message, variant: "destructive" });
      return;
    }
    setError(null);
    onSelect(result.value);
  };

  const durationLabel = resolvedDurationSeconds == null
    ? t("youtubeAI.chapters.durationUnknown", "Unknown")
    : formatVideoDuration(resolvedDurationSeconds);
  const displayedError = error ?? transcriptionError;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExtractFromAudio}
            disabled={!isHttpsVideoUrl || isTranscribing || isLoading}
            className="gap-1.5"
          >
            {isTranscribing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <AudioLines className="w-3.5 h-3.5" />
            )}
            {isTranscribing
              ? t("youtubeAI.chapters.fromAudio.extracting", "Extracting timestamps from audio…")
              : t("youtubeAI.chapters.fromAudio.extractBtn", "Extract chapters and subtitles from the video's audio")}
          </Button>
          {activeAudioExtract?.status === "ready" && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadSubtitlesFile(activeAudioExtract.srt, "srt")}
                className="gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                {t("youtubeAI.chapters.fromAudio.downloadSrt", "Download .srt")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadSubtitlesFile(activeAudioExtract.vtt, "vtt")}
                className="gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                {t("youtubeAI.chapters.fromAudio.downloadVtt", "Download .vtt")}
              </Button>
            </>
          )}
        </div>
        {!isHttpsVideoUrl && (
          <p className="text-xs text-muted-foreground">
            {t("youtubeAI.chapters.fromAudio.uploadFirstHint", "Available after the video is uploaded")}
          </p>
        )}
        {activeAudioExtract?.status === "ready" && (
          <p className="text-xs text-muted-foreground">
            {t(
              "youtubeAI.chapters.fromAudio.readyHint",
              "Timed outline filled from audio. You can now generate chapters or download subtitles.",
            )}
          </p>
        )}
        {activeAudioExtract?.status === "no_timing" && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              "youtubeAI.chapters.fromAudio.noTiming",
              "This transcription has no timing, so chapters and subtitles cannot be built from it",
            )}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="youtube-chapter-outline">
          {t("youtubeAI.chapters.outlineLabel", "Timed outline")}
        </label>
        <Textarea
          id="youtube-chapter-outline"
          aria-label={t("youtubeAI.chapters.outlineLabel", "Timed outline")}
          value={outline}
          onChange={(event) => setOutline(event.target.value)}
          maxLength={8000}
          placeholder={t("youtubeAI.chapters.outlinePlaceholder", "00:00 Introduction\n00:30 Main topic\n01:30 Conclusion")}
          className="min-h-[110px] font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {t("youtubeAI.chapters.duration", "Video duration: {{duration}}", { duration: durationLabel })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={timing} onValueChange={(value) => setTiming(value as "provided" | "estimated")}>
          <SelectTrigger className="w-40 h-8" aria-label={t("youtubeAI.chapters.timingLabel", "Chapter timing")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="provided">{t("youtubeAI.chapters.timingProvided", "Use my timestamps")}</SelectItem>
            <SelectItem value="estimated">{t("youtubeAI.chapters.timingEstimated", "Estimate timestamps")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={language} onValueChange={(value) => setLanguage(value as "english" | "arabic")}>
          <SelectTrigger className="w-28 h-8" aria-label={t("youtubeAI.chapters.languageLabel", "Chapter language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="english">{t("youtubeAI.langEnglish", "English")}</SelectItem>
            <SelectItem value="arabic">{t("youtubeAI.langArabic", "العربية")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={handleGenerate} disabled={isLoading || !outline.trim()} className="gap-1.5">
          {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {isLoading
            ? t("youtubeAI.chapters.generating", "Generating…")
            : t("youtubeAI.chapters.generate", "Generate chapters")}
        </Button>
      </div>
      {displayedError && <p role="alert" className="text-xs text-destructive">{displayedError}</p>}
      {preview && (
        <div className="space-y-2">
          {preview.timing === "estimated" && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("youtubeAI.chapters.estimateWarning", "These times are estimates. Check them against your video before publishing.")}</span>
            </div>
          )}
          <pre aria-label={t("youtubeAI.chapters.previewLabel", "Chapter preview")} className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary/50 p-3 font-mono text-xs">{preview.block}</pre>
          <Button type="button" size="sm" onClick={handleInsert}>
            {t("youtubeAI.chapters.insert", "Insert chapters")}
          </Button>
        </div>
      )}
    </div>
  );
}
