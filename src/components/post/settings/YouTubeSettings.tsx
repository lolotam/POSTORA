import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { YouTubeCategorySelect } from "./YouTubeCategorySelect";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sparkles,
  Loader2,
  Download,
  Upload,
  FolderOpen,
  X,
  HelpCircle,
  ExternalLink,
} from "lucide-react";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { CountryMultiSelect } from "./CountryMultiSelect";
import { YouTubeAISuggestions } from "./YouTubeAISuggestions";
import { MediaLibraryPicker } from "../MediaLibraryPicker";
import { StockMediaPicker, SelectedMedia } from "../StockMediaPicker";
import { UploadedFile } from "@/hooks/usePostForm";
import { Image as ImageIcon } from "lucide-react";
import { ResolvedModelCards } from "@/components/ai/ResolvedModelCards";
import { useResolvedImageModels } from "@/hooks/useResolvedImageModels";
import { useYouTubeCategories } from "@/hooks/useYouTubeCategories";
import { useYouTubePlaylists } from "@/hooks/useYouTubePlaylists";
import { resolveYouTubeVideoTitle } from "../../../../supabase/functions/_shared/youtubeVideoTitle";
import { resolveYoutubePublishAt } from "../../../../supabase/functions/_shared/youtubePublishOptions";

export interface YouTubeSettingsState {
  // Video type
  videoType: "video" | "short";
  title: string;
  description: string;
  visibility: "public" | "unlisted" | "private";
  tags: string;
  category: string;
  /** null until the creator explicitly answers Yes or No. */
  madeForKids: boolean | null;
  allowEmbedding: boolean;
  publicStatsViewable: boolean;
  containsSyntheticMedia: boolean | null;
  hasPaidPromotion: boolean;
  notifySubscribers: boolean;
  commentsEnabled: boolean;
  commentModeration: "none" | "basic" | "strict";
  whoCanComment: "anyone" | "subscribers" | "approved";
  commentSortBy: "top" | "newest";
  showLikeCount: boolean;
  shortsRemixing: "videoAndAudio" | "audioOnly" | "none";
  recordingDate: string;
  videoLocation: string;
  license: "youtube" | "creativeCommon";
  videoLanguage: string;
  audioLanguage: string;
  captionCertification: "none" | "professional" | "auto";
  titleDescLanguage: string;
  thumbnailMode: "upload" | "auto" | "test";
  thumbnailUrl: string;
  /** Authorized media library id, resolved by the worker before signing. */
  thumbnailMediaId: string | null;
  thumbnailFile: File | null;
  playlist: string;
  allowedCountries: string;
  blockedCountries: string;
  firstComment: string;
  enableFirstComment: boolean;
  /** RFC 3339 UTC ISO timestamp when "Schedule on YouTube" is active, or "" / undefined when off. */
  publishAt?: string;
  /** Durable flag that "Schedule on YouTube" mode is selected even before a timestamp is entered. */
  scheduleRequested?: boolean;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
  auth_provider?: "native" | "composio";
  /** The YouTube channel id behind the account; two accounts of one channel share it. */
  platform_user_id?: string | null;
}

interface YouTubeSettingsProps {
  settings: YouTubeSettingsState;
  onSettingsChange: (settings: Partial<YouTubeSettingsState>) => void;
  hasVideo: boolean;
  videoSourceUrl?: string | null;
  autoThumbnails: string[];
  selectedAutoThumbnail: number | null;
  onSelectAutoThumbnail: (index: number | null) => void;
  onGenerateAutoThumbnails: () => Promise<void>;
  aiGeneratedThumbnails: string[];
  onGenerateAiThumbnail: (prompt: string, refImage?: string) => Promise<void>;
  isGeneratingAiThumbnail: boolean;
  onDownloadThumbnail: (url: string, filename: string) => void;
  selectedAccounts?: SelectedAccount[];
  /** Caption used by the native request when no title override was saved. */
  caption?: string;
}

const MAX_THUMBNAIL_REFERENCES = 5;

// A select option cannot carry an empty value, so "no playlist" is a
// sentinel that is translated back to an empty playlist id.
const PLAYLIST_NONE_VALUE = "__none__";

interface DeclarationChoiceProps {
  id: string;
  label: string;
  help: string;
  value: boolean | null;
  /** The selected provider cannot express an affirmative declaration. */
  mismatch: boolean;
  onChange: (value: boolean) => void;
  yesText: string;
  noText: string;
  unsupportedText: string;
}

/** A Yes/No answer must be given; an untouched control is not an answer. */
function DeclarationChoice({
  id,
  label,
  help,
  value,
  mismatch,
  onChange,
  yesText,
  noText,
  unsupportedText,
}: DeclarationChoiceProps) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium flex items-center gap-1">
        {label}
        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent><p>{help}</p></TooltipContent>
        </Tooltip>
      </legend>
      <RadioGroup
        value={value === null ? undefined : value ? "yes" : "no"}
        onValueChange={(answer) => onChange(answer === "yes")}
        className="flex gap-4"
        aria-label={label}
      >
        <label className="flex items-center gap-2 cursor-pointer" htmlFor={`${id}-yes`}>
          <RadioGroupItem id={`${id}-yes`} value="yes" />
          <span className="text-sm">{yesText}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer" htmlFor={`${id}-no`}>
          <RadioGroupItem id={`${id}-no`} value="no" />
          <span className="text-sm">{noText}</span>
        </label>
      </RadioGroup>
      {mismatch && <p className="text-xs text-destructive">{unsupportedText}</p>}
    </fieldset>
  );
}

/**
 * Converts a stored UTC RFC 3339 timestamp into the local `datetime-local`
 * value the browser's date-time input speaks.
 *
 * The picker shows the creator their own wall-clock time; the stored value
 * stays UTC so the schedule means the same instant on every machine.
 */
