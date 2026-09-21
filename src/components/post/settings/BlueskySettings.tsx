import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Info, Link, Languages, Image, ExternalLink, 
  AlertTriangle, MessageSquare, Users, Lock, List, Loader2, RefreshCw
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getPlatformProfileUrl } from "@/lib/platformProfileUrls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export interface BlueskyList {
  uri: string;
  name: string;
  purpose: string;
  avatar?: string;
  listItemCount?: number;
}

export type BlueskyReplyOption = "anyone" | "nobody" | "following" | "mentioned" | "list";

export interface BlueskyReplySettings {
  // Legacy fields - kept for backwards compatibility
  allowAll?: boolean;
  allowNone?: boolean;
  allowFollowers?: boolean;
  allowFollowing?: boolean;
  allowMentioned?: boolean;
  allowFromLists?: boolean;
  // New single-select approach
  selectedOption: BlueskyReplyOption;
  selectedListUri: string | null; // Single list URI when "list" is selected
  selectedListUris?: string[]; // Legacy - kept for backwards compatibility
}

export interface BlueskySettingsState {
  altText: string;
  language: string;
  embedLink: string;
  embedEnabled: boolean;
  // Content warning / labels
  contentWarning: string;
  adultContent: boolean;
  // Reply controls - new structure
  replySettings: BlueskyReplySettings;
  // Legacy field for backwards compatibility
  replyControl?: "everyone" | "following" | "mentions" | "none";
}

interface SelectedAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

interface BlueskySettingsProps {
  settings: BlueskySettingsState;
  onChange: (changes: Partial<BlueskySettingsState>) => void;
  hasMedia: boolean;
  selectedAccounts?: SelectedAccount[];
}

const languageOptions = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
];

const defaultReplySettings: BlueskyReplySettings = {
  selectedOption: "anyone",
  selectedListUri: null,
};

