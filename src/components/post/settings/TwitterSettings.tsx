import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Plus, Minus, AlertCircle, Upload, Image, Link, MapPin, Users, MessageSquare, AtSign, HelpCircle, ExternalLink } from "lucide-react";
import { TwitterThreadPreview } from "../TwitterThreadPreview";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";

export interface TwitterSettingsState {
  // Core settings
  threadMode: boolean;
  postAsLongTweet: boolean;
  customTitle: string;
  
  // Reply/Audience settings
  replySettings: "everyone" | "following" | "mentionedUsers" | "subscribers" | "verified";
  forSuperFollowersOnly: boolean;
  shareWithFollowers: boolean;
  
  // Tweet interactions
  replyToTweetId: string;
  quoteTweetUrl: string;
  taggedUserIds: string;
  excludeReplyUserIds: string;
  
  // Location & Community
  placeId: string;
  communityId: string;
  dmDeepLink: string;
  
  // Media
  nullcast: boolean;
  thumbnailUrl: string;
  thumbnailFile: File | null;
  
  // Poll
  pollEnabled: boolean;
  pollOptions: string[];
  pollDuration: string;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface TwitterSettingsProps {
  settings: TwitterSettingsState;
  onChange: (changes: Partial<TwitterSettingsState>) => void;
  caption: string;
  selectedAccounts?: SelectedAccount[];
}

export function TwitterSettings({
  settings,
  onChange,
  caption,
  selectedAccounts = [],
}: TwitterSettingsProps) {
  const { t } = useTranslation("postsettings");
  const charCount = caption.length;
  const isOverLimit = charCount > 280 && !settings.threadMode && !settings.postAsLongTweet;

  return (
    <TooltipProvider>
    <div className="space-y-6">
      {/* Posting to X as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("twitter.postingAs", "Posting to X as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("twitter", account.platform_username);
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
                    X
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

      {/* Character limit warning */}
      {isOverLimit && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {t("twitter.limitWarning", "Tweet exceeds 280 character limit ({{count}}/280). Enable thread mode or long tweet mode.", { count: charCount })}
        </div>
      )}

      {/* Custom Thumbnail Section */}
      <div className="space-y-3 border-b pb-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Image className="w-4 h-4" />
            {t("twitter.customThumbnail", "Custom Thumbnail")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.customThumbnailTooltip", "Add a custom thumbnail image for video tweets")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <span className="text-xs text-muted-foreground">{t("twitter.optional", "Optional")}</span>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*';
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) {
                  onChange({ thumbnailFile: file, thumbnailUrl: '' });
                }
              };
              input.click();
            }}
          >
            <Upload className="w-4 h-4" />
            {t("twitter.chooseFile", "Choose File")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {settings.thumbnailFile?.name || t("twitter.noFileChosen", "No file chosen")}
          </span>
        </div>

        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <span>{t("twitter.orDivider", "– OR –")}</span>
        </div>

        <Input
          placeholder={t("twitter.thumbnailUrlPlaceholder", "Thumbnail URL")}
          value={settings.thumbnailUrl}
          onChange={(e) => onChange({ thumbnailUrl: e.target.value, thumbnailFile: null })}
          className="bg-background/50"
        />
      </div>

      {/* Title and Reply Settings Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t("twitter.title", "X Title (optional)")}</Label>
            <span className="text-xs text-muted-foreground">{t("twitter.overridesTitle", "Overrides Title")}</span>
          </div>
          <Textarea
            placeholder={t("twitter.titlePlaceholder", "Custom title for X")}
            value={settings.customTitle}
            onChange={(e) => onChange({ customTitle: e.target.value })}
            className="min-h-[80px] bg-background/50 resize-y"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            {t("twitter.replySettings", "Reply settings")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.replySettingsTooltip", "Control who can reply to your tweet")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <Select 
            value={settings.replySettings} 
            onValueChange={(v) => onChange({ replySettings: v as TwitterSettingsState['replySettings'] })}
          >
            <SelectTrigger className="w-full bg-background/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">{t("twitter.replyEveryone", "All users")}</SelectItem>
              <SelectItem value="following">{t("twitter.replyFollowing", "Following")}</SelectItem>
              <SelectItem value="mentionedUsers">{t("twitter.replyMentioned", "Mentioned users")}</SelectItem>
              <SelectItem value="subscribers">{t("twitter.replySubscribers", "Subscribers")}</SelectItem>
              <SelectItem value="verified">{t("twitter.replyVerified", "Verified")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Tagged Users and Reply To Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <AtSign className="w-4 h-4" />
              {t("twitter.taggedUserIds", "Tagged user IDs")}
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("twitter.taggedUserIdsTooltip", "Tag users in media by their Twitter user IDs")}</p>
                </TooltipContent>
              </Tooltip>
            </Label>
            <span className="text-xs text-muted-foreground">{t("twitter.commaSeparated", "Comma-separated")}</span>
          </div>
          <Input
            placeholder="123, 456"
            value={settings.taggedUserIds}
            onChange={(e) => onChange({ taggedUserIds: e.target.value })}
            className="bg-background/50"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              {t("twitter.replyToTweetId", "Reply to tweet ID")}
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("twitter.replyToTweetIdTooltip", "Makes this tweet a reply to another tweet")}</p>
                </TooltipContent>
              </Tooltip>
            </Label>
            <span className="text-xs text-muted-foreground">{t("twitter.replyToTweetIdHelp", "Optional - makes this a reply")}</span>
          </div>
          <Input
            placeholder="1346889436626259968"
            value={settings.replyToTweetId}
            onChange={(e) => onChange({ replyToTweetId: e.target.value })}
            className="bg-background/50"
          />
        </div>
      </div>

      {/* Exclude Reply Users and Nullcast Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{t("twitter.excludeReplyUserIds", "Exclude reply user IDs")}</Label>
            <span className="text-xs text-muted-foreground">{t("twitter.excludeReplyUserIdsHelp", "Comma-separated, requires reply_to_id")}</span>
          </div>
          <Input
            placeholder="123, 456"
            value={settings.excludeReplyUserIds}
            onChange={(e) => onChange({ excludeReplyUserIds: e.target.value })}
            disabled={!settings.replyToTweetId}
            className="bg-background/50"
          />
        </div>

        <div className="flex items-center justify-between pt-6">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-medium">{t("twitter.nullcast", "Nullcast (no broadcast)")}</p>
              <p className="text-xs text-muted-foreground">{t("twitter.nullcastSubtitle", "Post won't appear in timelines")}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.nullcastTooltip", "Tweet won't be shown in followers' feeds or search")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Switch 
            checked={settings.nullcast} 
            onCheckedChange={(v) => onChange({ nullcast: v })} 
          />
        </div>
      </div>

      {/* Place ID */}
      <div className="space-y-2 border-b pb-4">
        <Label className="text-sm font-medium flex items-center gap-2">
          <MapPin className="w-4 h-4" />
          {t("twitter.placeId", "Place ID")}
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("twitter.placeIdTooltip", "Add a location tag to your tweet using Twitter Place ID")}</p>
            </TooltipContent>
          </Tooltip>
        </Label>
        <Input
          placeholder={t("twitter.placeIdPlaceholder", "Place ID")}
          value={settings.placeId}
          onChange={(e) => onChange({ placeId: e.target.value })}
          className="bg-background/50"
        />
      </div>

      {/* Community ID and DM Deep Link Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Users className="w-4 h-4" />
            {t("twitter.communityId", "Community ID")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.communityIdTooltip", "Post to a specific Twitter Community")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <Input
            placeholder={t("twitter.communityIdPlaceholder", "Community ID")}
            value={settings.communityId}
            onChange={(e) => onChange({ communityId: e.target.value })}
            className="bg-background/50"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Link className="w-4 h-4" />
            {t("twitter.dmDeepLink", "Direct Message Deep Link")}
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.dmDeepLinkTooltip", "Add a DM link for users to message you directly")}</p>
              </TooltipContent>
            </Tooltip>
          </Label>
          <Input
            placeholder={t("twitter.dmDeepLinkPlaceholder", "DM deep link URL")}
            value={settings.dmDeepLink}
            onChange={(e) => onChange({ dmDeepLink: e.target.value })}
            className="bg-background/50"
          />
        </div>
      </div>

      {/* Toggle Options */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-medium">{t("twitter.superFollowersOnly", "For Super Followers Only")}</p>
              <p className="text-xs text-muted-foreground">{t("twitter.superFollowersOnlySubtitle", "Exclusive to super followers")}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.superFollowersOnlyTooltip", "Only your Super Followers will see this tweet")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Switch 
            checked={settings.forSuperFollowersOnly} 
            onCheckedChange={(v) => onChange({ forSuperFollowersOnly: v })} 
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t("twitter.shareWithFollowers", "Share with Followers")}</p>
            <p className="text-xs text-muted-foreground">{t("twitter.shareWithFollowersSubtitle", "Share to your followers")}</p>
          </div>
          <Switch 
            checked={settings.shareWithFollowers} 
            onCheckedChange={(v) => onChange({ shareWithFollowers: v })} 
          />
        </div>
      </div>

      {/* Post as Single Long Tweet */}
      <div className="space-y-2 border-b pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-medium">{t("twitter.postAsLongTweet", "Post as a single long tweet")}</p>
              <p className="text-xs text-muted-foreground">{t("twitter.postAsLongTweetSubtitle", "If disabled, long content will be posted as a threaded series.")}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.postAsLongTweetTooltip", "Uses X Premium's long-form tweet feature (requires X Premium)")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Switch 
            checked={settings.postAsLongTweet} 
            onCheckedChange={(v) => onChange({ postAsLongTweet: v, threadMode: v ? false : settings.threadMode })} 
          />
        </div>
      </div>

      {/* Thread Mode */}
      <div className="space-y-4 border-b pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-medium">{t("twitter.threadMode", "Thread mode")}</p>
              <p className="text-xs text-muted-foreground">{t("twitter.threadModeSubtitle", "Split long posts into multiple tweets")}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.threadModeTooltip", "Automatically splits content into a connected thread of tweets")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Switch 
            checked={settings.threadMode} 
            onCheckedChange={(v) => onChange({ threadMode: v, postAsLongTweet: v ? false : settings.postAsLongTweet })} 
            disabled={settings.postAsLongTweet}
          />
        </div>

        {/* Thread Preview - show when thread mode is enabled and caption is long */}
        {settings.threadMode && caption.length > 280 && (
          <TwitterThreadPreview 
            caption={caption}
            username="preview"
          />
        )}
      </div>

      {/* Quote Tweet */}
      <div className="space-y-2 border-b pb-4">
        <Label className="text-sm font-medium">{t("twitter.quoteTweetUrl", "Quote Tweet URL (optional)")}</Label>
        <Input
          placeholder={t("twitter.quoteTweetPlaceholder", "Paste tweet URL to quote...")}
          value={settings.quoteTweetUrl}
          onChange={(e) => onChange({ quoteTweetUrl: e.target.value })}
          className="bg-background/50"
        />
        <p className="text-xs text-muted-foreground">{t("twitter.quoteTweetHelp", "Quote another tweet in your post")}</p>
      </div>

      {/* Poll */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-sm font-medium">{t("twitter.addPoll", "Add Poll")}</p>
              <p className="text-xs text-muted-foreground">{t("twitter.addPollSubtitle", "Create a poll for your followers")}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("twitter.addPollTooltip", "Add an interactive poll with 2-4 options")}</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <Switch 
            checked={settings.pollEnabled} 
            onCheckedChange={(v) => onChange({ pollEnabled: v })} 
          />
        </div>

        {settings.pollEnabled && (
          <div className="space-y-3 ps-4 border-l-2 border-primary/30">
            {settings.pollOptions.map((option, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  placeholder={t("twitter.pollOptionPlaceholder", "Option {{num}}", { num: idx + 1 })}
                  value={option}
                  onChange={(e) => {
                    const newOptions = [...settings.pollOptions];
                    newOptions[idx] = e.target.value;
                    onChange({ pollOptions: newOptions });
                  }}
                  maxLength={25}
                  className="bg-background/50"
                />
                {settings.pollOptions.length > 2 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const newOptions = settings.pollOptions.filter((_, i) => i !== idx);
                      onChange({ pollOptions: newOptions });
                    }}
                  >
                    <Minus className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}

            {settings.pollOptions.length < 4 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onChange({ pollOptions: [...settings.pollOptions, ""] })}
              >
                <Plus className="w-4 h-4 me-2" />
                {t("twitter.addOption", "Add option")}
              </Button>
            )}

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("twitter.pollDuration", "Poll duration")}</Label>
              <Select value={settings.pollDuration} onValueChange={(v) => onChange({ pollDuration: v })}>
                <SelectTrigger className="w-full max-w-xs bg-background/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">{t("twitter.duration5m", "5 minutes")}</SelectItem>
                  <SelectItem value="30">{t("twitter.duration30m", "30 minutes")}</SelectItem>
                  <SelectItem value="60">{t("twitter.duration1h", "1 hour")}</SelectItem>
                  <SelectItem value="360">{t("twitter.duration6h", "6 hours")}</SelectItem>
                  <SelectItem value="720">{t("twitter.duration12h", "12 hours")}</SelectItem>
                  <SelectItem value="1440">{t("twitter.duration1d", "1 day")}</SelectItem>
                  <SelectItem value="4320">{t("twitter.duration3d", "3 days")}</SelectItem>
                  <SelectItem value="10080">{t("twitter.duration7d", "7 days")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
}
