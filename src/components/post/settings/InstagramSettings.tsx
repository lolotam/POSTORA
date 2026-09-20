import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Film, Image, Sparkles, Music2, Eye, MessageSquare, Users, MapPin, ExternalLink, Settings2, EyeOff, MessageSquareOff, FileText, ChevronDown, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";
import { useState } from "react";
import { LocationAutocomplete } from "./LocationAutocomplete";
import { SavedSuggestionsInput } from "./SavedSuggestionsInput";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useTranslation } from "react-i18next";

export type InstagramPostType = "feed" | "story" | "reel";

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface InstagramSettingsProps {
  postTypes: InstagramPostType[];
  setPostTypes: (v: InstagramPostType[]) => void;
  location: string;
  setLocation: (v: string) => void;
  firstComment: string;
  setFirstComment: (v: string) => void;
  collaborator: string;
  setCollaborator: (v: string) => void;
  hasVideo: boolean;
  shareToFeed?: boolean;
  setShareToFeed?: (v: boolean) => void;
  coverThumbnailOffset?: number;
  setCoverThumbnailOffset?: (v: number) => void;
  audioName?: string;
  setAudioName?: (v: string) => void;
  altText?: string;
  setAltText?: (v: string) => void;
  hideLikeCounts?: boolean;
  setHideLikeCounts?: (v: boolean) => void;
  disableComments?: boolean;
  setDisableComments?: (v: boolean) => void;
  selectedAccounts?: SelectedAccount[];
  locationId?: string;
  setLocationId?: (v: string) => void;
  locationName?: string;
  setLocationName?: (v: string) => void;
  selectedAccountId?: string;
  shareToStory?: boolean;
  setShareToStory?: (v: boolean) => void;
  onSelectPlace?: (place: any) => void;
}

