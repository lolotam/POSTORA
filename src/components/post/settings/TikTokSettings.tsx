// ═══════════════════════════════════════════════════════════════════════════
// TikTok Settings Component
// Redesigned to match TikTok's official Content Posting interface
// Implements all TikTok Content Posting API UX requirements
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { tiktokPrivacyOptions } from "@/lib/platformConstants";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Info,
  Loader2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Clock,
  ChevronRight,
  Check,
  Eye,
} from "lucide-react";
import { TikTokPreviewDialog } from "../TikTokPreviewDialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ─────────────────────────────────────────────────────────────────────────────
// Custom TikTok-style Checkbox Component
// ─────────────────────────────────────────────────────────────────────────────
interface TikTokCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}

function TikTokCheckbox({ checked, onCheckedChange, disabled, label }: TikTokCheckboxProps) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 cursor-pointer select-none",
        disabled && "opacity-50 cursor-not-allowed"
      )}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        className={cn(
          "w-6 h-6 rounded-md flex items-center justify-center transition-all duration-200",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#25f4ee]",
          checked
            ? "bg-[#25f4ee] border-[#25f4ee]"
            : "bg-transparent border-2 border-muted-foreground/40 hover:border-muted-foreground/60"
        )}
      >
        {checked && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          >
            <Check className="w-4 h-4 text-white stroke-[3]" />
          </motion.div>
        )}
      </button>
      <span className="text-sm font-medium">{label}</span>
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export interface TikTokSettingsState {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  title: string;
  discloseContent: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
  consentAgreed: boolean;
  musicCheck: boolean;
  contentCheck: boolean;
}

export interface TikTokCreatorInfo {
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
  creator_nickname?: string;
  creator_avatar_url?: string;
  creator_username?: string;
  creator_posting_blocked?: boolean;
  posting_blocked_reason?: string;
  daily_limit_total?: number;
  daily_limit_remaining?: number;
}

interface TikTokSettingsProps {
  settings: TikTokSettingsState;
  onSettingsChange: (settings: Partial<TikTokSettingsState>) => void;
  creatorInfo: TikTokCreatorInfo | null;
  loadingCreatorInfo: boolean;
  hasVideo: boolean;
  hasOnlyImages: boolean;
  isCheckingMusic: boolean;
  musicCopyrightResult: {
    hasCopyrightedMusic?: boolean;
    musicInfo?: { title: string; artist: string; album?: string };
  } | null;
  onRunMusicCheck: () => void;
  canRunMusicCheck: boolean;
  selectedAccounts: Array<{
    id: string;
    platform_username: string | null;
    avatar_url: string | null;
    tiktok_username?: string | null;
  }>;
  hasDraft: boolean;
  onLoadDraft: () => void;
  onSaveDraft: () => void;
  onDiscard: () => void;
  isPosting: boolean;
  scheduleEnabled: boolean;
  // New props for preview dialog
  mediaFiles?: Array<{
    previewUrl?: string;
    fileType: "image" | "video" | "gif";
    file?: File;
    fileName?: string;
  }>;
  caption?: string;
  onUpload?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Component - Redesigned to match TikTok's official interface
// ═══════════════════════════════════════════════════════════════════════════

export function TikTokSettings({
  settings,
  onSettingsChange,
  creatorInfo,
  loadingCreatorInfo,
  hasVideo,
  hasOnlyImages,
  isCheckingMusic,
  musicCopyrightResult,
  onRunMusicCheck,
  canRunMusicCheck,
  selectedAccounts,
  hasDraft,
  onLoadDraft,
  onSaveDraft,
  onDiscard,
  isPosting,
  scheduleEnabled,
  mediaFiles = [],
  caption = "",
  onUpload,
}: TikTokSettingsProps) {
  const { toast } = useToast();
  const { t } = useTranslation("postsettings");
  const hasShownLowQuotaWarning = useRef(false);
  const [showDisclosurePanel, setShowDisclosurePanel] = useState(false);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);

