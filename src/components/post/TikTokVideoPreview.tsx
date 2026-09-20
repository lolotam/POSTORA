import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageCircle, Bookmark, Share2, Music2, Plus, Search, Home, User } from "lucide-react";

interface TikTokVideoPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
  soundName?: string;
}

export function TikTokVideoPreview({
  caption,
  mediaFile,
  username = "your_account",
  avatarUrl,
  soundName,
}: TikTokVideoPreviewProps) {
  const { t } = useTranslation("postpreview");
  const displaySoundName = soundName || t("tiktokVideo.defaultSoundName", "Original sound");
  // Truncate caption for preview
  const truncatedCaption = caption.length > 150 ? caption.slice(0, 147) + "..." : caption;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-black rounded flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white" fill="currentColor">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z"/>
            </svg>
          </div>
          <span className="text-sm font-medium">{t("tiktokVideo.previewTitle", "For You Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-black/5 dark:bg-white/10 text-foreground">
          {t("tiktokVideo.videoBadge", "Video")}
        </Badge>
      </div>

      {/* TikTok Phone Frame */}
      <div className="max-w-[280px] mx-auto">
        <div className="relative bg-black rounded-[2rem] overflow-hidden aspect-[9/16] shadow-2xl border-4 border-gray-800">
          {/* Notch */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-b-2xl z-20" />
          
          {/* Video/Image Background */}
          <div className="absolute inset-0">
            {mediaFile?.fileType === "video" ? (
              <video
                src={mediaFile.previewUrl}
                className="w-full h-full object-cover"
                muted
                loop
                autoPlay
                playsInline
              />
            ) : mediaFile?.fileType === "image" ? (
              <img
                src={mediaFile.previewUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-pink-500 via-purple-500 to-cyan-500" />
            )}
            
            {/* Dark overlay for text visibility */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30" />
          </div>

          {/* Top Navigation */}
          <div className="absolute top-8 left-0 right-0 flex items-center justify-center gap-6 z-10">
            <span className="text-white/60 text-sm font-medium">{t("tiktokVideo.following", "Following")}</span>
            <span className="text-white text-sm font-bold border-b-2 border-white pb-1">{t("tiktokVideo.forYou", "For You")}</span>
            <Search className="w-5 h-5 text-white absolute right-4" />
          </div>

          {/* Right Side Actions */}
          <div className="absolute right-3 bottom-24 flex flex-col items-center gap-5 z-10">
            {/* Profile Avatar */}
            <div className="relative">
              <Avatar className="h-11 w-11 border-2 border-white">
                {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
                <AvatarFallback className="bg-gradient-to-br from-pink-500 to-purple-500 text-white text-sm">
                  {username[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center">
                <Plus className="w-3 h-3 text-white" />
              </div>
            </div>

            {/* Like */}
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 flex items-center justify-center">
                <Heart className="w-7 h-7 text-white drop-shadow-lg" />
              </div>
              <span className="text-white text-xs font-medium">0</span>
            </div>

            {/* Comment */}
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 flex items-center justify-center">
                <MessageCircle className="w-7 h-7 text-white drop-shadow-lg" />
              </div>
              <span className="text-white text-xs font-medium">0</span>
            </div>

            {/* Bookmark */}
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 flex items-center justify-center">
                <Bookmark className="w-7 h-7 text-white drop-shadow-lg" />
              </div>
              <span className="text-white text-xs font-medium">0</span>
            </div>

            {/* Share */}
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 flex items-center justify-center">
                <Share2 className="w-7 h-7 text-white drop-shadow-lg" />
              </div>
              <span className="text-white text-xs font-medium">{t("tiktokVideo.share", "Share")}</span>
            </div>

            {/* Spinning Disc */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-800 to-gray-900 border-4 border-gray-700 flex items-center justify-center animate-spin-slow">
              <div className="w-3 h-3 rounded-full bg-gray-600" />
            </div>
          </div>

          {/* Bottom Content */}
          <div className="absolute bottom-20 left-3 right-16 z-10">
            {/* Username */}
            <div className="flex items-center gap-1 mb-2">
              <span className="text-white font-bold text-sm">@{username}</span>
            </div>

            {/* Caption */}
            {truncatedCaption && (
              <p className="text-white text-xs leading-relaxed mb-3">
                {truncatedCaption}
              </p>
            )}

            {/* Sound */}
            <div className="flex items-center gap-2">
              <Music2 className="w-3 h-3 text-white" />
              <div className="overflow-hidden">
                <p className="text-white text-xs whitespace-nowrap animate-marquee">
                  {displaySoundName} - @{username}
                </p>
              </div>
            </div>
          </div>

          {/* Bottom Navigation Bar */}
          <div className="absolute bottom-0 left-0 right-0 h-14 bg-black/90 flex items-center justify-around px-4 z-10">
            <div className="flex flex-col items-center">
              <Home className="w-5 h-5 text-white" fill="white" />
              <span className="text-white text-[10px] mt-0.5">{t("tiktokVideo.home", "Home")}</span>
            </div>
            <div className="flex flex-col items-center">
              <Search className="w-5 h-5 text-white/60" />
              <span className="text-white/60 text-[10px] mt-0.5">{t("tiktokVideo.discover", "Discover")}</span>
            </div>
            <div className="w-10 h-7 bg-white rounded-lg flex items-center justify-center">
              <Plus className="w-5 h-5 text-black" />
            </div>
            <div className="flex flex-col items-center">
              <MessageCircle className="w-5 h-5 text-white/60" />
              <span className="text-white/60 text-[10px] mt-0.5">{t("tiktokVideo.inbox", "Inbox")}</span>
            </div>
            <div className="flex flex-col items-center">
              <User className="w-5 h-5 text-white/60" />
              <span className="text-white/60 text-[10px] mt-0.5">{t("tiktokVideo.profile", "Profile")}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {t("tiktokVideo.infoText", "Preview of how your video will appear on TikTok's For You page")}
      </p>
    </div>
  );
}
