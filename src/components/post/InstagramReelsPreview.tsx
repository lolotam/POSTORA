import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageCircle, Send, Bookmark, MoreHorizontal, Music2 } from "lucide-react";

interface InstagramReelsPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
}

export function InstagramReelsPreview({
  caption,
  mediaFile,
  username = "your_account",
  avatarUrl,
}: InstagramReelsPreviewProps) {
  const { t } = useTranslation("postpreview");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-[#833AB4]">
            <span className="text-white text-xs font-bold">▶</span>
          </div>
          <span className="text-sm font-medium">{t("instagramReels.previewTitle", "Reels Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs text-[#E1306C] bg-[#833AB4]/10">
          {t("instagramReels.reelBadge", "Reel")}
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
          <div className="absolute inset-0 bg-gray-800" />
        )}

        {/* Overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/70" />

        {/* Instagram Reels logo */}
        <div className="absolute top-4 start-4 flex items-center gap-1">
          <div className="rounded-sm px-1.5 py-0.5 bg-[#833AB4]">
            <span className="text-white text-xs font-bold">{t("instagramReels.reelsLabel", "Reels")}</span>
          </div>
        </div>

        {/* Right side actions */}
        <div className="absolute end-3 bottom-28 flex flex-col items-center gap-5 z-10">
          <div className="flex flex-col items-center text-white">
            <Heart className="w-7 h-7" />
            <span className="text-xs mt-1">0</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <MessageCircle className="w-7 h-7" />
            <span className="text-xs mt-1">0</span>
          </div>
          <div className="flex flex-col items-center text-white">
            <Send className="w-7 h-7" />
          </div>
          <div className="flex flex-col items-center text-white">
            <Bookmark className="w-7 h-7" />
          </div>
          <div className="flex flex-col items-center text-white">
            <MoreHorizontal className="w-7 h-7" />
          </div>
          {/* Music disc */}
          <div className="w-8 h-8 rounded-lg border-2 border-white overflow-hidden animate-spin bg-[#833AB4]" style={{ animationDuration: "3s" }}>
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
        <div className="absolute bottom-4 start-3 end-16 text-white z-10">
          <div className="flex items-center gap-2 mb-2">
            <Avatar className="h-8 w-8 border-2 border-white">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="text-white text-xs bg-[#833AB4]">{username[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-sm">{username}</span>
            <button className="px-2 py-0.5 border border-white text-white text-xs font-semibold rounded">
              {t("instagramReels.follow", "Follow")}
            </button>
          </div>
          {caption && (
            <p className="text-sm line-clamp-2">{caption}</p>
          )}
          <div className="flex items-center gap-1 mt-2 text-xs opacity-70">
            <Music2 className="w-3 h-3" />
            <span className="truncate">{t("instagramReels.originalAudio", "Original audio - {{username}}", { username })}</span>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {t("instagramReels.infoText", "Reels are vertical videos up to 90 seconds")}
      </p>
    </div>
  );
}
