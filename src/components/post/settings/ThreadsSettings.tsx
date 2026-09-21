import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Info, MessageCircle, EyeOff, Image, ExternalLink, MapPin, AlertCircle, Hash } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";
import { LocationAutocomplete } from "./LocationAutocomplete";
import { useThreadsCapabilities } from "@/hooks/useThreadsCapabilities";
import { Button } from "@/components/ui/button";
import { Link as RouterLink } from "react-router-dom";

export interface ThreadsSettingsState {
  replyControl: "everyone" | "followers" | "following" | "mentioned";
  hideFromFeed: boolean;
  altText: string;
  crossShareToIg?: boolean;
  crossShareToIgDarkMode?: boolean;
  firstComment?: string;
  topicTag?: string;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface ThreadsSettingsProps {
  settings: ThreadsSettingsState;
  onChange: (changes: Partial<ThreadsSettingsState>) => void;
  hasMedia: boolean;
  hasVideo?: boolean;
  selectedAccounts?: SelectedAccount[];
  locationId?: string;
  locationName?: string;
  onLocationIdChange?: (v: string) => void;
  onLocationNameChange?: (v: string) => void;
  showShareToIg?: boolean;
  onSelectPlace?: (place: any) => void;
}

const replyOptions: { value: ThreadsSettingsState["replyControl"]; label: string; description: string }[] = [
  { value: "everyone", label: "Anyone", description: "Anyone can reply" },
  { value: "followers", label: "Your followers", description: "Only your followers can reply" },
  { value: "following", label: "Profiles you follow", description: "Only accounts you follow" },
  { value: "mentioned", label: "Profiles you mention", description: "Only people mentioned in this post" },
];

export function ThreadsSettings({ settings, onChange, hasMedia, hasVideo = false, selectedAccounts = [], locationId = "", locationName = "", onLocationIdChange, onLocationNameChange, showShareToIg = false, onSelectPlace }: ThreadsSettingsProps) {
  const { t } = useTranslation("postsettings");
  const firstAccountId = selectedAccounts[0]?.id;
  const { data: caps } = useThreadsCapabilities(firstAccountId);
  const canCrossShareToIg = caps?.canCrossShareToIg ?? null;
  const canUseLocationTagging = caps?.canUseLocationTagging ?? null;
  const videoBlocksCrossShare = hasVideo === true;

  // If capability is verified false OR a video is selected, force-disable the toggle so we never send the param.
  useEffect(() => {
    if ((canCrossShareToIg === false || videoBlocksCrossShare) && settings.crossShareToIg) {
      onChange({ crossShareToIg: false, crossShareToIgDarkMode: false });
    }
  }, [canCrossShareToIg, videoBlocksCrossShare, settings.crossShareToIg, onChange]);

  const crossShareDisabled = canCrossShareToIg === false || videoBlocksCrossShare;
  const crossShareTooltip = videoBlocksCrossShare
    ? t("threads.crossShareVideoBlocked", "Instagram Story cross-share via Threads is only supported for text and image posts.")
    : canCrossShareToIg === false
    ? t("threads.crossShareReconnect", "Reconnect Threads — your token doesn't include threads_share_to_instagram.")
    : t("threads.crossShareRequiresPermission", "Requires the threads_share_to_instagram permission on your Meta app");

  const getReplyOption = (value: ThreadsSettingsState["replyControl"]) => {
    switch (value) {
      case "everyone":
        return {
          label: t("threads.replyAnyone", "Anyone"),
          description: t("threads.replyAnyoneDesc", "Anyone can reply"),
        };
      case "followers":
        return {
          label: t("threads.replyFollowers", "Your followers"),
          description: t("threads.replyFollowersDesc", "Only your followers can reply"),
        };
      case "following":
        return {
          label: t("threads.replyFollowing", "Profiles you follow"),
          description: t("threads.replyFollowingDesc", "Only accounts you follow"),
        };
      case "mentioned":
        return {
          label: t("threads.replyMentioned", "Profiles you mention"),
          description: t("threads.replyMentionedDesc", "Only people mentioned in this post"),
        };
    }
  };

  // Topic tag — clean live, max 50, strip "." and "&"
  const rawTopicTag = settings.topicTag || "";
  const cleanedTopicTag = rawTopicTag.replace(/[.&]/g, "").slice(0, 50);
  const hasInvalidChars = /[.&]/.test(rawTopicTag);

  return (
    <div className="space-y-5">
      {/* Posting to Threads as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("threads.postingAs", "Posting to Threads as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("threads", account.platform_username);
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
                  <div className={cn("w-8 h-8 rounded-full bg-black flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    @
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium flex items-center gap-1">
                      @{account.platform_username || "Unknown"}
                      {profileUrl && <ExternalLink className="w-3 h-3 text-muted-foreground" />}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
      {/* Topic Tag (optional) — Threads-only, sent as topic_tag to Meta */}
      <div className="space-y-2">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Hash className="w-4 h-4" />
          {t("threads.topicTag", "Topic Tag (optional)")}
        </Label>
        <Input
          placeholder={t("threads.topicTagPlaceholder", "e.g. lovable-build")}
          value={rawTopicTag}
          onChange={(e) => onChange({ topicTag: e.target.value })}
          maxLength={50}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("threads.topicTagHelp", "Adds a clickable topic above your Thread post. 1–50 characters. No periods (.) or ampersands (&).")}
          </p>
          <p className="text-xs text-muted-foreground shrink-0">{cleanedTopicTag.length}/50</p>
        </div>
        {hasInvalidChars && (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md p-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {t("threads.topicTagInvalidWarning", "Periods (.) and ampersands (&) are not allowed and will be removed before publishing")}
              {cleanedTopicTag.length > 0 ? ` → "${cleanedTopicTag}"` : ""}.
            </span>
          </div>
        )}
      </div>

      {/* Reply Control */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <MessageCircle className="w-4 h-4" />
                {t("threads.whoCanReply", "Who can reply")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("threads.whoCanReplyTooltip", "Control who can reply to your thread")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Select
          value={settings.replyControl}
          onValueChange={(v) => onChange({ replyControl: v as ThreadsSettingsState["replyControl"] })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("threads.selectWhoCanReply", "Select who can reply")} />
          </SelectTrigger>
          <SelectContent>
            {replyOptions.map((option) => {
              const opt = getReplyOption(option.value);
              return (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col items-start">
                    <span className="text-sm font-medium">{opt.label}</span>
                    <span className="text-xs text-muted-foreground">{opt.description}</span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Hide from feed */}
      <div className="flex items-center justify-between py-2 border-t">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-start gap-2 cursor-help">
                <EyeOff className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <Label className="text-sm font-medium">{t("threads.hideFromFeed", "Hide from feed")}</Label>
                  <p className="text-xs text-muted-foreground">{t("threads.hideFromFeedSubtitle", "Post won't appear in followers' feeds")}</p>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("threads.hideFromFeedTooltip", "Hide this post from your followers' main feed - they can still see it on your profile")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Switch
          checked={settings.hideFromFeed}
          onCheckedChange={(v) => onChange({ hideFromFeed: v })}
        />
      </div>

      {/* Share to Instagram Story */}
      {showShareToIg && (
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-start gap-2 cursor-help">
                    <ExternalLink className="w-4 h-4 mt-0.5 text-muted-foreground" />
                    <div>
                      <Label className="text-sm font-medium">{t("threads.shareToIgStory", "Share to Instagram Story")}</Label>
                      <p className="text-xs text-muted-foreground">{t("threads.shareToIgStorySubtitle", "Cross-post this thread to your linked Instagram as a Story")}</p>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{crossShareTooltip}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Switch
              checked={settings.crossShareToIg || false}
              onCheckedChange={(v) => onChange({ crossShareToIg: v })}
              disabled={crossShareDisabled}
            />
          </div>
          {videoBlocksCrossShare && (
            <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {t("threads.crossShareVideoBlocked", "Instagram Story cross-share via Threads is only supported for text and image posts.")}
              </span>
            </div>
          )}
          {!videoBlocksCrossShare && canCrossShareToIg === false && (
            <div className="flex items-start gap-2 text-xs bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 rounded-md p-2.5">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <p>
                  {t("threads.crossSharePermissionDescPrefix", "Meta did not grant ")}<code className="text-[11px]">threads_share_to_instagram</code>{t("threads.crossSharePermissionDescSuffix", " on your last connection. Reconnect Threads and approve Instagram cross-sharing on the consent screen. You also need an Instagram account linked in Meta Accounts Center.")}
                </p>
                <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                  <RouterLink to="/profiles">{t("threads.reconnectThreads", "Reconnect Threads")}</RouterLink>
                </Button>
              </div>
            </div>
          )}
          {!videoBlocksCrossShare && canCrossShareToIg === null && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{t("threads.crossShareNotVerified", "Not yet verified — will confirm at publish time.")}</span>
            </div>
          )}
          {settings.crossShareToIg && !crossShareDisabled && (
            <div className="flex items-center justify-between ps-6">
              <div className="flex items-start gap-2">
                <EyeOff className="w-4 h-4 mt-0.5 text-muted-foreground" />
                <div>
                  <Label className="text-sm font-medium">{t("threads.darkModeStyle", "Dark mode style")}</Label>
                  <p className="text-xs text-muted-foreground">{t("threads.darkModeStyleSubtitle", "Use dark mode appearance on the Instagram Story")}</p>
                </div>
              </div>
              <Switch
                checked={settings.crossShareToIgDarkMode || false}
                onCheckedChange={(v) => onChange({ crossShareToIgDarkMode: v })}
                disabled={crossShareDisabled}
              />
            </div>
          )}
        </div>
      )}

      {/* Location tagging */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm font-medium flex items-center gap-2">
          <MapPin className="w-4 h-4" />
          {t("threads.locationOptional", "Location (optional)")}
        </Label>
        {canUseLocationTagging === false && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md p-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {t("threads.locationNotAvailable", "Threads-native location index isn't available for your token — only native Threads results can be tagged. Reconnect Threads after Meta approves Advanced Access for native results.")}
            </span>
          </div>
        )}
        {canUseLocationTagging === null && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{t("threads.locationNotVerified", "Native Threads location tagging not yet verified. Non-native results will be skipped at publish time.")}</span>
          </div>
        )}
        <LocationAutocomplete
          locationId={locationId}
          setLocationId={onLocationIdChange || (() => {})}
          locationName={locationName}
          setLocationName={onLocationNameChange || (() => {})}
          accountId={selectedAccounts[0]?.id}
          platform="threads"
          onSelectPlace={onSelectPlace}
        />
      </div>

      {/* Alt text for images */}
      {hasMedia && (
        <div className="space-y-2 border-t pt-4">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Image className="w-4 h-4" />
            {t("threads.altText", "Alt text")}
            <Info className="w-3 h-3 text-muted-foreground" />
          </Label>
          <Textarea
            placeholder={t("threads.altTextPlaceholder", "Describe your image for accessibility...")}
            value={settings.altText}
            onChange={(e) => onChange({ altText: e.target.value })}
            maxLength={1000}
            rows={2}
          />
          <p className="text-xs text-muted-foreground text-end">
            {settings.altText.length}/1000
          </p>
        </div>
      )}

      {/* Platform info */}
      <div className="p-3 bg-muted/30 rounded-lg border-t">
        <p className="text-xs text-muted-foreground">
          <strong>{t("threads.notePrefix", "Note:")}</strong> {t("threads.platformNote", "Threads posts support text, GIFs, up to 10 images, or 1 video (up to 5 minutes).")}
        </p>
      </div>
    </div>
  );
}
