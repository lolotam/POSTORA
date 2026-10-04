import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageCircle, Repeat2, MoreHorizontal, ExternalLink, AlertTriangle, Lock, Share, Users, List } from "lucide-react";

interface MediaFile {
  previewUrl: string;
  fileType: "image" | "video" | "gif";
}

interface BlueskyReplySettings {
  selectedOption: "anyone" | "nobody" | "following" | "mentioned" | "list";
  selectedListUri: string | null;
}

interface BlueskyPostPreviewProps {
  caption: string;
  mediaFile?: MediaFile;
  mediaFiles?: MediaFile[];
  username?: string;
  avatarUrl?: string;
  displayName?: string;
  embedLink?: string;
  embedEnabled?: boolean;
  contentWarning?: string;
  adultContent?: boolean;
  replyControl?: "everyone" | "following" | "mentions" | "none";
  replySettings?: BlueskyReplySettings;
}

export function BlueskyPostPreview({
  caption,
  mediaFile,
  mediaFiles = [],
  username = "your.handle",
  avatarUrl,
  displayName,
  embedLink,
  embedEnabled = false,
  contentWarning,
  adultContent,
  replyControl = "everyone",
  replySettings,
}: BlueskyPostPreviewProps) {
  const { t } = useTranslation("postpreview");

  // Combine single mediaFile with mediaFiles array
  const allMedia = mediaFile ? [mediaFile, ...mediaFiles] : mediaFiles;
  
  // Truncate caption for preview
  const truncatedCaption = caption.length > 300 ? caption.slice(0, 297) + "..." : caption;
  const handle = username.includes(".") ? username : `${username}.bsky.social`;

  // Extract domain from embed link for preview
  const embedDomain = embedLink ? (() => {
    try {
      return new URL(embedLink).hostname.replace("www.", "");
    } catch {
      return embedLink;
    }
  })() : null;

  // Check if there's a content label
  const hasContentLabel = contentWarning || adultContent;

  const images = allMedia.filter(m => m.fileType === "image" || m.fileType === "gif").slice(0, 4);
  const video = allMedia.find(m => m.fileType === "video");

  // Format current time like Bluesky
  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const dateString = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Get reply control label - prioritize new replySettings over legacy replyControl
  const getReplyLabel = () => {
    if (replySettings) {
      switch (replySettings.selectedOption) {
        case "nobody": return t("bluesky.repliesDisabled", "Replies disabled");
        case "following": return t("bluesky.followingCanReply", "Following can reply");
        case "mentioned": return t("bluesky.mentionedOnly", "Mentioned only");
        case "list": return t("bluesky.listMembersCanReply", "List members can reply");
        default: return t("bluesky.everybodyCanReply", "Everybody can reply");
      }
    }
    // Legacy fallback
    switch (replyControl) {
      case "none": return t("bluesky.repliesDisabled", "Replies disabled");
      case "following": return t("bluesky.followingCanReply", "Following can reply");
      case "mentions": return t("bluesky.mentionedOnly", "Mentioned only");
      default: return t("bluesky.everybodyCanReply", "Everybody can reply");
    }
  };

  // Determine if reply is restricted (for badge display)
  const isReplyRestricted = replySettings 
    ? replySettings.selectedOption !== "anyone"
    : replyControl !== "everyone";

  // Get icon for reply control
  const getReplyIcon = () => {
    if (replySettings) {
      switch (replySettings.selectedOption) {
        case "nobody": return <Lock className="w-3 h-3" />;
        case "list": return <List className="w-3 h-3" />;
        case "following":
        case "mentioned": return <Users className="w-3 h-3" />;
        default: return null;
      }
    }
    return replyControl !== "everyone" ? <Lock className="w-3 h-3" /> : null;
  };

  // Render 2x2 image grid like Bluesky's native layout
  const renderImageGrid = () => {
    if (images.length === 0) return null;

    if (images.length === 1) {
      return (
        <div className="rounded-lg overflow-hidden border border-border mt-3">
          <img
            src={images[0].previewUrl}
            alt=""
            className="w-full max-h-80 object-cover"
          />
        </div>
      );
    }

    if (images.length === 2) {
      return (
        <div className="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden border border-border mt-3">
          {images.map((img, idx) => (
            <img
              key={idx}
              src={img.previewUrl}
              alt=""
              className="w-full aspect-square object-cover"
            />
          ))}
        </div>
      );
    }

    if (images.length === 3) {
      return (
        <div className="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden border border-border mt-3">
          <img
            src={images[0].previewUrl}
            alt=""
            className="w-full row-span-2 h-full object-cover"
            style={{ gridRow: 'span 2' }}
          />
          <img
            src={images[1].previewUrl}
            alt=""
            className="w-full aspect-square object-cover"
          />
          <img
            src={images[2].previewUrl}
            alt=""
            className="w-full aspect-square object-cover"
          />
        </div>
      );
    }

    // 4 images - 2x2 grid like reference
    return (
      <div className="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden border border-border mt-3">
        {images.map((img, idx) => (
          <img
            key={idx}
            src={img.previewUrl}
            alt=""
            className="w-full aspect-square object-cover"
          />
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center overflow-hidden">
            <svg viewBox="0 0 568 501" className="w-4 h-4" fill="currentColor">
              <path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 203.659 552.222 224.501C531.947 296.954 458.067 315.434 392.347 304.249C507.222 323.8 536.444 388.56 473.333 453.32C353.473 576.312 301.061 422.461 287.631 383.039C285.169 373.514 284.017 369.044 284 368.769C283.983 369.044 282.831 373.514 280.369 383.039C266.939 422.461 214.527 576.312 94.6667 453.32C31.5556 388.56 60.7778 323.8 175.653 304.249C109.933 315.434 36.0533 296.954 15.7778 224.501C9.94533 203.659 0 75.2916 0 57.9464C0 -28.9064 76.1333 -1.61183 123.121 33.6637Z" />
            </svg>
          </div>
          <span className="text-sm font-medium">{t("bluesky.previewTitle", "Bluesky Preview")}</span>
        </div>
        <div className="flex items-center gap-2">
          {isReplyRestricted && (
            <Badge variant="outline" className="text-xs gap-1">
              {getReplyIcon()}
              {getReplyLabel()}
            </Badge>
          )}
          <Badge variant="secondary" className="text-xs bg-muted text-foreground dark:bg-muted dark:text-foreground">
            {t("bluesky.postBadge", "Post")}
          </Badge>
        </div>
      </div>

      {/* Content Warning Banner */}
      {hasContentLabel && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="text-xs font-medium">
            {adultContent && t("bluesky.adultContent", "Adult content")}
            {adultContent && contentWarning && " • "}
            {contentWarning}
          </span>
        </div>
      )}

      {/* Bluesky Post Card - Native Style */}
      <div className="max-w-lg mx-auto bg-background border rounded-xl overflow-hidden">
        {/* Back Header */}
        <div className="flex items-center gap-3 p-3 border-b">
          <span className="text-sm font-medium">{t("bluesky.backPost", "← Post")}</span>
          <div className="ms-auto">
            <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>

        <div className="p-4">
          {/* User Info */}
          <div className="flex items-start gap-3">
            <Avatar className="h-11 w-11">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="text-white font-medium bg-neutral-900 dark:bg-neutral-800">
                {(displayName || username)[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0">
              <div className="flex flex-col">
                <span className="font-semibold text-sm hover:underline cursor-pointer">
                  {displayName || username}
                </span>
                <span className="text-muted-foreground text-sm">
                  @{handle}
                </span>
              </div>
            </div>
          </div>

          {/* Post Content */}
          <div className="mt-3">
            {truncatedCaption && (
              <p className="text-[15px] whitespace-pre-wrap break-words leading-relaxed">
                {truncatedCaption}
                {caption.length > 300 && (
                  <span className="text-foreground hover:underline cursor-pointer ms-1">
                    {t("bluesky.showMore", "Show more")}
                  </span>
                )}
              </p>
            )}

            {/* Video Preview */}
            {video && (
              <div className="relative rounded-lg overflow-hidden mt-3 border border-border">
                <video
                  src={video.previewUrl}
                  className="w-full max-h-80 object-cover"
                  muted
                  loop
                  autoPlay
                  playsInline
                  controls
                />
                <Badge className="absolute top-2 end-2 bg-black/70 text-white text-xs">
                  {t("bluesky.videoBadge", "Video")}
                </Badge>
              </div>
            )}

            {/* Image Grid - 2x2 like native Bluesky */}
            {!video && renderImageGrid()}

            {/* Embed Link Preview */}
            {embedEnabled && embedLink && embedDomain && !video && images.length === 0 && (
              <div className="mt-3 border rounded-lg overflow-hidden hover:bg-muted/50 transition-colors cursor-pointer">
                <div className="aspect-video bg-muted flex items-center justify-center">
                  <ExternalLink className="w-8 h-8 text-muted-foreground" />
                </div>
                <div className="p-3 border-t">
                  <p className="text-xs text-muted-foreground mb-1">{embedDomain}</p>
                  <p className="text-sm font-medium line-clamp-2">{t("bluesky.linkPreview", "Link Preview")}</p>
                </div>
              </div>
            )}

            {/* Timestamp and Reply Control */}
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <span>{timeString} · {dateString}</span>
              <span>·</span>
              <span className="text-foreground flex items-center gap-1">
                ⊙ {getReplyLabel()}
                <span className="text-muted-foreground">▾</span>
              </span>
            </div>

            {/* Engagement Actions */}
            <div className="flex items-center justify-between mt-4 pt-3 border-t text-muted-foreground">
              <button className="flex items-center gap-1.5 hover:text-foreground transition-colors group">
                <MessageCircle className="w-5 h-5" />
              </button>
              
              <button className="flex items-center gap-1.5 hover:text-green-500 transition-colors group">
                <Repeat2 className="w-5 h-5" />
              </button>
              
              <button className="flex items-center gap-1.5 hover:text-foreground transition-colors group">
                <Heart className="w-5 h-5" />
              </button>
              
              <button className="flex items-center gap-1.5 hover:text-foreground transition-colors group">
                <Share className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {caption.length > 0
          ? t("bluesky.charCount", "{{count}}/300 characters", { count: caption.length })
          : t("bluesky.emptyHint", "Add content to see how your post will appear on Bluesky")}
        {images.length > 0 && ` • ${t("bluesky.imageCount", "{{count}}/4 images", { count: images.length })}`}
        {video && ` • ${t("bluesky.videoCount", "1 video")}`}
      </p>
    </div>
  );
}
