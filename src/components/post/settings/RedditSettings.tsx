import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { Info, Link, MessageSquare, Image, AlertCircle, Loader2, Hash, Type, Tag, EyeOff, AlertTriangle, Bell, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";

export interface RedditSettingsState {
  subreddit: string;
  title: string;
  postType: "self" | "link" | "image";
  linkUrl: string;
  spoiler: boolean;
  nsfw: boolean;
  sendReplies: boolean;
  flair: string;
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface RedditSettingsProps {
  settings: RedditSettingsState;
  onChange: (changes: Partial<RedditSettingsState>) => void;
  hasMedia: boolean;
  subredditSuggestions?: string[];
  loadingSuggestions?: boolean;
  onSearchSubreddits?: (query: string) => void;
  selectedAccounts?: SelectedAccount[];
}

const postTypeOptions = [
  { value: "self", label: "Text Post", icon: MessageSquare, description: "Post with text body" },
  { value: "link", label: "Link Post", icon: Link, description: "Share a URL" },
  { value: "image", label: "Image/Video", icon: Image, description: "Upload media" },
];

export function RedditSettings({ 
  settings, 
  onChange, 
  hasMedia,
  subredditSuggestions = [],
  loadingSuggestions = false,
  onSearchSubreddits,
  selectedAccounts = [],
}: RedditSettingsProps) {
  const { t } = useTranslation("postsettings");

  const getPostTypeLabel = (value: RedditSettingsState["postType"]) => {
    switch (value) {
      case "self":
        return {
          label: t("reddit.postTypeText", "Text Post"),
          description: t("reddit.postTypeTextDesc", "Post with text body"),
        };
      case "link":
        return {
          label: t("reddit.postTypeLink", "Link Post"),
          description: t("reddit.postTypeLinkDesc", "Share a URL"),
        };
      case "image":
        return {
          label: t("reddit.postTypeMedia", "Image/Video"),
          description: t("reddit.postTypeMediaDesc", "Upload media"),
        };
    }
  };

  return (
    <div className="space-y-5">
      {/* Posting to Reddit as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("reddit.postingAs", "Posting to Reddit as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("reddit", account.platform_username);
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
                  <div className={cn("w-8 h-8 rounded-full bg-[#FF4500] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    R
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium flex items-center gap-1">
                      u/{account.platform_username || "Unknown"}
                      {profileUrl && <ExternalLink className="w-3 h-3 text-muted-foreground" />}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Subreddit */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Hash className="w-4 h-4" />
                {t("reddit.subreddit", "Subreddit")} <span className="text-destructive">*</span>
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("reddit.subredditTooltip", "The subreddit community where your post will appear")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">r/</span>
          <Input
            className="pl-7"
            placeholder="subreddit_name"
            value={settings.subreddit}
            onChange={(e) => {
              const value = e.target.value.replace(/^r\//, "").replace(/\s/g, "_");
              onChange({ subreddit: value });
              onSearchSubreddits?.(value);
            }}
          />
        </div>
        {loadingSuggestions && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t("reddit.searchingSubreddits", "Searching subreddits...")}
          </div>
        )}
        {subredditSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {subredditSuggestions.slice(0, 5).map((sub) => (
              <Button
                key={sub}
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => onChange({ subreddit: sub })}
              >
                r/{sub}
              </Button>
            ))}
          </div>
        )}
        {!settings.subreddit && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {t("reddit.subredditRequired", "Subreddit is required")}
          </p>
        )}
      </div>

      {/* Title */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Type className="w-4 h-4" />
                {t("reddit.title", "Title")} <span className="text-destructive">*</span>
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("reddit.titleTooltip", "A compelling title is essential for Reddit - it determines if users click")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Input
          placeholder={t("reddit.titlePlaceholder", "An interesting title")}
          value={settings.title}
          onChange={(e) => onChange({ title: e.target.value })}
          maxLength={300}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t("reddit.requiredForAll", "Required for all Reddit posts")}</span>
          <span>{settings.title.length}/300</span>
        </div>
      </div>

      {/* Post Type */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("reddit.postType", "Post type")}</Label>
        <RadioGroup
          value={settings.postType}
          onValueChange={(v) => onChange({ postType: v as RedditSettingsState["postType"] })}
          className="grid gap-2"
        >
          {postTypeOptions.map((option) => {
            const IconComponent = option.icon;
            const isDisabled = option.value === "image" && !hasMedia;
            const opt = getPostTypeLabel(option.value as RedditSettingsState["postType"]);
            
            return (
              <label
                key={option.value}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                  settings.postType === option.value
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-secondary/50",
                  isDisabled && "opacity-50 cursor-not-allowed"
                )}
              >
                <RadioGroupItem value={option.value} disabled={isDisabled} />
                <IconComponent className="w-4 h-4 text-muted-foreground" />
                <div>
                  <span className="text-sm font-medium">{opt.label}</span>
                  <p className="text-xs text-muted-foreground">{opt.description}</p>
                </div>
              </label>
            );
          })}
        </RadioGroup>
      </div>

      {/* Link URL (for link posts) */}
      {settings.postType === "link" && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            {t("reddit.linkUrl", "Link URL")} <span className="text-destructive">*</span>
          </Label>
          <Input
            placeholder="https://example.com"
            value={settings.linkUrl}
            onChange={(e) => onChange({ linkUrl: e.target.value })}
          />
        </div>
      )}

      {/* Flair */}
      <div className="space-y-2 border-t pt-4">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                <Tag className="w-4 h-4" />
                {t("reddit.flair", "Flair")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("reddit.flairTooltip", "Some subreddits require a flair - check the community rules")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Input
          placeholder={t("reddit.flairPlaceholder", "Optional flair text")}
          value={settings.flair}
          onChange={(e) => onChange({ flair: e.target.value })}
        />
      </div>

      {/* Toggles */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <EyeOff className="w-4 h-4 mt-0.5 text-muted-foreground" />
            <div>
              <Label className="text-sm font-medium">{t("reddit.markSpoiler", "Mark as Spoiler")}</Label>
              <p className="text-xs text-muted-foreground">{t("reddit.markSpoilerSubtitle", "Blur content until clicked")}</p>
            </div>
          </div>
          <Switch
            checked={settings.spoiler}
            onCheckedChange={(v) => onChange({ spoiler: v })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-muted-foreground" />
            <div>
              <Label className="text-sm font-medium">{t("reddit.markNsfw", "Mark as NSFW")}</Label>
              <p className="text-xs text-muted-foreground">{t("reddit.markNsfwSubtitle", "Not Safe For Work content")}</p>
            </div>
          </div>
          <Switch
            checked={settings.nsfw}
            onCheckedChange={(v) => onChange({ nsfw: v })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <Bell className="w-4 h-4 mt-0.5 text-muted-foreground" />
            <div>
              <Label className="text-sm font-medium">{t("reddit.sendReplies", "Send reply notifications")}</Label>
              <p className="text-xs text-muted-foreground">{t("reddit.sendRepliesSubtitle", "Get notified when someone replies")}</p>
            </div>
          </div>
          <Switch
            checked={settings.sendReplies}
            onCheckedChange={(v) => onChange({ sendReplies: v })}
          />
        </div>
      </div>

      {/* Platform info */}
      <div className="p-3 bg-muted/30 rounded-lg border-t">
        <p className="text-xs text-muted-foreground">
          <strong>{t("reddit.notePrefix", "Note:")}</strong> {t("reddit.platformNote", "Reddit titles are limited to 300 characters. Self posts can have up to 40,000 characters in the body.")}
        </p>
      </div>
    </div>
  );
}
