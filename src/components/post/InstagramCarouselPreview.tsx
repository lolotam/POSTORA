import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Heart, MessageCircle, Send, Bookmark, MoreHorizontal, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface InstagramCarouselPreviewProps {
  caption: string;
  mediaFiles: { previewUrl: string; fileType: "image" | "video" | "gif" }[];
  username?: string;
  avatarUrl?: string;
}

export function InstagramCarouselPreview({
  caption,
  mediaFiles,
  username = "your_account",
  avatarUrl,
}: InstagramCarouselPreviewProps) {
  const { t } = useTranslation("postpreview");
  const [currentIndex, setCurrentIndex] = useState(0);

  if (mediaFiles.length <= 1) {
    return null;
  }

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : prev));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev < mediaFiles.length - 1 ? prev + 1 : prev));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-gradient-to-br from-[#833AB4] via-[#E1306C] to-[#F77737] rounded flex items-center justify-center">
            <span className="text-white text-xs font-bold">◫</span>
          </div>
          <span className="text-sm font-medium">{t("instagramCarousel.previewTitle", "Carousel Preview")}</span>
        </div>
        <Badge variant="secondary" className="text-xs">
          {t("instagramCarousel.slidesCount", "{{count}} slides", { count: mediaFiles.length })}
        </Badge>
      </div>

      {/* Instagram post mockup */}
      <div className="max-w-[320px] mx-auto bg-background border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-3 border-b border-border">
          <Avatar className="h-8 w-8">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt={username} /> : null}
            <AvatarFallback className="text-xs">{username[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="font-semibold text-sm flex-1">{username}</span>
          <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
        </div>

        {/* Media Carousel */}
        <div className="aspect-square bg-muted relative overflow-hidden">
          {/* Current slide */}
          {mediaFiles[currentIndex]?.fileType === "image" ? (
            <img
              src={mediaFiles[currentIndex].previewUrl}
              alt={t("instagramCarousel.slideAlt", "Slide {{number}}", { number: currentIndex + 1 })}
              className="w-full h-full object-cover transition-opacity duration-200"
            />
          ) : (
            <video
              src={mediaFiles[currentIndex]?.previewUrl}
              className="w-full h-full object-cover"
              muted
            />
          )}

          {/* Navigation arrows */}
          {currentIndex > 0 && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute start-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-background/80 hover:bg-background shadow-lg"
              onClick={goToPrevious}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          {currentIndex < mediaFiles.length - 1 && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute end-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-background/80 hover:bg-background shadow-lg"
              onClick={goToNext}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}

          {/* Slide indicator */}
          <div className="absolute top-3 end-3 bg-background/80 backdrop-blur px-2 py-1 rounded text-xs font-medium">
            {currentIndex + 1}/{mediaFiles.length}
          </div>
        </div>

        {/* Dots indicator */}
        <div className="flex justify-center gap-1.5 py-2">
          {mediaFiles.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentIndex(idx)}
              className={cn(
                "w-1.5 h-1.5 rounded-full transition-colors",
                idx === currentIndex ? "bg-[#0095F6]" : "bg-muted-foreground/30"
              )}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Heart className="w-6 h-6" />
              <MessageCircle className="w-6 h-6" />
              <Send className="w-6 h-6" />
            </div>
            <Bookmark className="w-6 h-6" />
          </div>
          <p className="text-sm font-semibold">{t("instagramCarousel.likesCount", "0 likes")}</p>
          {caption && (
            <p className="text-sm">
              <span className="font-semibold">{username}</span>{" "}
              {caption.slice(0, 100)}
              {caption.length > 100 && (
                <span className="text-muted-foreground"> {t("instagramCarousel.more", "...more")}</span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Thumbnail strip */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 px-1">
        {mediaFiles.map((file, idx) => (
          <button
            key={idx}
            onClick={() => setCurrentIndex(idx)}
            className={cn(
              "relative shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-all",
              idx === currentIndex 
                ? "border-[#0095F6] ring-2 ring-[#0095F6]/30" 
                : "border-transparent opacity-60 hover:opacity-100"
            )}
          >
            {file.fileType === "image" ? (
              <img src={file.previewUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <video src={file.previewUrl} className="w-full h-full object-cover" muted />
            )}
            <div className="absolute bottom-0.5 end-0.5 bg-black/60 text-white text-[8px] px-1 rounded">
              {idx + 1}
            </div>
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground text-center">
        {t("instagramCarousel.infoText", "Carousel posts can have up to 10 photos or videos")}
      </p>
    </div>
  );
}