function toLocalDateTimeValue(utcTimestamp: string): string {
  const parsed = new Date(utcTimestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function YouTubeSettings({
  settings,
  onSettingsChange,
  hasVideo,
  videoSourceUrl = null,
  autoThumbnails,
  selectedAutoThumbnail,
  onSelectAutoThumbnail,
  onGenerateAutoThumbnails,
  aiGeneratedThumbnails,
  onGenerateAiThumbnail,
  isGeneratingAiThumbnail,
  onDownloadThumbnail,
  selectedAccounts = [],
  caption,
}: YouTubeSettingsProps) {
  const { flags } = useFeatureFlags();
  const { t, i18n } = useTranslation("postsettings");
  const locale: "en" | "ar" = i18n.language?.startsWith("ar") ? "ar" : "en";
  const categoryCatalog = useYouTubeCategories(locale, selectedAccounts[0]?.id ?? null);
  const [thumbnailDialogOpen, setThumbnailDialogOpen] = useState(false);
  const [aiThumbnailPrompt, setAiThumbnailPrompt] = useState("");
  const { tiers: resolvedTiers } = useResolvedImageModels();
  const [aiThumbnailRefs, setAiThumbnailRefs] = useState<string[]>([]);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isThumbnailLibraryOpen, setIsThumbnailLibraryOpen] = useState(false);
  const [isStockPickerOpen, setIsStockPickerOpen] = useState(false);
  const aiThumbnailRefInputRef = useRef<HTMLInputElement>(null);
  const composioManaged = selectedAccounts.some((account) => account.auth_provider === "composio");
  // A playlist belongs to exactly one channel and one post carries one
  // playlist id, so the selector only works with a single native channel.
  // Distinctness is by channel: two selected accounts of the same channel are
  // one channel. A managed channel cannot be written through Postora's own
  // credentials, so it never counts as a native channel.
  const nativeAccounts = selectedAccounts.filter((account) => account.auth_provider !== "composio");
  const distinctNativeChannels = new Set(
    nativeAccounts.map((account) => {
      const channelId = account.platform_user_id?.trim();
      return channelId && channelId.length > 0 ? `channel:${channelId}` : `account:${account.id}`;
    }),
  );
  const multipleNativeChannels = distinctNativeChannels.size > 1;
  const singleNativeChannelKey = !multipleNativeChannels && distinctNativeChannels.size === 1
    ? [...distinctNativeChannels][0]
    : null;
  const playlistAccountId = !multipleNativeChannels && nativeAccounts.length > 0
    ? nativeAccounts[0].id
    : null;
  const playlistCatalog = useYouTubePlaylists(playlistAccountId);
  const playlistSelectorDisabled =
    (composioManaged && nativeAccounts.length === 0) || multipleNativeChannels;
  const previousNativeChannelKeyRef = useRef<string | null>(singleNativeChannelKey);
  // A playlist chosen for a channel that is no longer the only one (or when the
  // creator switches to a different single native channel) would point at
  // another channel's playlist, so the choice is dropped with the channel.
  useEffect(() => {
    const channelChanged =
      previousNativeChannelKeyRef.current !== null &&
      singleNativeChannelKey !== null &&
      previousNativeChannelKeyRef.current !== singleNativeChannelKey;
    previousNativeChannelKeyRef.current = singleNativeChannelKey;
    if ((multipleNativeChannels || channelChanged) && settings.playlist) {
      onSettingsChange({ playlist: "" });
    }
  }, [multipleNativeChannels, onSettingsChange, settings.playlist, singleNativeChannelKey]);
  // The creator can ask for a YouTube schedule before choosing a time, so the
  // mode is local state until a timestamp exists. A stored timestamp switches
  // the mode on by itself, which is what reopens a saved draft.
  const [scheduleModeRequested, setScheduleModeRequested] = useState(false);
  // The raw text the creator typed, kept until it is replaced so the input
  // never rewrites what they are still editing.
  const [publishAtDraft, setPublishAtDraft] = useState<string | null>(null);

  const trimmedPublishAt = (settings.publishAt ?? "").trim();
  // The browser checks the same bounds the publisher enforces, so a creator is
  // never told a schedule is fine when the upload would refuse it.
  const scheduleResolution = resolveYoutubePublishAt(trimmedPublishAt || null, new Date());
  const isScheduleOnYouTube =
    !composioManaged &&
    (Boolean(settings.scheduleRequested) || scheduleModeRequested || trimmedPublishAt.length > 0);
  const publishAtDraftIsUnusable =
    publishAtDraft !== null &&
    publishAtDraft.trim().length > 0 &&
    Number.isNaN(new Date(publishAtDraft).getTime());
  const publishAtInputValue =
    publishAtDraft ?? (trimmedPublishAt ? toLocalDateTimeValue(trimmedPublishAt) : "");

  // A scheduled upload is private until YouTube flips it, so the preview says
  // private even when the privacy control said something else. A managed
  // channel never carries the key, so it promises no schedule either.
  const previewPrivacy = isScheduleOnYouTube ? "private" : settings.visibility;

  const publishAtError = (() => {
    // Outside schedule mode there is no picker to fix the value with, so an
    // error there would be a dead end.
    if (!isScheduleOnYouTube) return null;
    if (!trimmedPublishAt) {
      return t("youtube.publishScheduleRequired", "Choose a YouTube scheduled publish date and time.");
    }
    if (publishAtDraftIsUnusable) {
      return t("youtube.publishScheduleInvalidTimestamp", "Choose a valid YouTube scheduled publish date and time.");
    }
    // `=== false` rather than `!ok`: this repository compiles without
    // `strictNullChecks`, where the negated form does not narrow the union.
    if (scheduleResolution.ok === false) {
      switch (scheduleResolution.reason) {
        case "too_soon":
        case "expired":
          return t("youtube.publishScheduleTooSoon", "YouTube scheduled publish time must be at least 15 minutes in the future.");
        case "too_far":
          return t("youtube.publishScheduleTooFar", "YouTube scheduled publish time cannot be more than 2 years in the future.");
        default:
          return t("youtube.publishScheduleInvalidTimestamp", "Choose a valid YouTube scheduled publish date and time.");
      }
    }
    return null;
  })();

  const handlePublishModeChange = (mode: string) => {
    if (mode === "schedule") {
      setScheduleModeRequested(true);
      onSettingsChange({ scheduleRequested: true });
      return;
    }
    setScheduleModeRequested(false);
    setPublishAtDraft(null);
    // Leaving the schedule clears the timestamp and the mode flag, so the post
    // metadata carries no schedule key at all and the upload keeps the chosen privacy.
    onSettingsChange({
      scheduleRequested: false,
      ...(settings.publishAt ? { publishAt: "" } : {}),
    });
  };

  const handlePublishAtChange = (value: string) => {
    setPublishAtDraft(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setScheduleModeRequested(true);
      onSettingsChange({ publishAt: "", scheduleRequested: true });
      return;
    }
    // `datetime-local` has no time zone, so the browser reads it as local
    // time; the stored value is the same instant in UTC.
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return;
    setScheduleModeRequested(true);
    onSettingsChange({ publishAt: parsed.toISOString(), scheduleRequested: true });
  };

  const handleAiThumbnailRefSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const remainingSlots = MAX_THUMBNAIL_REFERENCES - aiThumbnailRefs.length;
    const filesToProcess = Array.from(files).slice(0, remainingSlots);

    filesToProcess.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        setAiThumbnailRefs(prev => {
          if (prev.length >= MAX_THUMBNAIL_REFERENCES) return prev;
          return [...prev, event.target?.result as string];
        });
      };
      reader.readAsDataURL(file);
    });

    // Reset input
    if (aiThumbnailRefInputRef.current) {
      aiThumbnailRefInputRef.current.value = "";
    }
  };

  const handleLibrarySelect = (files: UploadedFile[]) => {
    const remainingSlots = MAX_THUMBNAIL_REFERENCES - aiThumbnailRefs.length;
    const filesToAdd = files.slice(0, remainingSlots);
    
    setAiThumbnailRefs(prev => [
      ...prev,
      ...filesToAdd.map(f => f.previewUrl || f.cloudinaryUrl || "")
    ].slice(0, MAX_THUMBNAIL_REFERENCES));
    
    setIsLibraryOpen(false);
  };

  const removeReferenceImage = (index: number) => {
    setAiThumbnailRefs(prev => prev.filter((_, i) => i !== index));
  };

  const handleStockMediaSelect = (media: SelectedMedia) => {
    const remainingSlots = MAX_THUMBNAIL_REFERENCES - aiThumbnailRefs.length;
    if (remainingSlots <= 0) return;
    
    // Use thumbnailUrl for reference images (smaller size for AI reference)
    const imageUrl = media.thumbnailUrl || media.url;
    setAiThumbnailRefs(prev => [...prev, imageUrl].slice(0, MAX_THUMBNAIL_REFERENCES));
    setIsStockPickerOpen(false);
  };

  const handleGenerateAiThumbnail = async () => {
    await onGenerateAiThumbnail(
      aiThumbnailPrompt,
      aiThumbnailRefs.length > 0 ? aiThumbnailRefs[0] : undefined
    );
  };

  // The preview uses the SAME resolver as the native request so a creator
  // never approves "New Video" and publishes the caption instead.
  const shortsTitle = resolveYouTubeVideoTitle({
    title: settings.title,
    caption,
    videoType: settings.videoType,
    fallback: settings.videoType === "short"
      ? t("youtube.newShort", "New Video #Shorts")
      : t("youtube.newVideo", "New Video"),
  });

  return (
    <>
    <TooltipProvider>
      <div className="rounded-lg border p-3 text-xs text-muted-foreground" data-testid="youtube-send-preview">
        <p className="font-medium text-foreground">{t("youtube.preSendTitle", "Before you publish")}</p>
        <p>
          {t("youtube.previewTitle", "YouTube title: {{title}}", { title: shortsTitle })}
        </p>
        <p>
          {t("youtube.previewPrivacy", "Requested privacy: {{privacy}}", { privacy: previewPrivacy })}
          {" · "}
          {t("youtube.previewChannel", "Channel: {{channel}}", {
            channel: selectedAccounts.map((account) => account.platform_username || "Unknown").join(", ") ||
              t("youtube.noChannel", "none selected"),
          })}
          {scheduleResolution.ok && !composioManaged && (
            <>
              {" · "}
              {t("youtube.previewScheduledOnYouTube", "Scheduled on YouTube: {{time}}", { time: scheduleResolution.publishAt })}
            </>
          )}
        </p>
      </div>
    <div className="space-y-4">
      {/* Posting to YouTube as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("youtube.postingAs", "Posting to YouTube as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("youtube", account.platform_username);
              return (
                <a
                  key={account.id}
                  href={profileUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "flex items-center gap-2 p-2 bg-secondary/50 rounded-lg border transition-colors",
                    profileUrl && "hover:bg-secondary hover:border-primary/30 cursor-pointer"
                  )}
                  onClick={(e) => !profileUrl && e.preventDefault()}
                >
                  {account.avatar_url ? (
                    <img
                      src={account.avatar_url}
                      alt=""
                      className="w-8 h-8 rounded-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                        e.currentTarget.nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <div className={cn("w-8 h-8 rounded-full bg-[#FF0000] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    YT
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium flex items-center gap-1">
                      {account.platform_username || "Unknown"}
                      {profileUrl && <ExternalLink className="w-3 h-3 text-muted-foreground" />}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Video Type Selection */}
      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          {t("youtube.videoType", "Video Type")}
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("youtube.videoTypeTooltip", "Choose between regular video or YouTube Shorts (up to three minutes)")}</p>
            </TooltipContent>
          </Tooltip>
        </Label>
        <RadioGroup 
          value={settings.videoType || "video"} 
          onValueChange={(v) => onSettingsChange({ videoType: v as "video" | "short" })} 
          className="flex gap-4"
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <RadioGroupItem value="video" />
            <span className="text-sm">{t("youtube.regularVideo", "Regular Video")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <RadioGroupItem value="short" />
            <span className="text-sm flex items-center gap-1">
              {t("youtube.shortOption", "📱 Short (up to 3 min)")}
            </span>
          </label>
        </RadioGroup>
      </div>

      {/* Shorts Info */}
      {settings.videoType === "short" && (
        <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2 text-sm font-medium text-primary mb-2">
            {t("youtube.shortsHeading", "📱 YouTube Shorts")}
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{t("youtube.shortsTipDuration", "• Shorts can run up to three minutes")}</p>
            <p>{t("youtube.shortsTipAspectRatio", "• Square or vertical format (9:16 or 1:1) required")}</p>
            <p>{t("youtube.shortsTipResolution", "• Maximum resolution: 1920x1080")}</p>
            <p>{t("youtube.shortsTipTitle", "• YouTube treats the video as a Short from its aspect ratio and length, so the #Shorts tag is optional")}</p>
          </div>
        </div>
      )}

      {/* Title Override */}
      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          {settings.videoType === "short" ? t("youtube.shortTitle", "Short Title") : t("youtube.titleOverride", "Title override")}
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{settings.videoType === "short" 
                ? t("youtube.shortTitleTooltip", "Title shown on your Short - include #Shorts for discoverability") 
                : t("youtube.titleOverrideTooltip", "Custom title for YouTube (overrides main caption)")}</p>
            </TooltipContent>
          </Tooltip>
        </Label>
        <Input
          placeholder={settings.videoType === "short" 
            ? t("youtube.shortTitlePlaceholder", "My awesome Short #Shorts") 
            : t("youtube.titleOverridePlaceholder", "Custom title just for YouTube (fallbacks to main title)")}
          maxLength={100}
          value={settings.title}
          onChange={(e) => onSettingsChange({ title: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {t("youtube.maxCharacters", "Max 100 characters")}{settings.videoType === "short" ? t("youtube.includeShortsNote", " - Include #Shorts for better discovery") : ""}
        </p>
        <YouTubeAISuggestions
          type="title"
          context={settings.title || ""}
          onSelect={(val) => onSettingsChange({ title: val })}
        />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          {t("youtube.description", "Description")}
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("youtube.descriptionTooltip", "Video description with links, hashtags, and keywords for SEO")}</p>
            </TooltipContent>
          </Tooltip>
        </Label>
        <Textarea
          placeholder={settings.videoType === "short" 
            ? t("youtube.shortDescriptionPlaceholder", "Add a short description with relevant hashtags")
            : t("youtube.descriptionPlaceholder", "Enter description for your YouTube video")}
          maxLength={5000}
          value={settings.description}
          onChange={(e) => onSettingsChange({ description: e.target.value })}
          className="min-h-[80px]"
        />
        <p className="text-xs text-muted-foreground">{settings.description?.length || 0}/5000</p>
        <YouTubeAISuggestions
          type="description"
          context={settings.title || ""}
          secondaryContext={settings.description}
          onSelect={(val) => onSettingsChange({ description: val })}
        />
        <YouTubeAISuggestions
          type="chapters"
          currentDescription={settings.description}
          videoSourceUrl={hasVideo ? videoSourceUrl : null}
          onSelect={(val) => onSettingsChange({ description: val })}
        />
      </div>

      {/* Tags and Category */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            {t("youtube.tags", "Tags")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.tagsTooltip", "Keywords to help viewers find your video in search")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <Input
            placeholder={t("youtube.tagsPlaceholder", "tutorial, howto, demo")}
            value={settings.tags}
            onChange={(e) => onSettingsChange({ tags: e.target.value.slice(0, 500) })}
            maxLength={500}
          />
          <p className="text-xs text-muted-foreground">{t("youtube.separateTagsWithCommas", "Separate tags with commas.")}</p>
          <YouTubeAISuggestions
            type="tags"
            context={settings.title || ""}
            secondaryContext={settings.description}
            onSelect={(val) => onSettingsChange({ tags: val })}
          />
        </div>
        <YouTubeCategorySelect
          value={settings.category}
          onValueChange={(category) => onSettingsChange({ category })}
          locale={locale}
          options={categoryCatalog.categories}
          catalogUnavailable={categoryCatalog.unavailable}
          onRetry={categoryCatalog.retry}
          label={t("youtube.category", "Category")}
          unavailableText={t("youtube.categoryUnavailable", "Currently unavailable")}
          retryText={t("youtube.categoryRetry", "Retry catalog")}
          helpText={t("youtube.categoryHelp", "Non-assignable categories stay visible but disabled and are preserved when a video already uses them.")}
        />
      </div>

      {/* Privacy and License */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            {t("youtube.privacy", "Privacy")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.privacyTooltip", "Who can see your video: public, unlisted, or private")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          {isScheduleOnYouTube ? (
            /* A scheduled upload is always uploaded private; YouTube publishes
               it when the time comes, so the privacy control has no say. */
            <p
              data-testid="youtube-scheduled-privacy-notice"
              className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-foreground"
            >
              {t("youtube.publishPrivateUntilScheduled", "Private until then. YouTube makes it public at the scheduled time.")}
            </p>
          ) : (
            <Select value={settings.visibility} onValueChange={(v) => onSettingsChange({ visibility: v as typeof settings.visibility })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">{t("youtube.visibilityPublic", "public")}</SelectItem>
                <SelectItem value="unlisted">{t("youtube.visibilityUnlisted", "unlisted")}</SelectItem>
                <SelectItem value="private">{t("youtube.visibilityPrivate", "private")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            {t("youtube.license", "License")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.licenseTooltip", "Standard YouTube license or Creative Commons")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <Select disabled={composioManaged} value={settings.license} onValueChange={(v) => onSettingsChange({ license: v as typeof settings.license })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="youtube">{t("youtube.licenseStandard", "youtube")}</SelectItem>
              <SelectItem value="creativeCommon">{t("youtube.licenseCreativeCommons", "creativeCommon")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Publish timing — native YouTube scheduling (status.publishAt) */}
      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          {t("youtube.publishTimingLabel", "Publish")}
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("youtube.publishTimingTooltip", "Choose whether to use the privacy above immediately or schedule public release on YouTube.")}</p>
            </TooltipContent>
          </Tooltip>
        </Label>
        <RadioGroup
          value={isScheduleOnYouTube ? "schedule" : "privacy"}
          onValueChange={handlePublishModeChange}
          className="flex gap-4"
          aria-label={t("youtube.publishTimingLabel", "Publish")}
        >
          <label className="flex items-center gap-2 cursor-pointer" htmlFor="youtube-publish-mode-privacy">
            <RadioGroupItem id="youtube-publish-mode-privacy" value="privacy" />
            <span className="text-sm">{t("youtube.publishUsePrivacyAbove", "Use the privacy above")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer" htmlFor="youtube-publish-mode-schedule">
            <RadioGroupItem
              id="youtube-publish-mode-schedule"
              value="schedule"
              disabled={composioManaged}
            />
            <span className="text-sm">{t("youtube.publishScheduleOnYouTube", "Schedule on YouTube")}</span>
          </label>
        </RadioGroup>
        {composioManaged && (
          <p className="text-xs text-destructive">
            {t("youtube.publishScheduleComposioUnsupported", "Native YouTube scheduling is not available for managed accounts. Use a native channel.")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("youtube.publishScheduleDifferenceHelp", "Postora's schedule decides when the upload starts; YouTube's decides when the uploaded video becomes public.")}
        </p>
        {isScheduleOnYouTube && (
          <div className="space-y-2">
            <Label htmlFor="youtube-publish-at" className="text-sm font-medium">
              {t("youtube.publishScheduleDateTimeLabel", "YouTube publish date and time")}
            </Label>
            <Input
              id="youtube-publish-at"
              type="datetime-local"
              aria-label={t("youtube.publishScheduleDateTimeLabel", "YouTube publish date and time")}
              value={publishAtInputValue}
              onChange={(e) => handlePublishAtChange(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("youtube.publishScheduleMinMaxHelp", "Must be at least 15 minutes and at most 2 years in the future.")}
            </p>
            {publishAtError && (
              <p role="alert" data-testid="youtube-publish-at-error" className="text-xs text-destructive">
                {publishAtError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Checkboxes Row */}
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="embeddable"
            checked={settings.allowEmbedding}
            disabled={composioManaged}
            onCheckedChange={(checked) => onSettingsChange({ allowEmbedding: checked as boolean })}
          />
          <label htmlFor="embeddable" className="text-sm cursor-pointer flex items-center gap-1">
            {t("youtube.embeddable", "Embeddable")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.embeddableTooltip", "Allow others to embed this video on their websites")}</p>
              </TooltipContent>
            </Tooltip>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="publicStats"
            checked={settings.publicStatsViewable}
            disabled={composioManaged}
            onCheckedChange={(checked) => onSettingsChange({ publicStatsViewable: checked as boolean })}
          />
          <label htmlFor="publicStats" className="text-sm cursor-pointer flex items-center gap-1">
            {t("youtube.publicStats", "Public stats viewable")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.publicStatsTooltip", "Allow viewers to see video statistics (views, likes)")}</p>
              </TooltipContent>
            </Tooltip>
          </label>
        </div>
        <DeclarationChoice
          id="madeForKids"
          label={t("youtube.audienceDeclaration", "Audience (made for kids)")}
          help={t("youtube.audienceDeclarationHelp", "Choose Yes or No before publishing to YouTube.")}
          value={settings.madeForKids}
          mismatch={composioManaged && settings.madeForKids === true}
          onChange={(madeForKids) => onSettingsChange({ madeForKids })}
          yesText={t("common:yes", "Yes")}
          noText={t("common:no", "No")}
          unsupportedText={t("youtube.declarationManagedUnsupported", "This provider cannot send this declaration. Use a native channel.")}
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <DeclarationChoice
          id="syntheticMedia"
          label={t("youtube.syntheticDeclaration", "Synthetic media")}
          help={t("youtube.syntheticDeclarationHelp", "Choose Yes or No before publishing to YouTube.")}
          value={settings.containsSyntheticMedia}
          mismatch={composioManaged && settings.containsSyntheticMedia === true}
          onChange={(containsSyntheticMedia) => onSettingsChange({ containsSyntheticMedia })}
          yesText={t("common:yes", "Yes")}
          noText={t("common:no", "No")}
          unsupportedText={t("youtube.declarationManagedUnsupported", "This provider cannot send this declaration. Use a native channel.")}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="paidPromotion"
            checked={settings.hasPaidPromotion}
            disabled={composioManaged}
            onCheckedChange={(checked) => onSettingsChange({ hasPaidPromotion: checked as boolean })}
          />
          <label htmlFor="paidPromotion" className="text-sm cursor-pointer flex items-center gap-1">
            {t("youtube.paidPromotion", "Has paid product placement")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("youtube.paidPromotionTooltip", "Video includes paid promotions or sponsorships")}</p>
              </TooltipContent>
            </Tooltip>
          </label>
        </div>
      </div>

      {/* Language Settings */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("youtube.defaultLanguage", "Default language")}</Label>
          <Select disabled={composioManaged} value={settings.videoLanguage || ""} onValueChange={(v) => onSettingsChange({ videoLanguage: v })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("youtube.selectLanguage", "Select language")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ar">Arabic (العربية)</SelectItem>
              <SelectItem value="es">Spanish (Español)</SelectItem>
              <SelectItem value="fr">French (Français)</SelectItem>
              <SelectItem value="de">German (Deutsch)</SelectItem>
              <SelectItem value="pt">Portuguese (Português)</SelectItem>
              <SelectItem value="ru">Russian (Русский)</SelectItem>
              <SelectItem value="zh">Chinese (中文)</SelectItem>
              <SelectItem value="ja">Japanese (日本語)</SelectItem>
              <SelectItem value="ko">Korean (한국어)</SelectItem>
              <SelectItem value="hi">Hindi (हिन्दी)</SelectItem>
              <SelectItem value="tr">Turkish (Türkçe)</SelectItem>
              <SelectItem value="it">Italian (Italiano)</SelectItem>
              <SelectItem value="nl">Dutch (Nederlands)</SelectItem>
              <SelectItem value="pl">Polish (Polski)</SelectItem>
              <SelectItem value="id">Indonesian (Bahasa)</SelectItem>
              <SelectItem value="th">Thai (ไทย)</SelectItem>
              <SelectItem value="vi">Vietnamese (Tiếng Việt)</SelectItem>
              <SelectItem value="uk">Ukrainian (Українська)</SelectItem>
              <SelectItem value="sv">Swedish (Svenska)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("youtube.defaultAudioLanguage", "Default audio language")}</Label>
          <Select disabled={composioManaged} value={settings.audioLanguage || ""} onValueChange={(v) => onSettingsChange({ audioLanguage: v })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("youtube.selectAudioLanguage", "Select audio language")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ar">Arabic (العربية)</SelectItem>
              <SelectItem value="es">Spanish (Español)</SelectItem>
              <SelectItem value="fr">French (Français)</SelectItem>
              <SelectItem value="de">German (Deutsch)</SelectItem>
              <SelectItem value="pt">Portuguese (Português)</SelectItem>
              <SelectItem value="ru">Russian (Русский)</SelectItem>
              <SelectItem value="zh">Chinese (中文)</SelectItem>
              <SelectItem value="ja">Japanese (日本語)</SelectItem>
              <SelectItem value="ko">Korean (한국어)</SelectItem>
              <SelectItem value="hi">Hindi (हिन्दी)</SelectItem>
              <SelectItem value="tr">Turkish (Türkçe)</SelectItem>
              <SelectItem value="it">Italian (Italiano)</SelectItem>
              <SelectItem value="nl">Dutch (Nederlands)</SelectItem>
              <SelectItem value="pl">Polish (Polski)</SelectItem>
              <SelectItem value="id">Indonesian (Bahasa)</SelectItem>
              <SelectItem value="th">Thai (ไทย)</SelectItem>
              <SelectItem value="vi">Vietnamese (Tiếng Việt)</SelectItem>
              <SelectItem value="uk">Ukrainian (Українська)</SelectItem>
              <SelectItem value="sv">Swedish (Svenska)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Country Restrictions */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("youtube.allowedCountries", "Allowed countries")}</Label>
          <CountryMultiSelect
            value={settings.allowedCountries}
            onChange={(val) => onSettingsChange({ allowedCountries: val })}
            placeholder={t("youtube.selectAllowedCountries", "Select allowed countries...")}
            disabled={composioManaged}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("youtube.blockedCountries", "Blocked countries")}</Label>
          <CountryMultiSelect
            value={settings.blockedCountries}
            onChange={(val) => onSettingsChange({ blockedCountries: val })}
            placeholder={t("youtube.selectBlockedCountries", "Select blocked countries...")}
            disabled={composioManaged}
          />
        </div>
      </div>

      {/* Recording Date */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("youtube.recordingDate", "Recording date")}</Label>
        <Input
          type="datetime-local"
          placeholder="mm/dd/yyyy --:-- --"
          value={settings.recordingDate}
          onChange={(e) => onSettingsChange({ recordingDate: e.target.value })}
          disabled={composioManaged}
        />
        <p className="text-xs text-muted-foreground">{t("youtube.recordingDateHelp", "ISO 8601 format (e.g. \"2024-01-15T14:30:00Z\")")}</p>
      </div>

      {/* Thumbnail Section */}
      <div className="space-y-3 border-t pt-4">
        <div>
          <Label className="text-sm font-medium">{t("youtube.thumbnailFile", "Thumbnail file")}</Label>
          <p className="text-xs text-muted-foreground">{t("youtube.thumbnailSpecHelp", "JPG/PNG/GIF/BMP - ≤ 2MB recommended - ideal size 1280×720 (16:9).")}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => onSettingsChange({ thumbnailMode: "upload" })}
            className={cn(
              "flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-colors",
              settings.thumbnailMode === "upload" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
            )}
          >
            <Upload className="w-6 h-6" />
            <span className="text-xs">{t("youtube.uploadFile", "Upload file")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onSettingsChange({ thumbnailMode: "auto" });
              setThumbnailDialogOpen(true);
              onGenerateAutoThumbnails();
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-colors",
              settings.thumbnailMode === "auto" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
            )}
          >
            <Sparkles className="w-6 h-6" />
            <span className="text-xs">{t("youtube.autoGenerated", "Auto-generated")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSettingsChange({ thumbnailMode: "test" })}
            className={cn(
              "flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-colors",
              settings.thumbnailMode === "test" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
            )}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></svg>
            <span className="text-xs">{t("youtube.testAndCompare", "Test & compare")}</span>
          </button>
        </div>

        {/* Selected thumbnail preview */}
        {settings.thumbnailUrl && (
          <div className="mt-3">
            <img
              src={settings.thumbnailUrl}
              alt={t("youtube.selectedThumbnailAlt", "Selected thumbnail")}
              className="w-full max-w-xs rounded-lg border aspect-video object-cover"
            />
          </div>
        )}
      </div>

      {/* Thumbnail URL Input */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("youtube.thumbnailUrl", "Thumbnail URL")}</Label>
        <Input
          placeholder="https://"
          value={settings.thumbnailUrl}
          onChange={(e) => onSettingsChange({ thumbnailUrl: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {t("youtube.thumbnailUrlHelp", "For direct YouTube publishing, use an HTTPS image URL from an approved media host.")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setIsThumbnailLibraryOpen(true)}>
            {t("youtube.chooseOwnedThumbnail", "Use owned media thumbnail")}
          </Button>
          {settings.thumbnailMediaId && (
            <span className="text-xs text-muted-foreground">
              {t("youtube.ownedThumbnailSelected", "Owned thumbnail: {{id}}", { id: settings.thumbnailMediaId })}
            </span>
          )}
        </div>
      </div>

      {/* Auto-generated Thumbnail Dialog */}
      <Dialog open={thumbnailDialogOpen} onOpenChange={setThumbnailDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("youtube.autoGenThumbnailTitle", "Auto-generated thumbnail")}</DialogTitle>
            <DialogDescription>
              {t("youtube.autoGenThumbnailDesc", "Select an image from your video to use as a thumbnail")}
            </DialogDescription>
          </DialogHeader>

          {/* Video Frame Thumbnails */}
          <div className="space-y-4">
            <div className="flex gap-3">
              {autoThumbnails.length > 0 ? (
                autoThumbnails.map((thumb, idx) => (
                  <div key={idx} className="flex-1 relative group">
                    <button
                      type="button"
                      onClick={() => onSelectAutoThumbnail(idx)}
                      className={cn(
                        "w-full rounded-lg overflow-hidden border-2 transition-all",
                        selectedAutoThumbnail === idx
                          ? "border-primary ring-2 ring-primary/30"
                          : "border-border hover:border-primary/50"
                      )}
                    >
                      <img
                        src={thumb}
                        alt={`Frame ${idx + 1}`}
                        className="w-full aspect-video object-cover"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownloadThumbnail(thumb, `video-frame-${idx + 1}.jpg`);
                      }}
                      className="absolute bottom-1 end-1 p-1.5 bg-black/70 hover:bg-black/90 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                      title={t("youtube.downloadThumbnail", "Download thumbnail")}
                    >
                      <Download className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="flex-1 flex items-center justify-center h-24 rounded-lg border border-dashed text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin me-2" />
                  {t("youtube.generatingThumbnails", "Generating thumbnails...")}
                </div>
              )}
            </div>

            {/* AI Generated Thumbnails */}
            {aiGeneratedThumbnails.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("youtube.aiGeneratedHeading", "AI Generated")}</Label>
                <div className="flex gap-3 flex-wrap">
                  {aiGeneratedThumbnails.map((thumb, idx) => (
                    <div key={`ai-${idx}`} className="relative group">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectAutoThumbnail(null);
                          onSettingsChange({ thumbnailUrl: thumb });
                        }}
                        className={cn(
                          "w-32 rounded-lg overflow-hidden border-2 transition-all",
                          settings.thumbnailUrl === thumb
                            ? "border-primary ring-2 ring-primary/30"
                            : "border-border hover:border-primary/50"
                        )}
                      >
                        <img
                          src={thumb}
                          alt={`AI Thumbnail ${idx + 1}`}
                          className="w-full aspect-video object-cover"
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownloadThumbnail(thumb, `ai-thumbnail-${idx + 1}.jpg`);
                        }}
                        className="absolute bottom-1 end-1 p-1.5 bg-black/70 hover:bg-black/90 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                        title={t("youtube.downloadThumbnail", "Download thumbnail")}
                      >
                        <Download className="w-3 h-3 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI Thumbnail Generator - only show if feature is enabled */}
            {flags.aiThumbnails && (
              <div className="space-y-3 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <Label className="text-sm font-medium">{t("youtube.generateWithAi", "Generate with AI")}</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("youtube.createCustomThumbnailHelp", "Create custom thumbnails with AI. Aspect ratio fixed at 16:9.")}
                </p>

                {/* Which models will run — administrator-controlled, read-only here. */}
                <ResolvedModelCards tiers={resolvedTiers} />

                {/* Prompt */}
                <div className="space-y-2">
                  <Textarea
                    placeholder={t("youtube.aiPromptPlaceholder", "Describe the thumbnail you want to generate... (e.g., 'A dramatic sunset over mountains with bold text overlay')")}
                    className="min-h-[80px] resize-none"
                    value={aiThumbnailPrompt}
                    onChange={(e) => setAiThumbnailPrompt(e.target.value)}
                  />
                </div>

                {/* Reference Images */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t("youtube.referenceImagesLabel", "Reference Images (optional, up to {{max}})", { max: MAX_THUMBNAIL_REFERENCES })}
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={aiThumbnailRefInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleAiThumbnailRefSelect}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => aiThumbnailRefInputRef.current?.click()}
                      disabled={aiThumbnailRefs.length >= MAX_THUMBNAIL_REFERENCES}
                      className="gap-1.5"
                    >
                      <Upload className="w-3 h-3" />
                      {t("youtube.uploadBtn", "Upload")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsLibraryOpen(true)}
                      disabled={aiThumbnailRefs.length >= MAX_THUMBNAIL_REFERENCES}
                      className="gap-1.5"
                    >
                      <FolderOpen className="w-3 h-3" />
                      {t("youtube.libraryBtn", "Library")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsStockPickerOpen(true)}
                      disabled={aiThumbnailRefs.length >= MAX_THUMBNAIL_REFERENCES}
                      className="gap-1.5"
                    >
                      <ImageIcon className="w-3 h-3" />
                      {t("youtube.stockBtn", "Stock")}
                    </Button>
                    
                    {/* Reference image previews */}
                    {aiThumbnailRefs.map((img, index) => (
                      <div key={index} className="relative w-12 h-8 rounded overflow-hidden border border-border">
                        <img
                          src={img}
                          alt={`Reference ${index + 1}`}
                          className="w-full h-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeReferenceImage(index)}
                          className="absolute top-0 end-0 w-4 h-4 rounded-full bg-background/80 hover:bg-destructive hover:text-destructive-foreground text-[10px] flex items-center justify-center transition-colors"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {t("youtube.imagesSelectedCount", "{{count}}/{{max}} images selected", { count: aiThumbnailRefs.length, max: MAX_THUMBNAIL_REFERENCES })}
                  </p>
                </div>

                {/* Generate Button */}
                <Button
                  type="button"
                  onClick={handleGenerateAiThumbnail}
                  disabled={isGeneratingAiThumbnail || !aiThumbnailPrompt.trim()}
                  className="w-full"
                >
                  {isGeneratingAiThumbnail ? (
                    <>
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      {t("youtube.generatingBtn", "Generating...")}
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 me-2" />
                      {t("youtube.generateThumbnailBtn", "Generate Thumbnail")}
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* Apply Selection Button */}
            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                variant="outline"
                onClick={() => setThumbnailDialogOpen(false)}
              >
                {t("common:cancel", "Cancel")}
              </Button>
              <Button
                onClick={() => {
                  if (selectedAutoThumbnail !== null && autoThumbnails[selectedAutoThumbnail]) {
                    onSettingsChange({ thumbnailUrl: autoThumbnails[selectedAutoThumbnail] });
                  }
                  setThumbnailDialogOpen(false);
                }}
                // A browser frame is a data URL and is not a durable owned
                // source. Apply stays disabled until the frame is materialized
                // into owned media (or an approved HTTPS URL is supplied).
                disabled={selectedAutoThumbnail === null ||
                  !/^https:\/\//i.test(autoThumbnails[selectedAutoThumbnail] ?? "")}
                title={t("youtube.frameApplyRequiresOwned", "Save the frame to your media library before applying it as a thumbnail.")}
              >
                {t("youtube.applySelection", "Apply Selection")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Notify Subscribers Toggle */}
      <div className="flex items-center justify-between border-t pt-4">
        <div>
          <p className="text-sm font-medium">{t("youtube.notifySubscribers", "Notify subscribers")}</p>
          <p className="text-xs text-muted-foreground">{t("youtube.notifySubscribersSubtitle", "Send notifications to your subscribers")}</p>
        </div>
        <Switch disabled={composioManaged} checked={settings.notifySubscribers} onCheckedChange={(v) => onSettingsChange({ notifySubscribers: v })} />
      </div>

      {/* First Comment */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{t("youtube.firstComment", "First comment")}</Label>
            <p className="text-xs text-muted-foreground">{t("youtube.firstCommentSubtitle", "Add a pinned comment when video is published")}</p>
          </div>
          <Switch 
            checked={settings.enableFirstComment} 
            disabled={composioManaged}
            onCheckedChange={(v) => onSettingsChange({ enableFirstComment: v })} 
          />
        </div>
        {settings.enableFirstComment && (
          <Textarea
            placeholder={t("youtube.firstCommentPlaceholder", "Write your first comment here...")}
            value={settings.firstComment}
            onChange={(e) => onSettingsChange({ firstComment: e.target.value })}
            className="min-h-[80px]"
            maxLength={10000}
            disabled={composioManaged}
          />
        )}
      </div>

      {/* Playlist — the new video may join one existing playlist of the target channel */}
      <div className="space-y-2 border-t pt-4">
        <Label htmlFor="youtube-playlist" className="text-sm font-medium">
          {t("youtube.playlist", "Playlist")}
        </Label>
        <Select
          value={settings.playlist || PLAYLIST_NONE_VALUE}
          onValueChange={(value) => onSettingsChange({
            playlist: value === PLAYLIST_NONE_VALUE ? "" : value,
          })}
          disabled={playlistSelectorDisabled}
        >
          <SelectTrigger id="youtube-playlist" className="w-full" aria-label={t("youtube.playlist", "Playlist")}>
            <SelectValue placeholder={t("youtube.playlistNone", "No playlist")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PLAYLIST_NONE_VALUE}>
              {t("youtube.playlistNone", "No playlist")}
            </SelectItem>
            {playlistCatalog.playlists.map((playlist) => (
              <SelectItem key={playlist.id} value={playlist.id}>
                {playlist.privacy_status
                  ? `${playlist.title} (${playlist.privacy_status})`
                  : playlist.title}
              </SelectItem>
            ))}
            {/* A draft rehydrated before the list arrived keeps its own choice
                visible, so the select never silently drops a stored playlist. */}
            {settings.playlist
              && !playlistCatalog.playlists.some((playlist) => playlist.id === settings.playlist) && (
              <SelectItem value={settings.playlist}>{settings.playlist}</SelectItem>
            )}
          </SelectContent>
        </Select>
        {playlistCatalog.loading && (
          <p className="text-xs text-muted-foreground">
            {t("youtube.playlistLoading", "Loading playlists…")}
          </p>
        )}
        {multipleNativeChannels && (
          <p data-testid="youtube-playlist-multi-channel-note" className="text-xs text-muted-foreground">
            {t("youtube.playlistMultiChannelNote", "Playlists belong to a single channel. Select one YouTube channel to add this video to a playlist.")}
          </p>
        )}
        {playlistCatalog.hasMore && !multipleNativeChannels && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={playlistCatalog.loadingMore}
            onClick={playlistCatalog.loadMore}
          >
            {t("youtube.playlistLoadMore", "Load more playlists")}
          </Button>
        )}
        {playlistCatalog.unavailable && !multipleNativeChannels && playlistAccountId && (
          <div className="flex items-center gap-2">
            <p role="alert" className="text-xs text-destructive">
              {t("youtube.playlistUnavailable", "Could not load playlists.")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={playlistCatalog.retry}>
              {t("youtube.playlistRetry", "Retry playlists")}
            </Button>
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>

      {/* Media Library Picker for reference images */}
      <MediaLibraryPicker
        open={isLibraryOpen}
        onOpenChange={setIsLibraryOpen}
        onSelect={handleLibrarySelect}
        maxFiles={MAX_THUMBNAIL_REFERENCES}
        currentFileCount={aiThumbnailRefs.length}
        imagesOnly={true}
        showExtendedFilters={true}
      />

      {/* Single owned image for the YouTube thumbnail; the worker resolves its
          id through the owner-bound media resolver before any signing. */}
      <MediaLibraryPicker
        open={isThumbnailLibraryOpen}
        onOpenChange={setIsThumbnailLibraryOpen}
        onSelect={(files) => {
          const chosen = files[0];
          if (!chosen) return;
          onSettingsChange({ thumbnailMediaId: chosen.id, thumbnailUrl: "" });
          setIsThumbnailLibraryOpen(false);
        }}
        maxFiles={1}
        currentFileCount={0}
        imagesOnly={true}
      />

      {/* Stock Media Picker for reference images - Photos only from Pexels/Pixabay */}
      <StockMediaPicker
        open={isStockPickerOpen}
        onOpenChange={setIsStockPickerOpen}
        onSelect={handleStockMediaSelect}
        photosOnly={true}
      />
    </>
  );
}
