import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { 
  ArrowBigUp, 
  ArrowBigDown, 
  MessageSquare, 
  Share, 
  Bookmark, 
  MoreHorizontal,
  Gift,
  Eye,
  EyeOff
} from "lucide-react";

interface RedditPostPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  title?: string;
  subreddit?: string;
  username?: string;
  avatarUrl?: string;
  postType?: "text" | "image" | "video" | "link";
  linkUrl?: string;
  spoiler?: boolean;
  nsfw?: boolean;
}

export function RedditPostPreview({
  caption,
  mediaFile,
  title,
  subreddit = "subreddit",
  username = "your_username",
  avatarUrl,
  postType = "text",
  linkUrl,
  spoiler = false,
  nsfw = false,
}: RedditPostPreviewProps) {
  const { t } = useTranslation("postpreview");
  const defaultTitle = t("reddit.defaultTitle", "Your post title");
  const displayTitle = title || caption.slice(0, 100) || defaultTitle;
  const truncatedBody = caption.length > 300 ? caption.slice(0, 297) + "..." : caption;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[#FF4500] rounded-full flex items-center justify-center">
            <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
              <circle cx="10" cy="10" r="10" />
              <ellipse cx="10" cy="11" rx="6" ry="4" fill="#FF4500" />
              <circle cx="6.5" cy="9.5" r="1.5" fill="white" />
              <circle cx="13.5" cy="9.5" r="1.5" fill="white" />
              <circle cx="6.5" cy="9.5" r="0.5" fill="#FF4500" />
              <circle cx="13.5" cy="9.5" r="0.5" fill="#FF4500" />
              <ellipse cx="10" cy="5" rx="3" ry="2" fill="white" />
              <line x1="10" y1="3" x2="13" y2="1" stroke="white" strokeWidth="1.5" />
              <circle cx="13" cy="1" r="1" fill="#FF4500" />
            </svg>
          </div>
          <span className="text-sm font-medium">{t("reddit.previewTitle", "Feed Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-[#FF4500]/10 text-[#FF4500] dark:bg-[#FF4500]/20">
          {t("reddit.postBadge", "Post")}
        </Badge>
      </div>

      {/* Reddit Post Card */}
      <div className="max-w-2xl mx-auto bg-background border rounded-lg overflow-hidden hover:border-muted-foreground/50 transition-colors">
        <div className="flex">
          {/* Vote Column */}
          <div className="w-10 bg-muted/30 flex flex-col items-center py-2 gap-1 flex-shrink-0">
            <button className="p-1 hover:bg-muted rounded transition-colors group">
              <ArrowBigUp className="w-5 h-5 text-muted-foreground group-hover:text-[#FF4500]" />
            </button>
            <span className="text-xs font-bold text-foreground">0</span>
            <button className="p-1 hover:bg-muted rounded transition-colors group">
              <ArrowBigDown className="w-5 h-5 text-muted-foreground group-hover:text-[#7193FF]" />
            </button>
          </div>

          {/* Content Column */}
          <div className="flex-1 p-2">
            {/* Post header */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-5 h-5 rounded-full bg-[#FF4500] flex items-center justify-center">
                  <span className="text-white text-[8px] font-bold">r/</span>
                </div>
                <span className="font-bold text-foreground hover:underline cursor-pointer">
                  r/{subreddit}
                </span>
              </div>
              <span>•</span>
              <span>{t("reddit.postedBy", "Posted by")}</span>
              <div className="flex items-center gap-1">
                <Avatar className="h-4 w-4">
                  {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
                  <AvatarFallback className="text-[8px] bg-muted">
                    {username[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="hover:underline cursor-pointer">u/{username}</span>
              </div>
              <span>•</span>
              <span>{t("reddit.justNow", "just now")}</span>
            </div>

            {/* Flairs/Tags */}
            <div className="flex items-center gap-2 mb-2">
              {nsfw && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-bold">
                  {t("reddit.nsfw", "NSFW")}
                </Badge>
              )}
              {spoiler && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-bold bg-muted-foreground/20">
                  <EyeOff className="w-2.5 h-2.5 mr-0.5" />
                  {t("reddit.spoiler", "SPOILER")}
                </Badge>
              )}
            </div>

            {/* Title */}
            <h3 className="text-lg font-medium mb-2 leading-snug hover:text-[#FF4500] cursor-pointer">
              {displayTitle}
            </h3>

            {/* Content based on post type */}
            {postType === "text" && truncatedBody && !mediaFile && (
              <div className="relative">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap mb-3 line-clamp-4">
                  {spoiler ? (
                    <span className="bg-foreground text-foreground hover:bg-transparent hover:text-muted-foreground transition-colors cursor-pointer">
                      {truncatedBody}
                    </span>
                  ) : (
                    truncatedBody
                  )}
                </p>
                {caption.length > 300 && (
                  <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent" />
                )}
              </div>
            )}

            {/* Media */}
            {mediaFile && (
              <div className={`relative rounded-md overflow-hidden mb-3 max-h-96 ${spoiler ? 'blur-xl hover:blur-none transition-all cursor-pointer' : ''}`}>
                {mediaFile.fileType === "video" ? (
                  <video
                    src={mediaFile.previewUrl}
                    className="w-full max-h-96 object-contain bg-black"
                    muted
                    loop
                    autoPlay
                    playsInline
                    controls
                  />
                ) : (
                  <img
                    src={mediaFile.previewUrl}
                    alt=""
                    className="w-full max-h-96 object-contain"
                  />
                )}
              </div>
            )}

            {/* Link preview */}
            {postType === "link" && linkUrl && (
              <a 
                href="#" 
                className="flex items-center gap-2 text-xs text-[#4fbcff] hover:underline mb-3"
              >
                <span className="truncate max-w-xs">{linkUrl}</span>
                <Share className="w-3 h-3 flex-shrink-0" />
              </a>
            )}

            {/* Action bar */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <button className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-sm transition-colors">
                <MessageSquare className="w-4 h-4" />
                <span className="font-bold">{t("reddit.commentsCount", "0 Comments")}</span>
              </button>
              <button className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-sm transition-colors">
                <Gift className="w-4 h-4" />
                <span className="font-bold">{t("reddit.award", "Award")}</span>
              </button>
              <button className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-sm transition-colors">
                <Share className="w-4 h-4" />
                <span className="font-bold">{t("reddit.share", "Share")}</span>
              </button>
              <button className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-sm transition-colors">
                <Bookmark className="w-4 h-4" />
                <span className="font-bold">{t("reddit.save", "Save")}</span>
              </button>
              <button className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted rounded-sm transition-colors">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {title ? t("reddit.postingTo", "Posting to r/{{subreddit}}", { subreddit }) : t("reddit.emptyHint", "Add a title to preview your Reddit post")}
      </p>
    </div>
  );
}
