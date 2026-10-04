// ═══════════════════════════════════════════════════════════════════════════
// TikTok Post Preview Component
// Shows preview of content before posting (Section 5a compliance)
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { 
  Eye,
  Users,
  Lock,
  MessageCircle,
  Music,
  Repeat2,
  Scissors,
  Sparkles,
  Tag,
  Play,
  Image as ImageIcon,
} from "lucide-react";
import type { TikTokCreatorInfo } from "./settings/TikTokSettings";

interface TikTokPostPreviewProps {
  mediaFiles: Array<{
    previewUrl?: string;
    fileType: "image" | "video" | "gif";
  }>;
  caption: string;
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  discloseContent: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
  creatorInfo: TikTokCreatorInfo | null;
  className?: string;
}

export function TikTokPostPreview({
  mediaFiles,
  caption,
  privacyLevel,
  allowComment,
  allowDuet,
  allowStitch,
  discloseContent,
  yourBrand,
  brandedContent,
  aiGenerated,
  creatorInfo,
  className,
}: TikTokPostPreviewProps) {
  const { t } = useTranslation("postpreview");
  const isVideo = mediaFiles.some(f => f.fileType === "video");
  const previewMedia = mediaFiles[0];
  
  const privacyInfo = useMemo(() => {
    switch (privacyLevel) {
      case "PUBLIC_TO_EVERYONE":
        return { label: t("tikTokPost.privacyEveryone", "Everyone"), icon: Users, color: "text-green-500" };
      case "MUTUAL_FOLLOW_FRIENDS":
        return { label: t("tikTokPost.privacyFriends", "Friends"), icon: Users, color: "text-blue-500" };
      case "SELF_ONLY":
        return { label: t("tikTokPost.privacyOnlyMe", "Only me"), icon: Lock, color: "text-amber-500" };
      case "FOLLOWER_OF_CREATOR":
        return { label: t("tikTokPost.privacyFollowers", "Followers"), icon: Eye, color: "text-purple-500" };
      default:
        return { label: t("tikTokPost.selectPrivacy", "Select privacy"), icon: Eye, color: "text-muted-foreground" };
    }
  }, [privacyLevel, t]);

  const getContentLabel = () => {
    if (brandedContent) return t("tikTokPost.paidPartnership", "Paid partnership");
    if (yourBrand) return t("tikTokPost.promotionalContent", "Promotional content");
    return null;
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Preview Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Eye className="w-4 h-4" />
          {t("tikTokPost.previewTitle", "TikTok Preview")}
        </h4>
        {isVideo ? (
          <Badge variant="secondary" className="text-xs">
            <Play className="w-3 h-3 me-1" />
            {t("tikTokPost.videoBadge", "Video")}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">
            <ImageIcon className="w-3 h-3 me-1" />
            {t("tikTokPost.photoBadge", "Photo")}
          </Badge>
        )}
      </div>

      {/* Phone Frame Preview */}
      <div className="relative bg-black rounded-2xl overflow-hidden aspect-[9/16] max-h-[320px] mx-auto border-4 border-gray-800">
        {/* Media Preview */}
        {previewMedia ? (
          isVideo ? (
            <video
              src={previewMedia.previewUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
            />
          ) : (
            <img
              src={previewMedia.previewUrl}
              alt={t("tikTokPost.previewAlt", "Preview")}
              className="w-full h-full object-cover"
            />
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted/20">
            <p className="text-muted-foreground text-sm">{t("tikTokPost.noMedia", "No media selected")}</p>
          </div>
        )}

        {/* Overlay Content */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />

        {/* Content Labels */}
        <div className="absolute top-3 start-3 end-3 flex flex-wrap gap-1.5">
          {aiGenerated && (
            <Badge variant="secondary" className="text-[10px] bg-black/50">
              <Sparkles className="w-2.5 h-2.5 me-1" />
              {t("tikTokPost.aiGenerated", "AI-generated")}
            </Badge>
          )}
          {getContentLabel() && (
            <Badge variant="secondary" className="text-[10px] bg-black/50">
              <Tag className="w-2.5 h-2.5 me-1" />
              {getContentLabel()}
            </Badge>
          )}
        </div>

        {/* Creator Info & Caption */}
        <div className="absolute bottom-3 start-3 end-10 space-y-1.5">
          {/* Username */}
          <p className="text-white text-xs font-bold">
            @{creatorInfo?.creator_username || creatorInfo?.creator_nickname || "username"}
          </p>
          
          {/* Caption Preview */}
          <p className="text-white text-[11px] line-clamp-2 opacity-90">
            {caption || t("tikTokPost.captionPlaceholder", "Your caption will appear here...")}
          </p>

          {/* Music/Sound indicator */}
          <div className="flex items-center gap-1 text-white/70">
            <Music className="w-3 h-3" />
            <span className="text-[10px]">{t("tikTokPost.originalSound", "Original sound")}</span>
          </div>
        </div>

        {/* Right Side Interaction Icons */}
        <div className="absolute end-2 bottom-16 flex flex-col items-center gap-3">
          {/* Avatar */}
          {creatorInfo?.creator_avatar_url ? (
            <img 
              src={creatorInfo.creator_avatar_url} 
              alt="" 
              className="w-8 h-8 rounded-full border-2 border-white"
            />
          ) : (
            <div className="w-8 h-8 rounded-full border-2 border-white bg-black" />
          )}
          
          {/* Interaction Toggles */}
          <div className="flex flex-col items-center gap-2">
            <div className={cn(
              "flex flex-col items-center",
              !allowComment && "opacity-40"
            )}>
              <MessageCircle className="w-5 h-5 text-white" />
              <span className="text-[9px] text-white">
                {allowComment ? t("tikTokPost.on", "On") : t("tikTokPost.off", "Off")}
              </span>
            </div>
            
            {isVideo && (
              <>
                <div className={cn(
                  "flex flex-col items-center",
                  !allowDuet && "opacity-40"
                )}>
                  <Repeat2 className="w-5 h-5 text-white" />
                  <span className="text-[9px] text-white">
                    {allowDuet ? t("tikTokPost.duet", "Duet") : t("tikTokPost.off", "Off")}
                  </span>
                </div>
                
                <div className={cn(
                  "flex flex-col items-center",
                  !allowStitch && "opacity-40"
                )}>
                  <Scissors className="w-5 h-5 text-white" />
                  <span className="text-[9px] text-white">
                    {allowStitch ? t("tikTokPost.stitch", "Stitch") : t("tikTokPost.off", "Off")}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Settings Summary */}
      <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t("tikTokPost.privacyLabel", "Privacy:")}</span>
          <span className={cn("flex items-center gap-1 font-medium", privacyInfo.color)}>
            <privacyInfo.icon className="w-3 h-3" />
            {privacyInfo.label}
          </span>
        </div>
        
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t("tikTokPost.commentsLabel", "Comments:")}</span>
          <span className={allowComment ? "text-green-500" : "text-muted-foreground"}>
            {allowComment ? t("tikTokPost.enabled", "Enabled") : t("tikTokPost.disabled", "Disabled")}
          </span>
        </div>
        
        {isVideo && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("tikTokPost.duetLabel", "Duet:")}</span>
              <span className={allowDuet ? "text-green-500" : "text-muted-foreground"}>
                {allowDuet ? t("tikTokPost.enabled", "Enabled") : t("tikTokPost.disabled", "Disabled")}
              </span>
            </div>
            
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t("tikTokPost.stitchLabel", "Stitch:")}</span>
              <span className={allowStitch ? "text-green-500" : "text-muted-foreground"}>
                {allowStitch ? t("tikTokPost.enabled", "Enabled") : t("tikTokPost.disabled", "Disabled")}
              </span>
            </div>
          </>
        )}
        
        {(yourBrand || brandedContent) && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("tikTokPost.disclosureLabel", "Disclosure:")}</span>
            <span className="text-primary font-medium">{getContentLabel()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
