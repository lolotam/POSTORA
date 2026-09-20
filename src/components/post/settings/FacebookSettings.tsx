import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertCircle, Film, Image, Sparkles, MapPin, MessageSquare, Link, Share2, Users, ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";
import { ExternalLink } from "lucide-react";
import { LocationAutocomplete } from "./LocationAutocomplete";
import { SavedSuggestionsInput } from "./SavedSuggestionsInput";
import { useState } from "react";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useTranslation } from "react-i18next";

type PostType = "feed" | "story" | "reel";

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
  platform_user_id?: string | null;
}

interface FacebookSettingsProps {
  postTypes: PostType[];
  setPostTypes: (v: PostType[]) => void;
  location: string;
  setLocation: (v: string) => void;
  firstComment: string;
  setFirstComment: (v: string) => void;
  link: string;
  setLink: (v: string) => void;
  shareToStory: boolean;
  setShareToStory: (v: boolean) => void;
  hasVideo: boolean;
  reelDescription?: string;
  setReelDescription?: (v: string) => void;
  selectedAccounts?: SelectedAccount[];
  tags?: string;
  setTags?: (v: string) => void;
  locationId?: string;
  setLocationId?: (v: string) => void;
  locationName?: string;
  setLocationName?: (v: string) => void;
  accountId?: string;
  reelCollaborator?: string;
  setReelCollaborator?: (v: string) => void;
  onSelectPlace?: (place: any) => void;
}

