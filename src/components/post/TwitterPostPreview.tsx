import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageCircle, Repeat2, Share, MoreHorizontal, Bookmark, BarChart2 } from "lucide-react";

interface TwitterPostPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
  displayName?: string;
  isVerified?: boolean;
}

export function TwitterPostPreview({
  caption,
  mediaFile,
  username = "your_handle",
  avatarUrl,
  displayName,
  isVerified = false,
}: TwitterPostPreviewProps) {
  const { t } = useTranslation("postpreview");
  const name = displayName || username;
  
  // Truncate caption for preview (Twitter shows full tweet but we want to fit in preview)
  const truncatedCaption = caption.length > 280 ? caption.slice(0, 277) + "..." : caption;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-black dark:bg-white rounded flex items-center justify-center">
            <span className="text-white dark:text-black text-xs font-bold">𝕏</span>
          </div>
          <span className="text-sm font-medium">{t("twitter.previewTitle", "Post Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-black/5 dark:bg-white/10 text-foreground">
          {t("twitter.postBadge", "Post")}
        </Badge>
      </div>

      {/* Tweet Card */}
      <div className="max-w-md mx-auto bg-background border rounded-xl overflow-hidden">
        {/* Tweet content */}
        <div className="p-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <Avatar className="h-10 w-10">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="bg-blue-500 text-white">
                {name[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            
            <div className="flex-1 min-w-0">
              {/* Name and handle */}
              <div className="flex items-center gap-1">
                <span className="font-bold text-sm truncate">{name}</span>
                {isVerified && (
                  <svg className="w-4 h-4 text-blue-500" viewBox="0 0 22 22" fill="currentColor">
                    <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
                  </svg>
                )}
                <span className="text-muted-foreground text-sm">@{username}</span>
                <span className="text-muted-foreground text-sm">·</span>
                <span className="text-muted-foreground text-sm">{t("twitter.now", "now")}</span>
              </div>
            </div>
            
            <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
          </div>

          {/* Tweet text */}
          {truncatedCaption && (
            <p className="mt-3 text-sm whitespace-pre-wrap break-words">{truncatedCaption}</p>
          )}

          {/* Media */}
          {mediaFile && (
            <div className="mt-3 rounded-xl overflow-hidden border">
              {mediaFile.fileType === "video" ? (
                <video
                  src={mediaFile.previewUrl}
                  className="w-full max-h-80 object-cover"
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={mediaFile.previewUrl}
                  alt=""
                  className="w-full max-h-80 object-cover"
                />
              )}
            </div>
          )}

          {/* Engagement stats */}
          <div className="flex items-center justify-between mt-4 text-muted-foreground">
            <div className="flex items-center gap-1 hover:text-blue-500 cursor-pointer transition-colors">
              <MessageCircle className="w-4 h-4" />
              <span className="text-xs">0</span>
            </div>
            <div className="flex items-center gap-1 hover:text-green-500 cursor-pointer transition-colors">
              <Repeat2 className="w-4 h-4" />
              <span className="text-xs">0</span>
            </div>
            <div className="flex items-center gap-1 hover:text-pink-500 cursor-pointer transition-colors">
              <Heart className="w-4 h-4" />
              <span className="text-xs">0</span>
            </div>
            <div className="flex items-center gap-1 hover:text-blue-500 cursor-pointer transition-colors">
              <BarChart2 className="w-4 h-4" />
              <span className="text-xs">0</span>
            </div>
            <div className="flex items-center gap-2">
              <Bookmark className="w-4 h-4 hover:text-blue-500 cursor-pointer transition-colors" />
              <Share className="w-4 h-4 hover:text-blue-500 cursor-pointer transition-colors" />
            </div>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {caption.length > 280 
          ? t("twitter.threadWarning", "{{count}} characters - will be posted as a thread or long tweet", { count: caption.length })
          : t("twitter.charCount", "{{count}}/280 characters", { count: caption.length })
        }
      </p>
    </div>
  );
}