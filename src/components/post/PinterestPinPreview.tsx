import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Heart, Share, MoreHorizontal, ExternalLink } from "lucide-react";

interface PinterestPinPreviewProps {
  caption: string;
  mediaFile?: { previewUrl: string; fileType: "image" | "video" | "gif" };
  title?: string;
  link?: string;
  boardName?: string;
  username?: string;
  avatarUrl?: string;
}

export function PinterestPinPreview({
  caption,
  mediaFile,
  title,
  link,
  boardName,
  username = "your_profile",
  avatarUrl,
}: PinterestPinPreviewProps) {
  const { t } = useTranslation("postpreview");
  const displayBoardName = boardName || t("pinterest.defaultBoardName", "My Board");
  const displayTitle = title || caption.slice(0, 50) || t("pinterest.defaultPinTitle", "Your Pin");
  const truncatedDescription = caption.length > 100 ? caption.slice(0, 97) + "..." : caption;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-[#E60023] rounded-full flex items-center justify-center">
            <span className="text-white text-[10px] font-bold">P</span>
          </div>
          <span className="text-sm font-medium">{t("pinterest.previewTitle", "Pin Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs bg-[#E60023]/10 text-[#E60023] dark:bg-[#E60023]/20">
          {t("pinterest.pinBadge", "Pin")}
        </Badge>
      </div>

      {/* Masonry-style preview container */}
      <div className="flex justify-center gap-3">
        {/* Left placeholder pins for context */}
        <div className="hidden sm:flex flex-col gap-3 w-32 opacity-40">
          <div className="bg-muted rounded-2xl h-44 animate-pulse" />
          <div className="bg-muted rounded-2xl h-52 animate-pulse" />
        </div>

        {/* Main Pin Card */}
        <div className="w-56 sm:w-64 flex-shrink-0">
          <div className="bg-background border rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-shadow group">
            {/* Pin Image */}
            <div className="relative aspect-[2/3] bg-muted overflow-hidden">
              {mediaFile ? (
                mediaFile.fileType === "video" ? (
                  <video
                    src={mediaFile.previewUrl}
                    className="w-full h-full object-cover"
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : (
                  <img
                    src={mediaFile.previewUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-muted-foreground text-xs">{t("pinterest.addMedia", "Add media")}</span>
                </div>
              )}
              
              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-3">
                {/* Top actions */}
                <div className="flex items-center justify-between">
                  <button className="bg-[#E60023] text-white text-sm font-semibold px-4 py-2 rounded-full hover:bg-[#ad081b] transition-colors">
                    {t("common:save", "Save")}
                  </button>
                  <div className="flex items-center gap-2">
                    <button className="w-8 h-8 bg-white/90 rounded-full flex items-center justify-center hover:bg-white transition-colors">
                      <Share className="w-4 h-4 text-foreground" />
                    </button>
                    <button className="w-8 h-8 bg-white/90 rounded-full flex items-center justify-center hover:bg-white transition-colors">
                      <MoreHorizontal className="w-4 h-4 text-foreground" />
                    </button>
                  </div>
                </div>
                
                {/* Bottom link */}
                {link && (
                  <div className="flex items-center gap-2 bg-white/90 rounded-full px-3 py-1.5 max-w-full">
                    <ExternalLink className="w-3 h-3 text-foreground flex-shrink-0" />
                    <span className="text-xs text-foreground truncate">
                      {link.replace(/^https?:\/\//, '').slice(0, 25)}...
                    </span>
                  </div>
                )}
              </div>

              {/* Video indicator */}
              {mediaFile?.fileType === "video" && (
                <div className="absolute bottom-2 start-2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                  {t("pinterest.videoBadge", "Video")}
                </div>
              )}
            </div>
            
            {/* Pin Info */}
            <div className="p-3">
              {/* Title */}
              <h3 className="font-semibold text-sm line-clamp-2 leading-tight mb-1">
                {displayTitle}
              </h3>
              
              {/* Description preview */}
              {truncatedDescription && (
                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                  {truncatedDescription}
                </p>
              )}
              
              {/* User info */}
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-muted overflow-hidden flex-shrink-0">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-[#E60023]/20 flex items-center justify-center">
                      <span className="text-[10px] text-[#E60023] font-medium">
                        {username[0]?.toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                <span className="text-xs text-muted-foreground truncate">{username}</span>
              </div>
            </div>
          </div>
          
          {/* Board indicator below */}
          <div className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <span>{t("pinterest.savingTo", "Saving to")}</span>
            <span className="font-medium text-foreground">{displayBoardName}</span>
          </div>
        </div>

        {/* Right placeholder pins for context */}
        <div className="hidden sm:flex flex-col gap-3 w-32 opacity-40">
          <div className="bg-muted rounded-2xl h-56 animate-pulse" />
          <div className="bg-muted rounded-2xl h-40 animate-pulse" />
        </div>
      </div>

      {/* Info text */}
      <p className="text-xs text-muted-foreground text-center">
        {mediaFile
          ? t("pinterest.infoWithMedia", "This is how your Pin will appear on Pinterest boards")
          : t("pinterest.infoWithoutMedia", "Add an image to preview your Pin")}
      </p>
    </div>
  );
}
