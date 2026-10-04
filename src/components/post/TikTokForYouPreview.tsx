import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { 
  Heart, 
  MessageCircle, 
  Bookmark, 
  Share2, 
  Music2, 
  Plus, 
  Search, 
  Home, 
  User,
  Grid3X3,
  Monitor,
  Play,
} from "lucide-react";

type PreviewView = "feed" | "profile" | "webtv";

interface TikTokForYouPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  username?: string;
  avatarUrl?: string;
  soundName?: string;
}

export function TikTokForYouPreview({
  caption,
  mediaFile,
  username = "your_account",
  avatarUrl,
  soundName,
}: TikTokForYouPreviewProps) {
  const { t } = useTranslation("postpreview");
  const [activeView, setActiveView] = useState<PreviewView>("feed");
  const displaySoundName = soundName || t("tikTokForYou.defaultSoundName", "Original sound");
  
  // Truncate caption for preview
  const truncatedCaption = caption.length > 150 ? caption.slice(0, 147) + "..." : caption;

  const viewTabs: { id: PreviewView; label: string }[] = [
    { id: "feed", label: t("tikTokForYou.feedTab", "Feed") },
    { id: "profile", label: t("tikTokForYou.profileTab", "Profile") },
    { id: "webtv", label: t("tikTokForYou.webTvTab", "Web/TV") },
  ];

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-black rounded flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-white" fill="currentColor">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z"/>
            </svg>
          </div>
          <span className="text-sm font-medium">{t("tikTokForYou.previewTitle", "TikTok Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-black/5 dark:bg-white/10 text-foreground">
          {t("tikTokForYou.videoBadge", "Video")}
        </Badge>
      </div>

      {/* View Tabs */}
      <div className="flex items-center justify-center gap-1 p-1 bg-muted/50 rounded-full w-fit mx-auto mb-4">
        {viewTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-all duration-200",
              activeView === tab.id
                ? "bg-foreground text-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Preview Content */}
      <div className="flex justify-center">
        {activeView === "feed" && (
          <FeedPreview
            caption={truncatedCaption}
            mediaFile={mediaFile}
            username={username}
            avatarUrl={avatarUrl}
            soundName={displaySoundName}
          />
        )}
        {activeView === "profile" && (
          <ProfilePreview
            mediaFile={mediaFile}
            username={username}
            avatarUrl={avatarUrl}
          />
        )}
        {activeView === "webtv" && (
          <WebTVPreview
            caption={truncatedCaption}
            mediaFile={mediaFile}
            username={username}
            avatarUrl={avatarUrl}
          />
        )}
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center mt-4">
        {activeView === "feed" && t("tikTokForYou.feedInfo", "How your video appears on the For You page")}
        {activeView === "profile" && t("tikTokForYou.profileInfo", "How your video appears on your profile grid")}
        {activeView === "webtv" && t("tikTokForYou.webTvInfo", "How your video appears on web and TV apps")}
      </p>
    </div>
  );
}

// Feed Preview (For You page)
function FeedPreview({
  caption,
  mediaFile,
  username,
  avatarUrl,
  soundName,
}: {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: string };
  username: string;
  avatarUrl?: string;
  soundName: string;
}) {
  const { t } = useTranslation("postpreview");
  return (
    <div className="max-w-[280px]">
      <div className="relative bg-black rounded-[2rem] overflow-hidden aspect-[9/16] shadow-2xl border-4 border-gray-800">
        {/* Notch */}
        <div className="absolute top-0 start-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-b-2xl z-20" />
        
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
            <div className="w-full h-full bg-neutral-900 dark:bg-neutral-800" />
          )}
          
          {/* Dark overlay for text visibility */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30" />
        </div>

        {/* Top Navigation */}
        <div className="absolute top-8 start-0 end-0 flex items-center justify-center gap-6 z-10">
          <span className="text-white/60 text-sm font-medium">{t("tikTokForYou.following", "Following")}</span>
          <span className="text-white text-sm font-bold border-b-2 border-white pb-1">{t("tikTokForYou.forYou", "For You")}</span>
          <Search className="w-5 h-5 text-white absolute end-4" />
        </div>

        {/* Right Side Actions */}
        <div className="absolute end-3 bottom-24 flex flex-col items-center gap-5 z-10">
          {/* Profile Avatar */}
          <div className="relative">
            <Avatar className="h-11 w-11 border-2 border-white">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="text-white text-sm bg-neutral-900 dark:bg-neutral-800">
                {username[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="absolute -bottom-2 start-1/2 -translate-x-1/2 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center">
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
            <span className="text-white text-xs font-medium">{t("tikTokForYou.share", "Share")}</span>
          </div>

          {/* Spinning Disc */}
          <div className="w-10 h-10 rounded-full border-4 border-gray-700 flex items-center justify-center animate-spin-slow bg-gray-800">
            <div className="w-3 h-3 rounded-full bg-gray-600" />
          </div>
        </div>

        {/* Bottom Content */}
        <div className="absolute bottom-20 start-3 end-16 z-10">
          {/* Username */}
          <div className="flex items-center gap-1 mb-2">
            <span className="text-white font-bold text-sm">@{username}</span>
          </div>

          {/* Caption */}
          {caption && (
            <p className="text-white text-xs leading-relaxed mb-3">
              {caption}
            </p>
          )}

          {/* Sound */}
          <div className="flex items-center gap-2">
            <Music2 className="w-3 h-3 text-white" />
            <div className="overflow-hidden">
              <p className="text-white text-xs whitespace-nowrap animate-marquee">
                {soundName} - @{username}
              </p>
            </div>
          </div>
        </div>

        {/* Bottom Navigation Bar */}
        <div className="absolute bottom-0 start-0 end-0 h-14 bg-black/90 flex items-center justify-around px-4 z-10">
          <div className="flex flex-col items-center">
            <Home className="w-5 h-5 text-white" fill="white" />
            <span className="text-white text-[10px] mt-0.5">{t("tikTokForYou.home", "Home")}</span>
          </div>
          <div className="flex flex-col items-center">
            <Search className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.discover", "Discover")}</span>
          </div>
          <div className="w-10 h-7 bg-white rounded-lg flex items-center justify-center">
            <Plus className="w-5 h-5 text-black" />
          </div>
          <div className="flex flex-col items-center">
            <MessageCircle className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.inbox", "Inbox")}</span>
          </div>
          <div className="flex flex-col items-center">
            <User className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.profile", "Profile")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Profile Preview (Grid view)
function ProfilePreview({
  mediaFile,
  username,
  avatarUrl,
}: {
  mediaFile?: { previewUrl: string; fileType: string };
  username: string;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("postpreview");
  return (
    <div className="max-w-[280px]">
      <div className="relative bg-black rounded-[2rem] overflow-hidden aspect-[9/16] shadow-2xl border-4 border-gray-800">
        {/* Notch */}
        <div className="absolute top-0 start-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-b-2xl z-20" />
        
        {/* Profile Header */}
        <div className="absolute top-8 start-0 end-0 px-4 z-10">
          <div className="flex items-center justify-center mb-4">
            <span className="text-white font-bold text-base">@{username}</span>
          </div>
          
          {/* Avatar */}
          <div className="flex justify-center mb-3">
            <Avatar className="h-20 w-20 border-2 border-white/20">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="text-white text-2xl bg-neutral-900 dark:bg-neutral-800">
                {username[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </div>

          {/* Stats */}
          <div className="flex justify-center gap-8 text-white text-center mb-4">
            <div>
              <p className="font-bold text-lg">0</p>
              <p className="text-xs text-white/60">{t("tikTokForYou.followingCount", "Following")}</p>
            </div>
            <div>
              <p className="font-bold text-lg">0</p>
              <p className="text-xs text-white/60">{t("tikTokForYou.followersCount", "Followers")}</p>
            </div>
            <div>
              <p className="font-bold text-lg">0</p>
              <p className="text-xs text-white/60">{t("tikTokForYou.likesCount", "Likes")}</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-white/20 mb-2">
            <button className="flex-1 pb-2 text-white border-b-2 border-white">
              <Grid3X3 className="w-5 h-5 mx-auto" />
            </button>
            <button className="flex-1 pb-2 text-white/40">
              <Bookmark className="w-5 h-5 mx-auto" />
            </button>
            <button className="flex-1 pb-2 text-white/40">
              <Heart className="w-5 h-5 mx-auto" />
            </button>
          </div>
        </div>

        {/* Video Grid */}
        <div className="absolute top-[220px] start-0 end-0 bottom-14 px-0.5 z-10">
          <div className="grid grid-cols-3 gap-0.5">
            {/* Current video (highlighted) */}
            <div className="aspect-[9/16] relative bg-gray-800 overflow-hidden border-2 border-[#25f4ee]">
              {mediaFile?.fileType === "video" ? (
                <video
                  src={mediaFile.previewUrl}
                  className="w-full h-full object-cover"
                  muted
                />
              ) : mediaFile?.fileType === "image" ? (
                <img
                  src={mediaFile.previewUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-neutral-900 dark:bg-neutral-800" />
              )}
              <div className="absolute bottom-1 start-1 flex items-center gap-0.5">
                <Play className="w-2 h-2 text-white" fill="white" />
                <span className="text-white text-[8px]">0</span>
              </div>
            </div>
            
            {/* Placeholder videos */}
            {[...Array(5)].map((_, i) => (
              <div key={i} className="aspect-[9/16] bg-gray-800/50" />
            ))}
          </div>
        </div>

        {/* Bottom Navigation Bar */}
        <div className="absolute bottom-0 start-0 end-0 h-14 bg-black flex items-center justify-around px-4 z-10">
          <div className="flex flex-col items-center">
            <Home className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.home", "Home")}</span>
          </div>
          <div className="flex flex-col items-center">
            <Search className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.discover", "Discover")}</span>
          </div>
          <div className="w-10 h-7 bg-white rounded-lg flex items-center justify-center">
            <Plus className="w-5 h-5 text-black" />
          </div>
          <div className="flex flex-col items-center">
            <MessageCircle className="w-5 h-5 text-white/60" />
            <span className="text-white/60 text-[10px] mt-0.5">{t("tikTokForYou.inbox", "Inbox")}</span>
          </div>
          <div className="flex flex-col items-center">
            <User className="w-5 h-5 text-white" fill="white" />
            <span className="text-white text-[10px] mt-0.5">{t("tikTokForYou.profile", "Profile")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Web/TV Preview
function WebTVPreview({
  caption,
  mediaFile,
  username,
  avatarUrl,
}: {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: string };
  username: string;
  avatarUrl?: string;
}) {
  return (
    <div className="w-full max-w-[400px]">
      <div className="relative bg-black rounded-xl overflow-hidden aspect-video shadow-2xl border border-gray-800">
        {/* Video Background */}
        <div className="absolute inset-0">
          {mediaFile?.fileType === "video" ? (
            <video
              src={mediaFile.previewUrl}
              className="w-full h-full object-contain bg-black"
              muted
              loop
              autoPlay
              playsInline
            />
          ) : mediaFile?.fileType === "image" ? (
            <img
              src={mediaFile.previewUrl}
              alt=""
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <div className="w-full h-full bg-neutral-900 dark:bg-neutral-800" />
          )}
        </div>

        {/* Top Bar */}
        <div className="absolute top-0 start-0 end-0 p-3 bg-gradient-to-b from-black/60 to-transparent z-10">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-black rounded flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-5.2 1.74 2.89 2.89 0 012.31-4.64 2.93 2.93 0 01.88.13V9.4a6.84 6.84 0 00-1-.05A6.33 6.33 0 005 20.1a6.34 6.34 0 0010.86-4.43v-7a8.16 8.16 0 004.77 1.52v-3.4a4.85 4.85 0 01-1-.1z"/>
              </svg>
            </div>
            <span className="text-white text-sm font-bold">TikTok</span>
          </div>
        </div>

        {/* Bottom Info */}
        <div className="absolute bottom-0 start-0 end-0 p-4 bg-gradient-to-t from-black/80 to-transparent z-10">
          <div className="flex items-start gap-3">
            <Avatar className="h-10 w-10 border border-white/20">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
              <AvatarFallback className="text-white text-sm bg-neutral-900 dark:bg-neutral-800">
                {username[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm">@{username}</p>
              {caption && (
                <p className="text-white/80 text-xs line-clamp-2 mt-1">{caption}</p>
              )}
            </div>
          </div>
        </div>

        {/* Right Side Actions */}
        <div className="absolute end-3 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-10">
          <div className="flex flex-col items-center">
            <Heart className="w-6 h-6 text-white" />
            <span className="text-white text-[10px]">0</span>
          </div>
          <div className="flex flex-col items-center">
            <MessageCircle className="w-6 h-6 text-white" />
            <span className="text-white text-[10px]">0</span>
          </div>
          <div className="flex flex-col items-center">
            <Share2 className="w-6 h-6 text-white" />
          </div>
        </div>
      </div>
    </div>
  );
}