export function FacebookSettings({
  postTypes,
  setPostTypes,
  location,
  setLocation,
  firstComment,
  setFirstComment,
  link,
  setLink,
  shareToStory,
  setShareToStory,
  hasVideo,
  reelDescription = "",
  setReelDescription,
  selectedAccounts = [],
  tags = "",
  setTags,
  locationId = "",
  setLocationId,
  locationName = "",
  setLocationName,
  accountId,
  reelCollaborator = "",
  setReelCollaborator,
  onSelectPlace,
}: FacebookSettingsProps) {
  const hasStoryOnly = postTypes.length === 1 && postTypes.includes("story");
  const hasFeedOrReel = postTypes.includes("feed") || postTypes.includes("reel");
  const hasStory = postTypes.includes("story");
  const hasReel = postTypes.includes("reel");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { flags } = useFeatureFlags();
  const { t } = useTranslation("postsettings");

  const togglePostType = (type: PostType) => {
    if (postTypes.includes(type)) {
      // Don't allow deselecting the last one
      if (postTypes.length > 1) {
        setPostTypes(postTypes.filter(t => t !== type));
      }
    } else {
      setPostTypes([...postTypes, type]);
    }
  };

  return (
    <div className="space-y-4">
      {/* Posting to Facebook as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("facebook.postingAs", "Posting to Facebook as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("facebook", account.platform_username, account.platform_user_id);
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
                  <div className={cn("w-8 h-8 rounded-full bg-[#1877F2] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    FB
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

      {/* Post Type - Multi-select checkboxes */}
      {flags.fbPostType && (
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("facebook.postType", "Post Type")}</Label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={postTypes.includes("feed")}
              onCheckedChange={() => togglePostType("feed")}
            />
            <span className="text-sm flex items-center gap-1">
              <Image className="w-4 h-4" />
              {t("facebook.feedPost", "Feed Post")}
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={postTypes.includes("story")}
              onCheckedChange={() => togglePostType("story")}
            />
            <span className="text-sm flex items-center gap-1">
              <Sparkles className="w-4 h-4" />
              {t("facebook.story", "Story")}
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
                {t("facebook.reel", "Reel")}
              </span>
            </label>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("facebook.selectDestinations", "Select one or more destinations for your post")}</p>
      </div>
      )}

      {/* Reel-specific info */}
      {hasReel && (
        <div className="space-y-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Film className="w-4 h-4" />
            {t("facebook.reelSettings", "Facebook Reel Settings")}
          </div>
          
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{t("facebook.reelTipDuration", "• Reels are short-form videos up to 90 seconds")}</p>
            <p>{t("facebook.reelTipAspectRatio", "• Vertical format (9:16 aspect ratio) recommended")}</p>
            <p>{t("facebook.reelTipFeed", "• Reels appear in the Reels tab and may be featured in Feed")}</p>
          </div>

          {/* Reel Description */}
          {setReelDescription && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("facebook.reelDescription", "Reel Description")}</Label>
              <Textarea
                placeholder={t("facebook.reelDescriptionPlaceholder", "Write a catchy description for your Reel...")}
                value={reelDescription}
                onChange={(e) => setReelDescription(e.target.value)}
                className="min-h-[60px] resize-none"
                maxLength={2200}
              />
              <p className="text-xs text-muted-foreground">{reelDescription.length}/2200</p>
            </div>
          )}

          {/* Reel Collaborator */}
          {setReelCollaborator && (
            <div className="space-y-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                      <Users className="w-4 h-4" />
                      {t("facebook.inviteCollaborator", "Invite Collaborator (optional)")}
                    </Label>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p>{t("facebook.inviteCollaboratorTooltip", "Invite another Facebook Page to co-publish this Reel. They'll receive an invitation link to accept.")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <SavedSuggestionsInput
                fieldType="collaborator"
                platform="facebook"
                value={reelCollaborator}
                onChange={(v) => setReelCollaborator(v)}
                placeholder={t("facebook.collaboratorPlaceholder", "Collaborator Facebook Page ID...")}
              />
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3" />
                {t("facebook.collaboratorNote", "Collaborator must accept the invitation for the Reel to appear on their Page")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Video requirement warning for Reels */}
      {hasReel && !hasVideo && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {t("facebook.reelVideoRequired", "Reels require a video. Please upload a video to post as a Reel.")}
        </div>
      )}

      {/* Stories are media-only info */}
      {hasStory && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border text-sm text-muted-foreground">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {t("facebook.storyMediaOnly", "Stories only support a single photo or video. Captions, locations, and other settings are not available for stories via the API.")}
        </div>
      )}

      {/* Location (Place Autocomplete) - hidden for story-only */}
      {hasFeedOrReel && flags.fbLocation && (
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <MapPin className="w-4 h-4" />
                {t("facebook.location", "Location (optional)")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("facebook.locationTooltip", "Tag a Facebook Place to help people discover your post")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {setLocationId && setLocationName ? (
          <LocationAutocomplete
            locationId={locationId}
            setLocationId={setLocationId}
            locationName={locationName}
            setLocationName={setLocationName}
            accountId={accountId}
            platform="facebook"
            onSelectPlace={onSelectPlace}
          />
        ) : (
          <Input
            placeholder={t("facebook.locationPlaceholder", "Add location...")}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t("facebook.locationNote", "When a connected account is available, location will be tagged on your published post.")}
        </p>
      </div>
      )}

      {/* First Comment - available for Feed and Reel (not story-only) */}
      {hasFeedOrReel && flags.fbFirstComment && (
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <MessageSquare className="w-4 h-4" />
                  {t("facebook.firstComment", "First Comment (optional)")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("facebook.firstCommentTooltip", "Add hashtags as a comment to keep your main post clean")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Textarea
            placeholder={t("facebook.firstCommentPlaceholder", "Add hashtags or additional text...")}
            value={firstComment}
            onChange={(e) => setFirstComment(e.target.value)}
            className="min-h-[60px] resize-none"
          />
        </div>
      )}

      {/* Link - hidden for story-only, available for feed */}
      {postTypes.includes("feed") && flags.fbLink && (
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <Link className="w-4 h-4" />
                  {t("facebook.link", "Link (optional)")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("facebook.linkTooltip", "Share a clickable link preview with your post")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Input
            placeholder="https://..."
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
      )}

      {/* Share to Story - only for feed posts */}
      {postTypes.includes("feed") && !postTypes.includes("story") && flags.fbShareToStory && (
        <div className="flex items-center justify-between border-t pt-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-start gap-2 cursor-help">
                  <Share2 className="w-4 h-4 mt-0.5 text-muted-foreground" />
                  <div>
                    <p className="text-sm">{t("facebook.shareToStory", "Also share to Story")}</p>
                    <p className="text-xs text-muted-foreground">{t("facebook.shareToStorySubtitle", "Post will appear in your story too")}</p>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("facebook.shareToStoryTooltip", "Your post will also appear as a story for 24 hours")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Switch checked={shareToStory} onCheckedChange={setShareToStory} />
        </div>
      )}
    </div>
  );
}