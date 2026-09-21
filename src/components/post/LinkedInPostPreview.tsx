import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ThumbsUp, MessageSquare, Repeat2, Send, MoreHorizontal, Globe, X } from "lucide-react";

interface LinkedInPostPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
  headline?: string;
  visibility?: "public" | "connections" | "logged_in";
}

export function LinkedInPostPreview({
  caption,
  mediaFile,
  username,
  avatarUrl,
  headline,
  visibility = "public",
}: LinkedInPostPreviewProps) {
  const { t } = useTranslation("postpreview");
  const displayUsername = username || t("linkedIn.defaultUsername", "Your Name");
  const displayHeadline = headline || t("linkedIn.defaultHeadline", "Professional Title");

  // Truncate caption for preview with "see more" behavior
  const truncatedCaption = caption.length > 200 ? caption.slice(0, 197) + "..." : caption;

  const visibilityIcon = visibility === "public" ? (
    <Globe className="w-3 h-3" />
  ) : (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm0 12c-2.2 0-4.2-1.1-5.3-2.8.1-1.8 3.5-2.7 5.3-2.7s5.2.9 5.3 2.7C12.2 12.9 10.2 14 8 14z"/>
    </svg>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[#0A66C2] rounded flex items-center justify-center">
            <span className="text-white text-xs font-bold">in</span>
          </div>
          <span className="text-sm font-medium">{t("linkedIn.previewTitle", "Feed Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-[#0A66C2]/10 text-[#0A66C2] dark:bg-[#0A66C2]/20">
          {t("linkedIn.postBadge", "Post")}
        </Badge>
      </div>

      {/* LinkedIn Card */}
      <div className="max-w-lg mx-auto bg-background border rounded-lg overflow-hidden shadow-sm">
        {/* Post Header */}
        <div className="p-4">
          <div className="flex items-start gap-3">
            <Avatar className="h-12 w-12">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayUsername} /> : null}
              <AvatarFallback className="bg-[#0A66C2] text-white">
                {displayUsername[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="font-semibold text-sm hover:text-[#0A66C2] hover:underline cursor-pointer">
                  {displayUsername}
                </span>
                <span className="text-muted-foreground text-sm">{t("linkedIn.firstConnection", "• 1st")}</span>
              </div>
              <p className="text-xs text-muted-foreground truncate">{displayHeadline}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>{t("linkedIn.now", "now")}</span>
                <span>•</span>
                {visibilityIcon}
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <MoreHorizontal className="w-5 h-5 text-muted-foreground hover:text-foreground cursor-pointer" />
              <X className="w-5 h-5 text-muted-foreground hover:text-foreground cursor-pointer" />
            </div>
          </div>
        </div>

        {/* Post Content */}
        <div className="px-4 pb-3">
          {truncatedCaption && (
            <p className="text-sm whitespace-pre-wrap break-words">
              {truncatedCaption}
              {caption.length > 200 && (
                <span className="text-muted-foreground hover:text-[#0A66C2] hover:underline cursor-pointer ms-1">
                  {t("linkedIn.seeMore", "...see more")}
                </span>
              )}
            </p>
          )}
        </div>

        {/* Media */}
        {mediaFile && (
          <div className="relative">
            {mediaFile.fileType === "video" ? (
              <video
                src={mediaFile.previewUrl}
                className="w-full max-h-96 object-cover"
                muted
                loop
                autoPlay
                playsInline
              />
            ) : (
              <img
                src={mediaFile.previewUrl}
                alt=""
                className="w-full max-h-96 object-cover"
              />
            )}
          </div>
        )}

        {/* Engagement Stats */}
        <div className="px-4 py-2 border-t flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="flex -space-x-1 rtl:space-x-reverse">
              <div className="w-4 h-4 rounded-full bg-[#0A66C2] flex items-center justify-center">
                <ThumbsUp className="w-2.5 h-2.5 text-white" fill="white" />
              </div>
              <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
                <span className="text-[8px]">❤️</span>
              </div>
              <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
                <span className="text-[8px]">👏</span>
              </div>
            </div>
            <span className="ms-1">0</span>
          </div>
          <div className="flex items-center gap-3">
            <span>{t("linkedIn.commentsCount", "0 comments")}</span>
            <span>{t("linkedIn.repostsCount", "0 reposts")}</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-2 py-1 border-t flex items-center justify-around">
          <button className="flex-1 flex items-center justify-center gap-2 py-3 hover:bg-muted rounded-lg transition-colors">
            <ThumbsUp className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground font-medium">{t("linkedIn.like", "Like")}</span>
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 py-3 hover:bg-muted rounded-lg transition-colors">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground font-medium">{t("linkedIn.comment", "Comment")}</span>
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 py-3 hover:bg-muted rounded-lg transition-colors">
            <Repeat2 className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground font-medium">{t("linkedIn.repost", "Repost")}</span>
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 py-3 hover:bg-muted rounded-lg transition-colors">
            <Send className="w-5 h-5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground font-medium">{t("linkedIn.send", "Send")}</span>
          </button>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {caption.length > 0
          ? t("linkedIn.charCount", "{{count}} characters", { count: caption.length })
          : t("linkedIn.emptyHint", "Add content to see how your post will appear")}
      </p>
    </div>
  );
}
