import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ThumbsUp, ThumbsDown, MessageCircle, Send, MoreVertical, Music2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface YouTubeShortsPreviewProps {
  title: string;
  description?: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
}

export function YouTubeShortsPreview({
  title,
  description,
  mediaFile,
  username,
  avatarUrl,
}: YouTubeShortsPreviewProps) {
  const { t } = useTranslation("postpreview");
  const channelName = username || t("youTubeShorts.defaultChannel", "Your Channel");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[#FF0000] rounded flex items-center justify-center">
            <span className="text-white text-xs font-bold">▶</span>
          </div>
          <span className="text-sm font-medium">{t("youTubeShorts.previewTitle", "Shorts Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-[#FF0000]/10 text-[#FF0000]">
          {t("youTubeShorts.shortsBadge", "#Shorts")}
        </Badge>
      </div>

      {/* Phone mockup */}
      <div className="max-w-[260px] mx-auto bg-black rounded-[2rem] overflow-hidden aspect-[9/16] relative border-4 border-gray-800">
        {/* Video/Image background */}
        {mediaFile ? (
          mediaFile.fileType === "video" ? (
            <video
              src={mediaFile.previewUrl}
              className="absolute inset-0 w-full h-full object-cover"
              muted
              loop
              autoPlay
              playsInline
            />
          ) : (
            <img
              src={mediaFile.previewUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          )
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-gray-800 to-gray-900" />
        )}

        {/* Overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/70" />

        {/* YouTube Shorts logo */}
        <div className="absolute top-4 left-4 flex items-center gap-1">
          <div className="bg-[#FF0000] rounded-sm px-1.5 py-0.5">
            <span className="text-white text-xs font-bold">{t("youTubeShorts.shortsLabel", "Shorts")}</span>
          </div>
        </div>

        {/* Right side actions */}
        <div className="absolute right-3 bottom-28 flex flex-col items-center gap-5 z-10">
          <div className="flex flex-col items-center text-white">
            <ThumbsUp className="w-7 h-7" />
            <span className="text-xs mt-1">{t("youTubeShorts.like", "Like")}</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <ThumbsDown className="w-7 h-7" />
            <span className="text-xs mt-1">{t("youTubeShorts.dislike", "Dislike")}</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <MessageCircle className="w-7 h-7" />
            <span className="text-xs mt-1">0</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <Send className="w-7 h-7" />
            <span className="text-xs mt-1">{t("youTubeShorts.share", "Share")}</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <MoreVertical className="w-7 h-7" />
          </div>
          {/* Music disc */}
          <div className="w-8 h-8 rounded-lg bg-[#FF0000] border-2 border-white overflow-hidden animate-spin" style={{ animationDuration: "3s" }}>
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Music2 className="w-4 h-4 text-white" />
              </div>
            )}
          </div>
        </div>

        {/* Bottom info */}
        <div className="absolute bottom-4 left-3 right-16 text-white z-10">
          <div className="flex items-center gap-2 mb-2">
            <Avatar className="h-8 w-8 border-2 border-white">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={channelName} /> : null}
              <AvatarFallback className="bg-[#FF0000] text-white text-xs">{channelName[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-sm">@{channelName}</span>
            <button className="px-2 py-0.5 bg-white text-black text-xs font-semibold rounded">
              {t("youTubeShorts.subscribe", "Subscribe")}
            </button>
          </div>
          {title && (
            <p className="text-sm font-medium line-clamp-2">{title}</p>
          )}
          {description && (
            <p className="text-xs opacity-80 mt-1 line-clamp-1">{description}</p>
          )}
          <div className="flex items-center gap-1 mt-2 text-xs opacity-70">
            <Music2 className="w-3 h-3" />
            <span className="truncate">{t("youTubeShorts.originalAudio", { username: channelName, defaultValue: `Original audio - ${channelName}` })}</span>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {t("youTubeShorts.infoText", "Shorts are vertical videos up to 60 seconds")}
      </p>
    </div>
  );
}