export function BlueskySettings({ settings, onChange, hasMedia, selectedAccounts = [] }: BlueskySettingsProps) {
  const { t } = useTranslation("postsettings");
  const replySettings = settings.replySettings || defaultReplySettings;
  const [lists, setLists] = useState<BlueskyList[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);

  const getLanguageLabel = (code: string) => {
    switch (code) {
      case "":
        return t("bluesky.langAuto", "Auto-detect");
      case "en":
        return t("bluesky.langEn", "English");
      case "ar":
        return t("bluesky.langAr", "Arabic");
      case "es":
        return t("bluesky.langEs", "Spanish");
      case "fr":
        return t("bluesky.langFr", "French");
      case "de":
        return t("bluesky.langDe", "German");
      case "ja":
        return t("bluesky.langJa", "Japanese");
      case "ko":
        return t("bluesky.langKo", "Korean");
      case "pt":
        return t("bluesky.langPt", "Portuguese");
      case "zh":
        return t("bluesky.langZh", "Chinese");
      default:
        return code;
    }
  };

  // Fetch lists when "list" option is selected
  useEffect(() => {
    if (replySettings.selectedOption === "list" && selectedAccounts.length > 0 && lists.length === 0) {
      fetchBlueskyLists();
    }
  }, [replySettings.selectedOption, selectedAccounts]);

  const fetchBlueskyLists = async () => {
    if (selectedAccounts.length === 0) {
      setListsError(t("bluesky.errorNoAccount", "No Bluesky account selected"));
      return;
    }

    setLoadingLists(true);
    setListsError(null);

    try {
      const { data, error } = await supabase.functions.invoke("bluesky-oauth", {
        body: {
          action: "get_lists",
          account_id: selectedAccounts[0].id,
        },
      });

      if (error) throw error;

      if (data?.lists) {
        setLists(data.lists);
      } else if (data?.error) {
        setListsError(data.error);
      }
    } catch (err) {
      console.error("Failed to fetch Bluesky lists:", err);
      setListsError(t("bluesky.errorFetchLists", "Failed to fetch lists. Please try again."));
    } finally {
      setLoadingLists(false);
    }
  };

  const handleOptionSelect = (option: BlueskyReplyOption) => {
    onChange({
      replySettings: {
        ...replySettings,
        selectedOption: option,
        selectedListUri: option === "list" ? replySettings.selectedListUri : null,
      }
    });
  };

  const handleListSelect = (listUri: string) => {
    onChange({
      replySettings: {
        ...replySettings,
        selectedListUri: listUri,
      }
    });
  };

  return (
    <div className="space-y-5">
      {/* Platform Limits Info */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs space-y-2">
        <div className="flex items-center gap-2 font-semibold text-blue-700 dark:text-blue-400">
          <Info className="w-4 h-4" />
          {t("bluesky.platformLimitsTitle", "Bluesky Platform Limits")}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
          <span>{t("bluesky.limitTextLabel", "📝 Text:")} <span className="font-medium text-foreground/80">{t("bluesky.limitTextVal", "300 characters max")}</span></span>
          <span>{t("bluesky.limitImagesLabel", "🖼️ Images:")} <span className="font-medium text-foreground/80">{t("bluesky.limitImagesVal", "4 per post, 1MB each")}</span></span>
          <span>{t("bluesky.limitVideoLabel", "🎥 Video:")} <span className="font-medium text-foreground/80">{t("bluesky.limitVideoVal", "50MB, 60 sec max")}</span></span>
          <span>{t("bluesky.limitFormatsLabel", "📁 Formats:")} <span className="font-medium text-foreground/80">{t("bluesky.limitFormatsVal", "JPEG, PNG, WebP, MP4")}</span></span>
        </div>
        <p className="text-muted-foreground/80 italic">{t("bluesky.cloudinaryNotice", "Cloudinary images are auto-compressed to fit the 1MB limit.")}</p>
      </div>

      {/* Posting to Bluesky as: */}
      {selectedAccounts.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("bluesky.postingAs", "Posting to Bluesky as:")}</Label>
          <div className="flex flex-wrap gap-2">
            {selectedAccounts.map((account) => {
              const profileUrl = getPlatformProfileUrl("bluesky", account.platform_username);
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
                  <div className={cn("w-8 h-8 rounded-full bg-[#0085FF] flex items-center justify-center text-white text-xs font-bold", account.avatar_url && "hidden")}>
                    BS
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
      
      {/* Alt text for images */}
      {hasMedia && (
        <div className="space-y-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-2 cursor-help">
                  <Image className="w-4 h-4" />
                  {t("bluesky.altText", "Alt text")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("bluesky.altTextTooltip", "Describe your image for users who can't see it - improves accessibility")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Textarea
            placeholder={t("bluesky.altTextPlaceholder", "Describe your image for accessibility...")}
            value={settings.altText}
            onChange={(e) => onChange({ altText: e.target.value })}
            maxLength={2000}
            rows={2}
          />
          <p className="text-xs text-muted-foreground text-end">
            {settings.altText.length}/2000
          </p>
        </div>
      )}

      {/* Language */}
      <div className="space-y-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Label className="text-sm font-medium flex items-center gap-1 cursor-help">
                <Languages className="w-4 h-4" />
                {t("bluesky.postLanguage", "Post language")}
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t("bluesky.postLanguageTooltip", "Helps categorize your post for users browsing by language")}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <select
          className="w-full h-9 px-3 py-1 text-sm rounded-md border border-input bg-background"
          value={settings.language}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          {languageOptions.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {getLanguageLabel(lang.code)}
            </option>
          ))}
        </select>
      </div>

      {/* External embed link */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-1 cursor-help">
                  <Link className="w-4 h-4" />
                  {t("bluesky.linkEmbed", "Link embed")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("bluesky.linkEmbedTooltip", "Add a link card with title, description, and image")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Switch
            checked={settings.embedEnabled}
            onCheckedChange={(v) => onChange({ embedEnabled: v })}
          />
        </div>
        
        {settings.embedEnabled && (
          <div className="space-y-2 mt-2">
            <Input
              placeholder="https://example.com/article"
              value={settings.embedLink}
              onChange={(e) => onChange({ embedLink: e.target.value })}
            />
          </div>
        )}
      </div>

      {/* Content Warning / Labels */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Label className="text-sm font-medium flex items-center gap-1 cursor-help">
                  <AlertTriangle className="w-4 h-4" />
                  {t("bluesky.contentWarning", "Content warning")}
                </Label>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("bluesky.contentWarningTooltip", "Add a content warning label to your post")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        
        <Input
          placeholder={t("bluesky.contentWarningPlaceholder", "Optional content warning (e.g., 'spoilers', 'sensitive')")}
          value={settings.contentWarning || ""}
          onChange={(e) => onChange({ contentWarning: e.target.value })}
          maxLength={64}
        />

        <div className="flex items-center justify-between">
          <Label className="text-sm flex items-center gap-2">
            <span>{t("bluesky.adultContent", "Adult content")}</span>
            {settings.adultContent && (
              <Badge variant="outline" className="text-xs text-amber-600 border-amber-500/50">
                18+
              </Badge>
            )}
          </Label>
          <Switch
            checked={settings.adultContent || false}
            onCheckedChange={(v) => onChange({ adultContent: v })}
          />
        </div>
      </div>

      {/* Reply Controls - Single-select radio style */}
      <div className="space-y-4 border-t pt-4">
        <Label className="text-sm font-medium flex items-center gap-1">
          <MessageSquare className="w-4 h-4" />
          {t("bluesky.interactionSettings", "Post interaction settings")}
        </Label>
        
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("bluesky.whoCanReply", "Who can reply")}</p>
          
          {/* Radio-style options */}
          <div className="space-y-2">
            {/* Anyone */}
            <button
              type="button"
              onClick={() => handleOptionSelect("anyone")}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-start",
                replySettings.selectedOption === "anyone"
                  ? "bg-primary/10 border border-primary/30"
                  : "bg-secondary/50 hover:bg-secondary/80 border border-transparent"
              )}
            >
              <div className={cn(
                "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                replySettings.selectedOption === "anyone" 
                  ? "border-primary" 
                  : "border-muted-foreground"
              )}>
                {replySettings.selectedOption === "anyone" && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
              </div>
              <Users className="w-4 h-4" />
              {t("bluesky.replyAnyone", "Anyone")}
            </button>

            {/* Nobody */}
            <button
              type="button"
              onClick={() => handleOptionSelect("nobody")}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-start",
                replySettings.selectedOption === "nobody"
                  ? "bg-primary/10 border border-primary/30"
                  : "bg-secondary/50 hover:bg-secondary/80 border border-transparent"
              )}
            >
              <div className={cn(
                "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                replySettings.selectedOption === "nobody" 
                  ? "border-primary" 
                  : "border-muted-foreground"
              )}>
                {replySettings.selectedOption === "nobody" && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
              </div>
              <Lock className="w-4 h-4" />
              {t("bluesky.replyNobody", "Nobody")}
            </button>

            {/* People you follow */}
            <button
              type="button"
              onClick={() => handleOptionSelect("following")}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-start",
                replySettings.selectedOption === "following"
                  ? "bg-primary/10 border border-primary/30"
                  : "bg-secondary/50 hover:bg-secondary/80 border border-transparent"
              )}
            >
              <div className={cn(
                "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                replySettings.selectedOption === "following" 
                  ? "border-primary" 
                  : "border-muted-foreground"
              )}>
                {replySettings.selectedOption === "following" && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
              </div>
              <Users className="w-4 h-4" />
              {t("bluesky.replyFollowing", "People you follow")}
            </button>

            {/* People you mention */}
            <button
              type="button"
              onClick={() => handleOptionSelect("mentioned")}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-start",
                replySettings.selectedOption === "mentioned"
                  ? "bg-primary/10 border border-primary/30"
                  : "bg-secondary/50 hover:bg-secondary/80 border border-transparent"
              )}
            >
              <div className={cn(
                "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                replySettings.selectedOption === "mentioned" 
                  ? "border-primary" 
                  : "border-muted-foreground"
              )}>
                {replySettings.selectedOption === "mentioned" && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
              </div>
              <MessageSquare className="w-4 h-4" />
              {t("bluesky.replyMentioned", "People you mention")}
            </button>

            {/* Select from your lists */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => handleOptionSelect("list")}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-start",
                  replySettings.selectedOption === "list"
                    ? "bg-primary/10 border border-primary/30"
                    : "bg-secondary/50 hover:bg-secondary/80 border border-transparent"
                )}
              >
                <div className={cn(
                  "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                  replySettings.selectedOption === "list" 
                    ? "border-primary" 
                    : "border-muted-foreground"
                )}>
                  {replySettings.selectedOption === "list" && (
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  )}
                </div>
                <List className="w-4 h-4" />
                {t("bluesky.replyLists", "Select from your lists")}
                {replySettings.selectedOption === "list" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchBlueskyLists();
                    }}
                    disabled={loadingLists}
                    className="ms-auto h-6 px-2"
                  >
                    <RefreshCw className={cn("w-3 h-3", loadingLists && "animate-spin")} />
                  </Button>
                )}
              </button>

              {/* Lists dropdown when "list" option is selected */}
              {replySettings.selectedOption === "list" && (
                <div className="ms-6 space-y-2">
                  {loadingLists ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>{t("bluesky.loadingLists", "Loading your lists...")}</span>
                    </div>
                  ) : listsError ? (
                    <div className="flex items-center gap-2 text-sm text-destructive py-2">
                      <AlertTriangle className="w-4 h-4" />
                      <span>{listsError}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={fetchBlueskyLists}
                        className="h-6 px-2 text-xs"
                      >
                        {t("bluesky.retry", "Retry")}
                      </Button>
                    </div>
                  ) : lists.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      {t("bluesky.noListsFound", "No lists found. Create lists on Bluesky first.")}
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-48 overflow-y-auto border rounded-lg p-2 bg-background">
                      {lists.map((list) => {
                        const isSelected = replySettings.selectedListUri === list.uri;
                        return (
                          <div
                            key={list.uri}
                            onClick={() => handleListSelect(list.uri)}
                            className={cn(
                              "flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors",
                              isSelected 
                                ? "bg-primary/10 border border-primary/30" 
                                : "hover:bg-muted border border-transparent"
                            )}
                          >
                            <div className={cn(
                              "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                              isSelected ? "border-primary" : "border-muted-foreground"
                            )}>
                              {isSelected && (
                                <div className="w-2 h-2 rounded-full bg-primary" />
                              )}
                            </div>
                            {list.avatar ? (
                              <img
                                src={list.avatar}
                                alt=""
                                className="w-8 h-8 rounded object-cover flex-shrink-0"
                              />
                            ) : (
                              <div className="w-8 h-8 rounded bg-muted flex items-center justify-center flex-shrink-0">
                                <Users className="w-4 h-4 text-muted-foreground" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{list.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {t("bluesky.membersCount", "{{count}} members", { count: list.listItemCount || 0 })} • {list.purpose === "app.bsky.graph.defs#modlist" ? t("bluesky.purposeModeration", "Moderation") : t("bluesky.purposeCurate", "Curate")}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  
                  {replySettings.selectedListUri && (
                    <p className="text-xs text-muted-foreground">
                      {t("bluesky.oneListSelected", "1 list selected")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Platform info */}
      <div className="p-3 bg-muted/30 rounded-lg border-t">
        <p className="text-xs text-muted-foreground">
          <strong>{t("bluesky.notePrefix", "Note:")}</strong> {t("bluesky.platformNote", "Bluesky posts are limited to 300 characters. You can attach up to 4 images or 1 video (max 60s).")}
        </p>
      </div>
    </div>
  );
}
