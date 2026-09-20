import React, { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "@/lib/types";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal, ThumbsUp, Send, Users } from "lucide-react";
import { UnsplashAttribution } from "./UnsplashAttribution";

export type PlatformIdentity = {
  id: string;
  username?: string | null;
  avatarUrl?: string | null;
};

/** Map of platform -> array of account identities for preview switching */
export type PlatformIdentityMap = Partial<Record<Platform, PlatformIdentity[]>>;

/** Extended media file type with optional attribution */
export interface PreviewMediaFile {
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  mediaSource?: "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash" | "local";
  photographerName?: string;
  photographerUrl?: string;
  unsplashUrl?: string;
}

interface PostPreviewProps {
  caption: string;
  mediaFiles: PreviewMediaFile[];
  selectedPlatforms: Platform[];
  /** Fallback identity (used when we don't have a selected account for a platform). */
  username?: string;
  /** Fallback identity (used when we don't have a selected account for a platform). */
  avatarUrl?: string;
  /** Per-platform identities (array per platform) pulled from the selected accounts. */
  platformIdentities?: PlatformIdentityMap;
}

export function PostPreview({
  caption,
  mediaFiles,
  selectedPlatforms,
  username,
  avatarUrl,
  platformIdentities,
}: PostPreviewProps) {
  const { t } = useTranslation("postpreview");
  const defaultUsername = username || t("postPreview.defaultUsername", "Your Account");

  // Track selected identity index per platform
  const [selectedIdentityIndex, setSelectedIdentityIndex] = useState<Partial<Record<Platform, number>>>({});

  const getIdentity = (platform: Platform) => {
    const identities = platformIdentities?.[platform];
    if (!identities || identities.length === 0) {
      return { username: defaultUsername, avatarUrl };
    }
    const idx = selectedIdentityIndex[platform] ?? 0;
    const identity = identities[idx] ?? identities[0];
    return {
      username: identity.username || defaultUsername,
      avatarUrl: identity.avatarUrl ?? avatarUrl,
    };
  };

  const handleIdentityChange = (platform: Platform, accountId: string) => {
    const identities = platformIdentities?.[platform] ?? [];
    const idx = identities.findIndex((i) => i.id === accountId);
    if (idx >= 0) {
      setSelectedIdentityIndex((prev) => ({ ...prev, [platform]: idx }));
    }
  };

  if (selectedPlatforms.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-muted-foreground text-sm">
          {t("postPreview.selectPlatforms", "Select platforms to see preview")}
        </p>
      </div>
    );
  }

  const truncateCaption = (text: string, limit: number) => {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + "...";
  };

  return (
    <Tabs defaultValue={selectedPlatforms[0]} className="w-full">
      <TabsList className="w-full justify-start bg-secondary/50 mb-4 flex-wrap">
        {selectedPlatforms.map((platform) => (
          <TabsTrigger key={platform} value={platform} className="gap-2">
            <PlatformIcon platform={platform} size="xs" />
            {getPlatformName(platform)}
          </TabsTrigger>
        ))}
      </TabsList>

      {selectedPlatforms.map((platform) => {
        const identity = getIdentity(platform);
        const identities = platformIdentities?.[platform] ?? [];
        const hasMultiple = identities.length > 1;
        const currentIdx = selectedIdentityIndex[platform] ?? 0;
        const currentId = identities[currentIdx]?.id ?? identities[0]?.id;

        return (
          <TabsContent key={platform} value={platform} className="space-y-4">
            {/* Identity Selector when multiple accounts */}
            {hasMultiple && (
              <div className="flex items-center gap-2 justify-center mb-2">
                <Users className="w-4 h-4 text-muted-foreground" />
                <Select value={currentId} onValueChange={(id) => handleIdentityChange(platform, id)}>
                  <SelectTrigger className="w-[200px] h-8 text-sm">
                    <SelectValue placeholder={t("postPreview.selectAccount", "Select account")} />
                  </SelectTrigger>
                  <SelectContent>
                    {identities.map((ident) => (
                      <SelectItem key={ident.id} value={ident.id} className="text-sm">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={ident.avatarUrl || undefined} />
                            <AvatarFallback className="text-[10px]">
                              {(ident.username?.[0] ?? "?").toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate max-w-[140px]">{ident.username || t("postPreview.accountFallback", "Account")}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {platform === "instagram" && (
              <InstagramPreview
                caption={truncateCaption(caption, 2200)}
                mediaFiles={mediaFiles}
                username={identity.username}
                avatarUrl={identity.avatarUrl || undefined}
              />
            )}
            {platform === "facebook" && (
              <FacebookPreview
                caption={truncateCaption(caption, 500)}
                mediaFiles={mediaFiles}
                username={identity.username}
                avatarUrl={identity.avatarUrl || undefined}
              />
            )}
            {platform === "tiktok" && (
              <TikTokPreview
                caption={truncateCaption(caption, 150)}
                mediaFiles={mediaFiles}
                username={identity.username}
                avatarUrl={identity.avatarUrl || undefined}
              />
            )}
            {(platform === "twitter" || platform === "linkedin" || platform === "threads" || platform === "bluesky" || platform === "reddit" || platform === "youtube" || platform === "pinterest") && (
              <GenericPreview
                platform={platform}
                caption={caption}
                mediaFiles={mediaFiles}
                username={identity.username}
                avatarUrl={identity.avatarUrl || undefined}
              />
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function InstagramPreview({
  caption,
  mediaFiles,
  username,
  avatarUrl,
}: {
  caption: string;
  mediaFiles: PreviewMediaFile[];
  username: string;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("postpreview");
  const firstMedia = mediaFiles[0];
  const hasUnsplashAttribution = firstMedia?.mediaSource === "unsplash" && 
    firstMedia.photographerName && 
    firstMedia.photographerUrl && 
    firstMedia.unsplashUrl;

  return (
    <div className="max-w-[320px] mx-auto bg-background border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-border">
        <Avatar className="h-8 w-8">
          <AvatarImage src={avatarUrl} />
          <AvatarFallback className="text-xs">{username[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="font-semibold text-sm flex-1">{username}</span>
        <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
      </div>

      {/* Media */}
      {mediaFiles.length > 0 && (
        <div className="aspect-square bg-muted relative">
          {firstMedia.fileType === "image" ? (
            <img
              src={firstMedia.previewUrl}
              alt={t("postPreview.previewAlt", "Preview")}
              className="w-full h-full object-cover"
            />
          ) : (
            <video
              src={firstMedia.previewUrl}
              className="w-full h-full object-cover"
              muted
            />
          )}
          {mediaFiles.length > 1 && (
            <div className="absolute top-3 right-3 bg-background/80 backdrop-blur px-2 py-1 rounded text-xs font-medium">
              1/{mediaFiles.length}
            </div>
          )}
          {/* Unsplash Attribution Overlay */}
          {hasUnsplashAttribution && (
            <UnsplashAttribution
              photographerName={firstMedia.photographerName!}
              photographerUrl={firstMedia.photographerUrl!}
              unsplashUrl={firstMedia.unsplashUrl!}
              variant="overlay"
            />
          )}
        </div>
      )}

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
        <p className="text-sm font-semibold">{t("postPreview.zeroLikes", "0 likes")}</p>
        {caption && (
          <p className="text-sm">
            <span className="font-semibold">{username}</span>{" "}
            {caption.slice(0, 125)}
            {caption.length > 125 && (
              <span className="text-muted-foreground"> {t("postPreview.more", "...more")}</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function FacebookPreview({
  caption,
  mediaFiles,
  username,
  avatarUrl,
}: {
  caption: string;
  mediaFiles: PreviewMediaFile[];
  username: string;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("postpreview");
  const firstMedia = mediaFiles[0];
  const hasUnsplashAttribution = firstMedia?.mediaSource === "unsplash" && 
    firstMedia.photographerName && 
    firstMedia.photographerUrl && 
    firstMedia.unsplashUrl;

  return (
    <div className="max-w-[400px] mx-auto bg-background border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 p-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={avatarUrl} />
          <AvatarFallback>{username[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <p className="font-semibold text-sm">{username}</p>
          <p className="text-xs text-muted-foreground">{t("postPreview.justNow", "Just now · 🌍")}</p>
        </div>
        <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
      </div>

      {/* Caption */}
      {caption && <p className="px-3 pb-3 text-sm">{caption}</p>}

      {/* Media */}
      {mediaFiles.length > 0 && (
        <div className={cn(
          "bg-muted relative",
          mediaFiles.length === 1 ? "aspect-video" : "grid grid-cols-2 gap-0.5"
        )}>
          {mediaFiles.slice(0, 4).map((file, i) => (
            <div key={i} className={cn(
              "relative",
              mediaFiles.length === 1 ? "aspect-video" : "aspect-square"
            )}>
              {file.fileType === "image" ? (
                <img src={file.previewUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <video src={file.previewUrl} className="w-full h-full object-cover" muted />
              )}
              {i === 3 && mediaFiles.length > 4 && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <span className="text-white text-2xl font-bold">+{mediaFiles.length - 4}</span>
                </div>
              )}
            </div>
          ))}
          {/* Unsplash Attribution Overlay */}
          {hasUnsplashAttribution && mediaFiles.length === 1 && (
            <UnsplashAttribution
              photographerName={firstMedia.photographerName!}
              photographerUrl={firstMedia.photographerUrl!}
              unsplashUrl={firstMedia.unsplashUrl!}
              variant="overlay"
            />
          )}
        </div>
      )}

      {/* Unsplash Attribution below media for multi-image */}
      {hasUnsplashAttribution && mediaFiles.length > 1 && (
        <div className="px-3 py-2">
          <UnsplashAttribution
            photographerName={firstMedia.photographerName!}
            photographerUrl={firstMedia.photographerUrl!}
            unsplashUrl={firstMedia.unsplashUrl!}
            variant="card"
          />
        </div>
      )}

      {/* Reactions */}
      <div className="p-3 border-t border-border">
        <div className="flex items-center justify-around text-muted-foreground">
          <button className="flex items-center gap-2 hover:bg-secondary px-4 py-2 rounded-lg">
            <ThumbsUp className="w-5 h-5" />
            <span className="text-sm font-medium">{t("postPreview.like", "Like")}</span>
          </button>
          <button className="flex items-center gap-2 hover:bg-secondary px-4 py-2 rounded-lg">
            <MessageCircle className="w-5 h-5" />
            <span className="text-sm font-medium">{t("postPreview.comment", "Comment")}</span>
          </button>
          <button className="flex items-center gap-2 hover:bg-secondary px-4 py-2 rounded-lg">
            <Share2 className="w-5 h-5" />
            <span className="text-sm font-medium">{t("postPreview.share", "Share")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TikTokPreview({
  caption,
  mediaFiles,
  username,
  avatarUrl,
}: {
  caption: string;
  mediaFiles: PreviewMediaFile[];
  username: string;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("postpreview");
  const [previewMode, setPreviewMode] = React.useState<"feed" | "profile" | "webtv">("feed");

  return (
    <div className="space-y-4">
      {/* TikTok-style preview mode tabs */}
      <div className="flex justify-center">
        <div className="inline-flex bg-secondary/50 rounded-full p-1">
          <button
            onClick={() => setPreviewMode("feed")}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
              previewMode === "feed"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("postPreview.feed", "Feed")}
          </button>
          <button
            onClick={() => setPreviewMode("profile")}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
              previewMode === "profile"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("postPreview.profile", "Profile")}
          </button>
          <button
            onClick={() => setPreviewMode("webtv")}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
              previewMode === "webtv"
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("postPreview.webTv", "Web/TV")}
          </button>
        </div>
      </div>

      {/* Feed Preview - Full phone mockup */}
      {previewMode === "feed" && (
        <div className="max-w-[280px] mx-auto bg-black rounded-[2rem] overflow-hidden aspect-[9/16] relative border-4 border-gray-800">
          {/* Status bar */}
          <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-2 text-white text-xs">
            <span>8:00</span>
            <div className="flex items-center gap-1">
              <span>📶</span>
              <span>🔋</span>
            </div>
          </div>

          {/* Video/Image background */}
          {mediaFiles.length > 0 ? (
            mediaFiles[0].fileType === "video" ? (
              <video
                src={mediaFiles[0].previewUrl}
                className="absolute inset-0 w-full h-full object-cover"
                muted
                loop
                autoPlay
                playsInline
              />
            ) : (
              <img
                src={mediaFiles[0].previewUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
            )
          ) : (
            <div className="absolute inset-0 bg-gradient-to-b from-gray-800 to-gray-900" />
          )}

          {/* Top navigation */}
          <div className="absolute top-8 left-0 right-0 z-10 flex items-center justify-center gap-4 text-white/70">
            <span className="text-sm">{t("postPreview.following", "Following")}</span>
            <span className="text-sm font-semibold text-white border-b-2 border-white pb-0.5">{t("postPreview.forYou", "For You")}</span>
          </div>

          {/* Overlay gradient */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/80" />

          {/* Right side actions */}
          <div className="absolute right-3 bottom-24 flex flex-col items-center gap-4 z-10">
            <div className="relative">
              <Avatar className="h-11 w-11 border-2 border-white">
                {avatarUrl ? (
                  <AvatarImage src={avatarUrl} alt={username} />
                ) : null}
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">{username[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-5 h-5 bg-[#fe2c55] rounded-full flex items-center justify-center text-white text-xs">+</div>
            </div>
            <div className="flex flex-col items-center text-white">
              <Heart className="w-7 h-7" fill="white" />
              <span className="text-xs mt-0.5">0</span>
            </div>
            <div className="flex flex-col items-center text-white">
              <MessageCircle className="w-7 h-7" />
              <span className="text-xs mt-0.5">0</span>
            </div>
            <div className="flex flex-col items-center text-white">
              <Bookmark className="w-7 h-7" />
              <span className="text-xs mt-0.5">0</span>
            </div>
            <div className="flex flex-col items-center text-white">
              <Share2 className="w-7 h-7" />
              <span className="text-xs mt-0.5">{t("postPreview.share", "Share")}</span>
            </div>
          </div>

          {/* Bottom caption */}
          <div className="absolute bottom-16 left-3 right-16 text-white z-10">
            <p className="font-semibold text-sm">@{username}</p>
            {caption && (
              <p className="text-xs mt-1 line-clamp-2">{caption}</p>
            )}
            <div className="flex items-center gap-1 mt-2 text-xs opacity-80">
              <span>🎵</span>
              <span className="truncate">{t("postPreview.originalAudio", "Original sound - {{username}}", { username })}</span>
            </div>
          </div>

          {/* Bottom nav */}
          <div className="absolute bottom-0 left-0 right-0 bg-black/90 flex items-center justify-around py-2 z-10">
            <div className="flex flex-col items-center text-white">
              <span className="text-lg">🏠</span>
              <span className="text-[10px]">{t("postPreview.home", "Home")}</span>
            </div>
            <div className="flex flex-col items-center text-white/60">
              <span className="text-lg">👥</span>
              <span className="text-[10px]">{t("postPreview.friends", "Friends")}</span>
            </div>
            <div className="w-10 h-7 bg-white rounded-lg flex items-center justify-center">
              <span className="text-black font-bold text-lg">+</span>
            </div>
            <div className="flex flex-col items-center text-white/60">
              <span className="text-lg">📥</span>
              <span className="text-[10px]">{t("postPreview.inbox", "Inbox")}</span>
            </div>
            <div className="flex flex-col items-center text-white/60">
              <span className="text-lg">👤</span>
              <span className="text-[10px]">{t("postPreview.me", "Me")}</span>
            </div>
          </div>
        </div>
      )}

      {/* Profile Preview - Grid view */}
      {previewMode === "profile" && (
        <div className="max-w-[280px] mx-auto bg-white dark:bg-gray-900 rounded-[2rem] overflow-hidden aspect-[9/16] relative border-4 border-gray-200 dark:border-gray-800">
          {/* Status bar */}
          <div className="flex items-center justify-between px-4 py-2 text-foreground text-xs">
            <span>8:00</span>
            <div className="flex items-center gap-1">
              <span>📶</span>
              <span>🔋</span>
            </div>
          </div>

          {/* Back button */}
          <div className="px-4 py-2">
            <span className="text-lg">‹</span>
          </div>

          {/* Profile header */}
          <div className="flex flex-col items-center py-2">
            <Avatar className="h-16 w-16 border-2 border-[#fe2c55]">
              {avatarUrl ? (
                <AvatarImage src={avatarUrl} alt={username} />
              ) : null}
              <AvatarFallback className="bg-gradient-to-br from-[#00f2ea] to-[#ff0050] text-white">{username[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <p className="font-semibold text-sm mt-2">@{username}</p>
            <div className="flex gap-2 mt-2">
              <div className="bg-gray-200 dark:bg-gray-700 rounded-md h-6 w-16" />
              <div className="bg-gray-200 dark:bg-gray-700 rounded-md h-6 w-12" />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-around border-b border-gray-200 dark:border-gray-700 mt-3 px-8">
            <div className="flex-1 flex justify-center pb-2 border-b-2 border-foreground">
              <span className="text-sm">⊞</span>
            </div>
            <div className="flex-1 flex justify-center pb-2 text-muted-foreground">
              <span className="text-sm">↻</span>
            </div>
            <div className="flex-1 flex justify-center pb-2 text-muted-foreground">
              <span className="text-sm">♡</span>
            </div>
          </div>

          {/* Video grid */}
          <div className="grid grid-cols-3 gap-0.5 p-0.5">
            {/* First video - the one being posted */}
            <div className="aspect-[3/4] bg-gray-100 dark:bg-gray-800 relative overflow-hidden">
              {mediaFiles.length > 0 ? (
                mediaFiles[0].fileType === "video" ? (
                  <video
                    src={mediaFiles[0].previewUrl}
                    className="w-full h-full object-cover"
                    muted
                  />
                ) : (
                  <img
                    src={mediaFiles[0].previewUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                )
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-600" />
              )}
              <div className="absolute bottom-1 left-1 text-white text-[8px] flex items-center gap-0.5">
                <span>▶</span>
                <span>0</span>
              </div>
            </div>
            {/* Placeholder grid items */}
            {[...Array(8)].map((_, i) => (
              <div key={i} className="aspect-[3/4] bg-gray-200 dark:bg-gray-800" />
            ))}
          </div>
        </div>
      )}

      {/* Web/TV Preview */}
      {previewMode === "webtv" && (
        <div className="max-w-[400px] mx-auto">
          <div className="bg-black rounded-lg overflow-hidden aspect-[9/16] relative max-h-[360px]">
            {mediaFiles.length > 0 ? (
              mediaFiles[0].fileType === "video" ? (
                <video
                  src={mediaFiles[0].previewUrl}
                  className="w-full h-full object-cover"
                  muted
                  loop
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={mediaFiles[0].previewUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              )
            ) : (
              <div className="w-full h-full bg-gradient-to-b from-gray-800 to-gray-900" />
            )}

            {/* Overlay */}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/60" />

            {/* Right side actions */}
            <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-5">
              <Avatar className="h-10 w-10 border-2 border-white">
                {avatarUrl ? (
                  <AvatarImage src={avatarUrl} alt={username} />
                ) : null}
                <AvatarFallback className="bg-[#fe2c55] text-white text-xs">{username[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
              <Heart className="w-7 h-7 text-white" />
              <MessageCircle className="w-7 h-7 text-white" />
              <Bookmark className="w-7 h-7 text-white" />
              <Share2 className="w-7 h-7 text-white" />
            </div>

            {/* Caption overlay */}
            <div className="absolute bottom-4 left-4 right-16 text-white">
              <p className="font-bold text-sm">@{username}</p>
              <p className="text-xs mt-1 line-clamp-2 opacity-90">{caption}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GenericPreview({
  platform,
  caption,
  mediaFiles,
  username,
  avatarUrl,
}: {
  platform: Platform;
  caption: string;
  mediaFiles: PreviewMediaFile[];
  username: string;
  avatarUrl?: string;
}) {
  const firstMedia = mediaFiles[0];
  const hasUnsplashAttribution = firstMedia?.mediaSource === "unsplash" && 
    firstMedia.photographerName && 
    firstMedia.photographerUrl && 
    firstMedia.unsplashUrl;

  return (
    <div className="max-w-[400px] mx-auto bg-background border border-border rounded-lg p-4">
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={avatarUrl} />
          <AvatarFallback>{username[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{username}</span>
            <PlatformIcon platform={platform} size="xs" />
          </div>
          {caption && <p className="text-sm mt-1 whitespace-pre-wrap">{caption}</p>}
          {mediaFiles.length > 0 && (
            <div className="mt-3 rounded-lg overflow-hidden relative">
              {firstMedia.fileType === "image" ? (
                <img src={firstMedia.previewUrl} alt="" className="w-full rounded-lg" />
              ) : (
                <video src={firstMedia.previewUrl} className="w-full rounded-lg" controls muted />
              )}
              {/* Unsplash Attribution Overlay */}
              {hasUnsplashAttribution && (
                <UnsplashAttribution
                  photographerName={firstMedia.photographerName!}
                  photographerUrl={firstMedia.photographerUrl!}
                  unsplashUrl={firstMedia.unsplashUrl!}
                  variant="overlay"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