  const getPrivacyOptionLabel = (value: string, defaultLabel: string) => {
    switch (value) {
      case "PUBLIC_TO_EVERYONE":
        return t("tiktok.privacyPublic", "Everyone");
      case "MUTUAL_FOLLOW_FRIENDS":
        return t("tiktok.privacyFriends", "Friends only");
      case "FOLLOWER_OF_CREATOR":
        return t("tiktok.privacyFollowers", "Followers");
      case "SELF_ONLY":
        return t("tiktok.privacySelf", "Only me");
      default:
        return defaultLabel;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Privacy options from creator_info API (TikTok requirement)
  // ─────────────────────────────────────────────────────────────────────────
  const getAvailablePrivacyOptions = () => {
    if (creatorInfo?.privacy_level_options && creatorInfo.privacy_level_options.length > 0) {
      return tiktokPrivacyOptions.filter((opt) =>
        creatorInfo.privacy_level_options!.includes(opt.value)
      );
    }
    return tiktokPrivacyOptions;
  };

  // Check if creator has reached daily posting limit
  const isCreatorPostingBlocked = creatorInfo?.creator_posting_blocked === true;

  // Show warning when close to daily limit
  useEffect(() => {
    if (
      !loadingCreatorInfo &&
      creatorInfo &&
      typeof creatorInfo.daily_limit_remaining === "number" &&
      creatorInfo.daily_limit_remaining > 0 &&
      creatorInfo.daily_limit_remaining <= 3 &&
      !hasShownLowQuotaWarning.current
    ) {
      hasShownLowQuotaWarning.current = true;
      toast({
        title: t("tiktok.dailyLimitWarningTitle", "TikTok Daily Limit Warning"),
        description: t("tiktok.dailyLimitWarningDesc", `You have ${creatorInfo.daily_limit_remaining} post${creatorInfo.daily_limit_remaining === 1 ? "" : "s"} remaining today.`, { count: creatorInfo.daily_limit_remaining }),
        variant: "default",
        className: "border-amber-500/50 bg-amber-50 dark:bg-amber-950/30",
      });
    }
  }, [creatorInfo, loadingCreatorInfo, toast, t]);

  // Auto-expand disclosure panel when content disclosure is enabled
  useEffect(() => {
    if (settings.discloseContent) {
      setShowDisclosurePanel(true);
    }
  }, [settings.discloseContent]);

  // ─────────────────────────────────────────────────────────────────────────
  // Validation Logic
  // ─────────────────────────────────────────────────────────────────────────
  const isBrandedContentPrivacyConflict = settings.brandedContent && settings.privacyLevel === "SELF_ONLY";
  const isCommercialDisclosureIncomplete = settings.discloseContent && !settings.yourBrand && !settings.brandedContent;

  const getContentLabel = () => {
    if (settings.brandedContent) return t("tiktok.paidPartnership", "Paid partnership");
    if (settings.yourBrand) return t("tiktok.promotionalContent", "Promotional content");
    return null;
  };

  const isPublishDisabled =
    isPosting ||
    !settings.consentAgreed ||
    !settings.privacyLevel ||
    isCommercialDisclosureIncomplete ||
    isBrandedContentPrivacyConflict ||
    isCreatorPostingBlocked;

  const getPublishDisabledReason = () => {
    if (isCreatorPostingBlocked) return creatorInfo?.posting_blocked_reason || t("tiktok.dailyLimitReached", "Daily limit reached");
    if (!settings.privacyLevel) return t("tiktok.selectWhoCanView", "Select who can view this video");
    if (!settings.consentAgreed) return t("tiktok.agreeToTerms", "Agree to TikTok's terms");
    if (isCommercialDisclosureIncomplete) return t("tiktok.indicatePromotion", "You need to indicate if your content promotes yourself, a third party, or both");
    if (isBrandedContentPrivacyConflict) return t("tiktok.brandedContentCannotBePrivate", "Branded content cannot be private");
    return "";
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle privacy change with branded content logic
  // ─────────────────────────────────────────────────────────────────────────
  const handlePrivacyChange = (value: string) => {
    if (value === "SELF_ONLY" && settings.brandedContent) {
      onSettingsChange({ privacyLevel: value, brandedContent: false });
    } else {
      onSettingsChange({ privacyLevel: value });
    }
  };

  // Handle branded content toggle with privacy auto-switch
  const handleBrandedContentChange = (checked: boolean) => {
    if (checked && settings.privacyLevel === "SELF_ONLY") {
      const availableOptions = getAvailablePrivacyOptions();
      const publicOption = availableOptions.find((opt) => opt.value === "PUBLIC_TO_EVERYONE");
      const newPrivacy = publicOption?.value || availableOptions[0]?.value || "";
      onSettingsChange({ brandedContent: checked, privacyLevel: newPrivacy });
    } else {
      onSettingsChange({ brandedContent: checked });
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Render - TikTok-style compact layout with responsive design
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {/* ─────────────────────────────────────────────────────────────────────
          Main Settings Panel (Left Side on desktop, Top on mobile)
      ───────────────────────────────────────────────────────────────────── */}
      <div className={cn(
        "flex-1 space-y-4 transition-all duration-300",
        showDisclosurePanel && "lg:max-w-[55%]"
      )}>
        
        {/* Posting Blocked Alert */}
        {isCreatorPostingBlocked && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">{t("tiktok.postingUnavailable", "Posting unavailable")}</p>
              <p className="text-xs text-destructive/80">
                {creatorInfo?.posting_blocked_reason || t("tiktok.dailyLimitReachedTryLater", "Daily limit reached. Try again later.")}
              </p>
            </div>
          </div>
        )}

        {/* Account Selector - TikTok Official Style with Badge */}
        {selectedAccounts.length > 0 && (
          <div className="space-y-1">
            {loadingCreatorInfo ? (
              <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg border">
                <Skeleton className="w-12 h-12 rounded-full" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-4 ml-auto" />
              </div>
            ) : (
              selectedAccounts.map((account) => {
                const tiktokHandle = account.tiktok_username || account.platform_username;
                const profileUrl = tiktokHandle ? `https://www.tiktok.com/@${tiktokHandle.replace("@", "")}` : null;
                const displayName = creatorInfo?.creator_nickname || account.platform_username || t("tiktok.accountFallback", "TikTok Account");

                return (
                  <a
                    key={account.id}
                    href={profileUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "flex items-center justify-between p-3 rounded-lg border bg-muted/30 transition-colors",
                      profileUrl && "hover:bg-muted/50 cursor-pointer"
                    )}
                    onClick={(e) => !profileUrl && e.preventDefault()}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar with TikTok Badge */}
                      <div className="relative">
                        {creatorInfo?.creator_avatar_url || account.avatar_url ? (
                          <img
                            src={creatorInfo?.creator_avatar_url || account.avatar_url || ""}
                            alt=""
                            className="w-12 h-12 rounded-full object-cover border-2 border-muted"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#00f2ea] to-[#ff0050] flex items-center justify-center text-white text-sm font-bold">
                            TT
                          </div>
                        )}
                        {/* TikTok Badge Overlay */}
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-black rounded-full flex items-center justify-center border-2 border-background">
                          <svg viewBox="0 0 24 24" className="w-3 h-3 text-white" fill="currentColor">
                            <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                          </svg>
                        </div>
                      </div>
                      
                      {/* Name and handle */}
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {displayName}
                        </p>
                        {tiktokHandle && (
                          <p className="text-xs text-muted-foreground truncate">@{tiktokHandle.replace("@", "")}</p>
                        )}
                      </div>
                    </div>
                    
                    {/* Chevron Icon */}
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </a>
                );
              })
            )}
          </div>
        )}

        {/* Daily Limit Progress - Compact */}
        {typeof creatorInfo?.daily_limit_remaining === "number" && typeof creatorInfo?.daily_limit_total === "number" && (
          <div className="space-y-1.5 px-2">
            <div className="flex items-center justify-between text-xs">
              <span className={cn(
                "flex items-center gap-1",
                creatorInfo.daily_limit_remaining === 0 ? "text-destructive" :
                creatorInfo.daily_limit_remaining <= 3 ? "text-amber-600" : "text-muted-foreground"
              )}>
                <Clock className="w-3 h-3" />
                {t("tiktok.dailyPosts", "Daily posts")}
              </span>
              <span className={cn(
                creatorInfo.daily_limit_remaining === 0 ? "text-destructive" :
                creatorInfo.daily_limit_remaining <= 3 ? "text-amber-600" : "text-muted-foreground"
              )}>
                {creatorInfo.daily_limit_remaining}/{creatorInfo.daily_limit_total}
              </span>
            </div>
            <Progress
              value={(creatorInfo.daily_limit_remaining / creatorInfo.daily_limit_total) * 100}
              className={cn(
                "h-1.5",
                creatorInfo.daily_limit_remaining === 0 ? "[&>div]:bg-destructive" :
                creatorInfo.daily_limit_remaining <= 3 ? "[&>div]:bg-amber-500" : "[&>div]:bg-primary"
              )}
            />
          </div>
        )}

        {/* Privacy Dropdown - TikTok style */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("tiktok.whoCanView", "Who can view this video")}</Label>
          {loadingCreatorInfo ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select value={settings.privacyLevel} onValueChange={handlePrivacyChange}>
              <SelectTrigger className={cn(!settings.privacyLevel && "text-muted-foreground")}>
                <SelectValue placeholder={t("tiktok.selectPrivacy", "Select privacy")} />
              </SelectTrigger>
              <SelectContent>
                {getAvailablePrivacyOptions().map((option) => {
                  const isDisabled = option.value === "SELF_ONLY" && settings.brandedContent;
                  return (
                    <SelectItem key={option.value} value={option.value} disabled={isDisabled}>
                      <span className={cn(isDisabled && "text-muted-foreground")}>{getPrivacyOptionLabel(option.value, option.label)}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
          {!settings.privacyLevel && !loadingCreatorInfo && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {t("tiktok.required", "Required")}
            </p>
          )}
        </div>

        {/* Interaction Toggles - TikTok-style cyan checkboxes */}
        <div className="space-y-3">
          <Label className="text-sm font-medium">{t("tiktok.allowUsersTo", "Allow users to")}</Label>
          
          {settings.privacyLevel === "SELF_ONLY" ? (
            <p className="text-xs text-muted-foreground italic">
              {t("tiktok.notAvailableForPrivate", "Not available for private videos")}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              {/* Comment */}
              <TikTokCheckbox
                checked={settings.allowComment}
                onCheckedChange={(v) => onSettingsChange({ allowComment: v })}
                disabled={creatorInfo?.comment_disabled}
                label={t("tiktok.allowComment", "Comment")}
              />

              {/* Duet - Video only */}
              {hasVideo && (
                <TikTokCheckbox
                  checked={settings.allowDuet}
                  onCheckedChange={(v) => onSettingsChange({ allowDuet: v })}
                  disabled={creatorInfo?.duet_disabled}
                  label={t("tiktok.allowDuet", "Duet")}
                />
              )}

              {/* Stitch - Video only */}
              {hasVideo && (
                <TikTokCheckbox
                  checked={settings.allowStitch}
                  onCheckedChange={(v) => onSettingsChange({ allowStitch: v })}
                  disabled={creatorInfo?.stitch_disabled}
                  label={t("tiktok.allowStitch", "Stitch")}
                />
              )}
            </div>
          )}
        </div>

        {/* Disclose Video Content Toggle - Opens side panel */}
        <div
          className={cn(
            "flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors",
            settings.discloseContent ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"
          )}
          onClick={() => {
            const newValue = !settings.discloseContent;
            onSettingsChange({
              discloseContent: newValue,
              yourBrand: false,
              brandedContent: false,
            });
            setShowDisclosurePanel(newValue);
          }}
        >
          <div className="flex-1">
            <p className="text-sm font-medium">{t("tiktok.discloseContent", "Disclose video content")}</p>
            <p className="text-xs text-muted-foreground">
              {t("tiktok.discloseContentSubtitle", "Let others know this promotes a brand or product")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={settings.discloseContent}
              onCheckedChange={(v) => {
                onSettingsChange({
                  discloseContent: v,
                  yourBrand: false,
                  brandedContent: false,
                });
                setShowDisclosurePanel(v);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {settings.discloseContent && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>

        {/* AI Generated Content Toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg border">
          <div>
            <p className="text-sm font-medium">{t("tiktok.aiGenerated", "AI-generated content")}</p>
            <p className="text-xs text-muted-foreground">
              {t("tiktok.aiGeneratedSubtitle", "Label content made with AI tools")}
            </p>
          </div>
          <Switch
            checked={settings.aiGenerated}
            onCheckedChange={(v) => onSettingsChange({ aiGenerated: v })}
          />
        </div>

        {/* Music Copyright Check */}
        {hasVideo && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium flex items-center gap-1">
                {t("tiktok.musicCopyrightCheck", "Music copyright check")}
                <Info className="w-3 h-3 text-muted-foreground" />
              </Label>
              <Switch
                checked={settings.musicCheck}
                onCheckedChange={(v) => onSettingsChange({ musicCheck: v })}
              />
            </div>
            
            {settings.musicCheck && (
              <div className="pl-4 border-l-2 border-muted">
                {isCheckingMusic ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t("tiktok.musicChecking", "Checking...")}
                  </p>
                ) : musicCopyrightResult?.hasCopyrightedMusic ? (
                  <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs">
                    <p className="text-amber-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {t("tiktok.copyrightedMusicDetected", "Copyrighted music detected")}
                    </p>
                    {musicCopyrightResult.musicInfo && (
                      <p className="text-muted-foreground mt-1">
                        {musicCopyrightResult.musicInfo.title} - {musicCopyrightResult.musicInfo.artist}
                      </p>
                    )}
                  </div>
                ) : musicCopyrightResult ? (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    {t("tiktok.noIssuesFound", "No issues found")}
                  </p>
                ) : canRunMusicCheck ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRunMusicCheck}>
                    {t("tiktok.runCheck", "Run check")}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Music Usage Confirmation - TikTok style */}
        <div className="pt-3 border-t space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id="tiktokConsent"
              checked={settings.consentAgreed}
              onCheckedChange={(v) => onSettingsChange({ consentAgreed: v as boolean })}
              className="mt-0.5"
            />
            <span className="text-sm leading-relaxed">
              {t("tiktok.agreePrefix", "By posting, you agree to TikTok's ")}
              <a
                href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {t("tiktok.musicUsageConfirmation", "Music Usage Confirmation")}
              </a>
              {settings.brandedContent && (
                <>
                  {t("tiktok.and", " and ")}
                  <a
                    href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t("tiktok.brandedContentPolicy", "Branded Content Policy")}
                  </a>
                </>
              )}
              .
            </span>
          </label>
          {!settings.consentAgreed && (
            <p className="text-xs text-destructive pl-6">{t("tiktok.requiredToPost", "Required to post")}</p>
          )}
        </div>

        {/* Preview Button - Opens full preview dialog */}
        <div className="pt-3 space-y-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Button
                    className="w-full bg-[#22D3EE] hover:bg-[#06B6D4] text-white font-semibold h-12 text-base gap-2 disabled:opacity-50"
                    onClick={() => setShowPreviewDialog(true)}
                    disabled={mediaFiles.length === 0 || isPublishDisabled}
                  >
                    <Eye className="w-5 h-5" />
                    {t("tiktok.previewAndUpload", "Preview & Upload")}
                  </Button>
                </div>
              </TooltipTrigger>
              {(mediaFiles.length === 0 || isPublishDisabled) && (
                <TooltipContent>
                  <p>
                    {mediaFiles.length === 0 
                      ? t("tiktok.addMediaToPreview", "Add media to preview")
                      : getPublishDisabledReason()}
                  </p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onSaveDraft}>
              {t("tiktok.saveDraft", "Save draft")}
            </Button>
            <Button variant="ghost" onClick={onDiscard}>
              {t("tiktok.discard", "Discard")}
            </Button>
          </div>
        </div>

        {/* TikTok Preview Dialog */}
        <TikTokPreviewDialog
          open={showPreviewDialog}
          onOpenChange={setShowPreviewDialog}
          mediaFiles={mediaFiles}
          caption={caption || ""}
          title={settings.title}
          onTitleChange={(title) => onSettingsChange({ title })}
          settings={settings}
          onSettingsChange={onSettingsChange}
          creatorInfo={creatorInfo}
          onUpload={onUpload}
          isUploading={isPosting}
          scheduleEnabled={scheduleEnabled}
        />

        {/* Load Draft Banner */}
        {hasDraft && (
          <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-blue-500" />
              <span className="text-sm">{t("tiktok.haveSavedDraft", "You have a saved draft")}</span>
            </div>
            <Button variant="outline" size="sm" onClick={onLoadDraft}>
              {t("tiktok.loadDraft", "Load")}
            </Button>
          </div>
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────────────
          Disclosure Side Panel (Right Side on desktop, Below on mobile)
          With smooth animation transitions
      ───────────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showDisclosurePanel && settings.discloseContent && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="w-full lg:w-[45%] lg:border-l lg:pl-4 pt-4 lg:pt-0 border-t lg:border-t-0 space-y-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <h3 className="font-medium text-sm">{t("tiktok.discloseContent", "Disclose video content")}</h3>
              <p className="text-xs text-muted-foreground mt-1">
                {t("tiktok.discloseContentDesc", "Turn on to disclose that this video promotes goods or services in exchange for something of value.")}
              </p>
            </motion.div>

            {/* Label Preview */}
            <AnimatePresence>
              {getContentLabel() && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className="p-3 bg-primary/10 border border-primary/30 rounded-lg"
                >
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-primary">
                        {t("tiktok.labeledAs", `Your video will be labeled "${getContentLabel()}"`, { label: getContentLabel() })}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("tiktok.cannotBeChanged", "This cannot be changed once your video is posted.")}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Incomplete Selection Warning */}
            <AnimatePresence>
              {isCommercialDisclosureIncomplete && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg overflow-hidden"
                >
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t("tiktok.selectAtLeastOneOption", "Select at least one option below")}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Your Brand Option */}
            <motion.label
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className={cn(
                "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                settings.yourBrand ? "border-primary bg-primary/5" : "hover:bg-muted/30"
              )}
            >
              <Checkbox
                checked={settings.yourBrand}
                onCheckedChange={(v) => onSettingsChange({ yourBrand: v as boolean })}
                className="mt-0.5"
              />
              <div className="flex-1">
                <p className="text-sm font-medium">{t("tiktok.yourBrand", "Your brand")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("tiktok.yourBrandDesc", "You are promoting yourself or your own business. This video will be classified as Brand Organic.")}
                </p>
              </div>
            </motion.label>

            {/* Branded Content Option */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <motion.label
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                      settings.privacyLevel === "SELF_ONLY"
                        ? "opacity-50 cursor-not-allowed"
                        : settings.brandedContent
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/30"
                    )}
                  >
                    <Checkbox
                      checked={settings.brandedContent}
                      onCheckedChange={(v) => handleBrandedContentChange(v as boolean)}
                      disabled={settings.privacyLevel === "SELF_ONLY"}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("tiktok.brandedContent", "Branded content")}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t("tiktok.brandedContentDesc", "You are promoting another brand or a third party. This video will be classified as Branded Content.")}
                      </p>
                      {settings.privacyLevel === "SELF_ONLY" && (
                        <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          {t("tiktok.notAvailableForPrivate", "Not available for private videos")}
                        </p>
                      )}
                    </div>
                  </motion.label>
                </TooltipTrigger>
                {settings.privacyLevel === "SELF_ONLY" && (
                  <TooltipContent>
                    <p>{t("tiktok.brandedContentCannotBePrivate", "Branded content cannot be private")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>

            {/* Info Link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.25 }}
              className="pt-2"
            >
              <a
                href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                {t("tiktok.learnMoreContentDisclosure", "Learn more about content disclosure")}
                <ExternalLink className="w-3 h-3" />
              </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