export function InstagramSettings({
  postTypes,
  setPostTypes,
  location,
  setLocation,
  firstComment,
  setFirstComment,
  collaborator,
  setCollaborator,
  hasVideo,
  shareToFeed = true,
  setShareToFeed,
  coverThumbnailOffset = 0,
  setCoverThumbnailOffset,
  audioName = "",
  setAudioName,
  altText = "",
  setAltText,
  hideLikeCounts = false,
  setHideLikeCounts,
  disableComments = false,
  setDisableComments,
  selectedAccounts = [],
  locationId = "",
  setLocationId,
  locationName = "",
  setLocationName,
  selectedAccountId,
  shareToStory = false,
  setShareToStory,
  onSelectPlace,
}: InstagramSettingsProps) {
  const hasStoryOnly = postTypes.length === 1 && postTypes.includes("story");
  const hasFeedOrReel = postTypes.includes("feed") || postTypes.includes("reel");
  const hasStory = postTypes.includes("story");
  const hasReel = postTypes.includes("reel");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { flags } = useFeatureFlags();
  const { t } = useTranslation("postsettings");

  const togglePostType = (type: InstagramPostType) => {
    if (postTypes.includes(type)) {
      if (postTypes.length > 1) {
        setPostTypes(postTypes.filter(t => t !== type));
      }
    } else {
      setPostTypes([...postTypes, type]);
    }
  };

  return (
    <div className="space-y-4">
      {/* Posting to Instagram as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("instagram.postingAs", "Posting to Instagram as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("instagram", account.platform_username);
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
                  <div className={cn("w-8 h-8 rounded-full bg-gradient-to-br from-[#833AB4] via-[#FD1D1D] to-[#FCAF45] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    IG
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

      {/* Post Type Selection - Multi-select checkboxes */}
      {flags.igPostType && (
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Image className="w-4 h-4" />
                {t("instagram.postType", "Post Type")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("instagram.postTypeTooltip", "Choose where your content will appear on Instagram")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={postTypes.includes("feed")}
              onCheckedChange={() => togglePostType("feed")}
            />
            <span className="text-sm flex items-center gap-1">
              <Image className="w-4 h-4" />
              {t("instagram.feedPost", "Feed Post")}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={postTypes.includes("story")}
              onCheckedChange={() => togglePostType("story")}
            />
            <span className="text-sm flex items-center gap-1">
              <Sparkles className="w-4 h-4" />
              {t("instagram.story", "Story")}
            </span>
          </label>
          {hasVideo && (
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={postTypes.includes("reel")}
                onCheckedChange={() => togglePostType("reel")}
              />
              <span className="text-sm flex items-center gap-1">
                <Film className="w-4 h-4" />
                {t("instagram.reel", "Reel")}
              </span>
            </label>
          )}
        </div>
        {!hasVideo && (
          <p className="text-xs text-muted-foreground">{t("instagram.uploadVideoForReel", "Upload a video to post as a Reel")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("instagram.selectDestinations", "Select one or more destinations for your post")}</p>
      </div>
      )}

      {/* Reels-specific notice */}
      {hasReel && (
        <Alert className="border-primary/30 bg-primary/5">
          <Film className="h-4 w-4" />
          <AlertDescription className="text-sm">
            {t("instagram.reelNotice", "Your video will be posted as a Reel. Reels can reach a wider audience through the Explore page and Reels tab.")}
          </AlertDescription>
        </Alert>
      )}

      {/* Reels-specific settings */}
      {hasReel && (
        <div className="space-y-4 p-4 rounded-lg border bg-card/50">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Film className="w-4 h-4" />
            {t("instagram.reelSettings", "Reel Settings")}
          </h4>

          <div className="flex items-center justify-between">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-2 cursor-help">
                    <Eye className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm">{t("instagram.shareToFeed", "Share to Feed")}</p>
                      <p className="text-xs text-muted-foreground">{t("instagram.shareToFeedSubtitle", "Also show this Reel in your main feed")}</p>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("instagram.shareToFeedTooltip", "When enabled, your Reel will also appear in your profile grid")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Switch checked={shareToFeed} onCheckedChange={setShareToFeed} />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Image className="w-4 h-4" />
              {t("instagram.coverThumbnail", "Cover Thumbnail")}
            </Label>
            <Select value={coverThumbnailOffset?.toString() || "0"} onValueChange={(v) => setCoverThumbnailOffset?.(parseInt(v))}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("instagram.selectCoverFrame", "Select cover frame")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t("instagram.coverFrameAuto", "Auto (first frame)")}</SelectItem>
                <SelectItem value="1000">{t("instagram.coverFrame1s", "1 second in")}</SelectItem>
                <SelectItem value="2000">{t("instagram.coverFrame2s", "2 seconds in")}</SelectItem>
                <SelectItem value="3000">{t("instagram.coverFrame3s", "3 seconds in")}</SelectItem>
                <SelectItem value="5000">{t("instagram.coverFrame5s", "5 seconds in")}</SelectItem>
                <SelectItem value="10000">{t("instagram.coverFrame10s", "10 seconds in")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("instagram.coverThumbnailHelp", "Choose which frame appears as the cover image")}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Music2 className="w-4 h-4" />
              {t("instagram.audioName", "Audio Name (optional)")}
            </Label>
            <Input
              placeholder={t("instagram.audioNamePlaceholder", "Original audio name...")}
              value={audioName}
              onChange={(e) => setAudioName?.(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("instagram.audioNameHelp", "Name for the original audio. Leave blank to use default naming.")}
            </p>
          </div>
        </div>
      )}

      {/* Stories are media-only info */}
      {hasStory && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border text-sm text-muted-foreground">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t("instagram.storyMediaOnly", "Stories only support a single photo or video. Captions, locations, and other settings are not available for stories via the API.")}
        </div>
      )}

      {/* Location - hidden for story-only */}
      {hasFeedOrReel && flags.igLocation && (
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <MapPin className="w-4 h-4" />
                {t("instagram.location", "Location")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("instagram.locationTooltip", "Tag a location to increase discoverability and reach local audiences")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {setLocationId && setLocationName ? (
          <LocationAutocomplete
            locationId={locationId || ""}
            setLocationId={setLocationId}
            locationName={locationName || ""}
            setLocationName={setLocationName}
            accountId={selectedAccountId}
            platform="instagram"
            onSelectPlace={onSelectPlace}
          />
        ) : (
          <Input
            placeholder={t("instagram.locationPlaceholder", "Add location...")}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t("instagram.locationNote", "When a connected account is available, location will be tagged on your published post.")}
        </p>
        <p className="text-xs text-muted-foreground flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {t("instagram.locationWarning", "Some Pages can't be tagged on Instagram even if they show up in search — try a more specific name (e.g. include city).")}
        </p>
      </div>
      )}

      {/* Also share to Story — mirrors the FB toggle. Only shown when posting to Feed/Reel */}
      {hasFeedOrReel && setShareToStory && (
        <div className="flex items-center justify-between p-3 rounded-lg border bg-card/50">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 cursor-help">
                  <Sparkles className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm">{t("instagram.alsoShareToStory", "Also share to Story")}</p>
                    <p className="text-xs text-muted-foreground">{t("instagram.alsoShareToStorySubtitle", "Publish your Feed/Reel and also share it as a Story")}</p>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("instagram.alsoShareToStoryTooltip", "The first photo or video will be re-posted as a 24-hour Story")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Switch checked={shareToStory} onCheckedChange={setShareToStory} />
        </div>
      )}

      {/* First Comment - available for Feed and Reel */}
      {hasFeedOrReel && flags.igFirstComment && (
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <MessageSquare className="w-4 h-4" />
                  {t("instagram.firstComment", "First Comment (optional)")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("instagram.firstCommentTooltip", "Post hashtags as a comment to keep your caption clean while maintaining discoverability")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Textarea
            placeholder={t("instagram.firstCommentPlaceholder", "Add hashtags or additional text as the first comment...")}
            value={firstComment}
            onChange={(e) => setFirstComment(e.target.value)}
            className="min-h-[60px] resize-none"
          />
        </div>
      )}

      {/* Collaborator - hidden for story-only */}
      {hasFeedOrReel && flags.igCollaborator && (
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <Users className="w-4 h-4" />
                  {t("instagram.inviteCollaborator", "Invite Collaborator (optional)")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("instagram.collaboratorTooltip", "The collaborator must have a Business or Creator account for this to work via API")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
           <SavedSuggestionsInput
              fieldType="collaborator"
              platform="instagram"
              value={collaborator}
              onChange={(v) => setCollaborator(v)}
              placeholder="@username"
            />
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {t("instagram.collaboratorNote", "The collaborator must have a Business or Creator account. If the API rejects the collaborator, the post will still be published without them.")}
          </p>
        </div>
      )}

      {/* Advanced Settings - hidden for story-only */}
      {hasFeedOrReel && flags.igAdvancedSettings && (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div className="rounded-lg border bg-card/50">
            <CollapsibleTrigger className="w-full p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t("instagram.advancedSettings", "Advanced Settings")}</span>
              </div>
              <ChevronDown className={cn("w-4 h-4 transition-transform text-muted-foreground", advancedOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-4 space-y-4">
                {/* Alt Text */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    {t("instagram.altText", "Alt Text")}
                  </Label>
                  <Textarea
                    placeholder={t("instagram.altTextPlaceholder", "Describe your photo for people with visual impairments...")}
                    value={altText}
                    onChange={(e) => setAltText?.(e.target.value)}
                    className="min-h-[60px] resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("instagram.altTextHelp", "Alt text describes your photos for people who may not be able to see them. Applied to image posts only (not Reels or Stories).")}
                  </p>
                </div>

                {/* Hide like and view counts — Native app only, no Graph API support */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center justify-between opacity-60 cursor-help">
                        <div className="flex items-center gap-2">
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm">{t("instagram.hideLikeCounts", "Hide like and view counts")}</p>
                            <p className="text-xs text-muted-foreground">{t("instagram.hideLikeCountsSubtitle", "Not supported by Instagram API — change this in the Instagram app instead")}</p>
                          </div>
                        </div>
                        <Switch checked={hideLikeCounts} onCheckedChange={setHideLikeCounts} disabled />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("instagram.hideLikeCountsTooltip", "Instagram's Graph API does not expose this setting. Toggle it manually in the Instagram mobile app after posting.")}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Turn off commenting */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquareOff className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm">{t("instagram.disableComments", "Turn off commenting")}</p>
                      <p className="text-xs text-muted-foreground">{t("instagram.disableCommentsSubtitle", "No one will be able to comment on this post")}</p>
                    </div>
                  </div>
                  <Switch checked={disableComments} onCheckedChange={setDisableComments} />
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </div>
  );
}