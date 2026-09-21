import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageCircle, Repeat2, Send, MoreHorizontal, Verified, MapPin, Hash } from "lucide-react";

interface ThreadsPostPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
  replyControl?: "everyone" | "followers" | "following" | "mentioned";
  topicTag?: string;
  locationName?: string;
}

export function ThreadsPostPreview({
  caption,
  mediaFile,
  username = "your_account",
  avatarUrl,
  replyControl = "everyone",
  topicTag = "",
  locationName = "",
}: ThreadsPostPreviewProps) {
  const { t } = useTranslation("postpreview");
  // Truncate caption for preview
  const truncatedCaption = caption.length > 200 ? caption.slice(0, 197) + "..." : caption;

  const replyText = {
    everyone: t("threads.anyoneCanReply", "Anyone can reply"),
    followers: t("threads.followersCanReply", "Followers can reply"),
    mentioned: t("threads.mentionedOnly", "Mentioned only"),
  }[replyControl] || t("threads.anyoneCanReply", "Anyone can reply");

  // Sanitize topic tag the same way the settings input + backend do
  const cleanedTopicTag = (topicTag || "").replace(/[.&]/g, "").slice(0, 50).trim();
  const trimmedLocation = (locationName || "").trim();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center overflow-hidden">
            <svg viewBox="0 0 192 192" className="w-5 h-5">
              <path
                fill="currentColor"
                d="M141.537 88.9883C140.71 88.5919 139.87 88.2104 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.7443C82.2364 44.7443 69.7731 51.1409 62.102 62.7807L75.881 72.2328C81.6116 63.5383 90.6052 61.6848 97.2286 61.6848C97.3093 61.6848 97.3907 61.6848 97.4715 61.6855C105.098 61.7373 110.882 64.185 114.762 69.0086C117.628 72.5393 119.624 77.3786 120.742 83.4692C114.44 82.3848 107.603 81.9056 100.291 82.0542C79.5348 82.5043 66.2497 93.0649 67.0571 108.125C67.4687 115.792 71.214 122.465 77.5657 127.03C83.0285 130.916 90.1268 132.973 97.5619 132.58C107.309 132.057 115.035 128.171 120.614 121.026C124.855 115.591 127.633 108.532 129.075 99.6413C134.21 102.598 138.067 106.563 140.357 111.397C144.222 119.508 144.512 133.022 135.198 142.337C127.005 150.53 117.017 154.173 102.182 154.29C85.5836 154.151 72.8438 149.065 64.3065 139.16C56.2333 129.775 52.0019 116.512 51.8076 99.9986C52.0019 83.4862 56.2333 70.2235 64.3065 60.8389C72.8438 50.9339 85.5842 45.8481 102.182 45.7091C118.894 45.8488 131.847 50.9765 140.652 61.0247C144.952 65.9357 148.272 71.9953 150.531 79.0433L166.596 74.3765C163.712 65.0174 159.39 56.8006 153.638 49.7892C141.91 35.4716 124.944 28 102.182 28H102.175C79.5352 28.0014 62.7422 35.4985 51.2078 49.9536C41.5548 61.9681 36.2255 78.4685 36.0008 99.9707V100.027C36.2255 121.53 41.5548 138.031 51.2078 150.045C62.7422 164.5 79.5352 171.998 102.175 172H102.182C121.299 171.865 136.012 166.269 147.655 154.625C163.027 139.253 162.366 119.342 156.669 107.125C152.511 98.4098 145.103 91.6219 135.377 87.1006L141.537 88.9883ZM99.0001 115.662C89.3879 116.189 83.8247 111.333 83.4785 105.162C83.0419 97.2629 90.2374 92.4902 100.607 92.1964C102.296 92.1515 103.942 92.1363 105.547 92.1504C110.509 92.1979 115.173 92.6339 119.493 93.4332C117.474 112.096 109.125 115.109 99.0001 115.662Z"
              />
            </svg>
          </div>
          <span className="text-sm font-medium">{t("threads.previewTitle", "Thread Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-foreground/10 text-foreground">
          {t("threads.threadBadge", "Thread")}
        </Badge>
      </div>

      {/* Threads Post Card */}
      <div className="max-w-lg mx-auto bg-background overflow-hidden">
        <div className="p-4">
          {/* Topic Tag chip — shown above the post like Threads does */}
          {cleanedTopicTag && (
            <div className="flex items-center gap-1 mb-3 text-sm font-medium text-foreground/80 hover:text-foreground transition-colors cursor-pointer">
              <Hash className="w-4 h-4" />
              <span className="truncate max-w-[90%]">{cleanedTopicTag}</span>
            </div>
          )}

          <div className="flex gap-3">
            {/* Avatar Column with thread line */}
            <div className="flex flex-col items-center">
              <Avatar className="h-10 w-10 ring-2 ring-background">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
                <AvatarFallback className="bg-gradient-to-br from-purple-500 to-pink-500 text-white">
                  {username[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {/* Thread line */}
              <div className="w-0.5 flex-1 bg-border mt-2 min-h-[20px]" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              {/* Header */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  <span className="font-semibold text-sm">{username}</span>
                  <Verified className="w-3.5 h-3.5 text-[#0095F6] fill-[#0095F6]" />
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-xs">{t("threads.now", "now")}</span>
                  <MoreHorizontal className="w-4 h-4" />
                </div>
              </div>

              {/* Caption */}
              {truncatedCaption && (
                <p className="text-sm whitespace-pre-wrap break-words mb-3">
                  {truncatedCaption}
                  {caption.length > 200 && (
                    <span className="text-muted-foreground">{t("threads.more", " more")}</span>
                  )}
                </p>
              )}

              {/* Media */}
              {mediaFile && (
                <div className="relative rounded-xl overflow-hidden mb-3 border border-border">
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

              {/* Location row — shown below media/caption like Threads does */}
              {trimmedLocation && (
                <div className="flex items-center gap-1 mb-3 text-xs text-muted-foreground">
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate max-w-[80%]">{trimmedLocation}</span>
                </div>
              )}

              {/* Engagement icons */}
              <div className="flex items-center gap-4">
                <button className="hover:opacity-70 transition-opacity">
                  <Heart className="w-5 h-5" />
                </button>
                <button className="hover:opacity-70 transition-opacity">
                  <MessageCircle className="w-5 h-5" />
                </button>
                <button className="hover:opacity-70 transition-opacity">
                  <Repeat2 className="w-5 h-5" />
                </button>
                <button className="hover:opacity-70 transition-opacity">
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>

          {/* Reply indicator */}
          <div className="flex items-center gap-3 mt-3 ps-[52px]">
            {/* Small stacked avatars for replies */}
            <div className="flex -space-x-2 rtl:space-x-reverse">
              <div className="w-5 h-5 rounded-full bg-muted border-2 border-background" />
              <div className="w-5 h-5 rounded-full bg-muted border-2 border-background" />
            </div>
            <span className="text-xs text-muted-foreground">
              {t("threads.repliesCount", "0 replies · {{replyText}}", { replyText })}
            </span>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-border" />
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {caption.length > 0
          ? t("threads.charCount", "{{count}} characters", { count: caption.length })
          : t("threads.emptyHint", "Add content to see how your thread will appear")}
      </p>
    </div>
  );
}
