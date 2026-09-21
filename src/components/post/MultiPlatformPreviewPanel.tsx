import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { Eye, Maximize2, Grid3X3 } from "lucide-react";
import { TwitterPostPreview } from "./TwitterPostPreview";
import { InstagramCarouselPreview } from "./InstagramCarouselPreview";
import { InstagramReelsPreview } from "./InstagramReelsPreview";
import { FacebookReelsPreview } from "./FacebookReelsPreview";
import { TikTokVideoPreview } from "./TikTokVideoPreview";
import { LinkedInPostPreview } from "./LinkedInPostPreview";
import { PinterestPinPreview } from "./PinterestPinPreview";
import { RedditPostPreview } from "./RedditPostPreview";
import { ThreadsPostPreview } from "./ThreadsPostPreview";
import { BlueskyPostPreview } from "./BlueskyPostPreview";
import { YouTubeShortsPreview } from "./YouTubeShortsPreview";

interface MediaFile {
  previewUrl: string;
  fileType: "image" | "video";
}

interface ConnectedAccount {
  id: string;
  platform: Platform;
  platform_username: string | null;
  avatar_url: string | null;
  account_metadata?: Record<string, unknown>;
}

interface MultiPlatformPreviewPanelProps {
  caption: string;
  files: MediaFile[];
  selectedPlatforms: Platform[];
  selectedAccountIds: string[];
  connectedAccounts: ConnectedAccount[];
  platformSettings: {
    // Instagram
    instagramPostTypes?: string[];
    // TikTok
    tiktokTitle?: string;
    // LinkedIn
    linkedinVisibility?: string;
    // Pinterest
    pinterestTitle?: string;
    pinterestLink?: string;
    selectedPinterestBoard?: { name: string };
    // Reddit
    redditTitle?: string;
    redditSubreddit?: string;
    redditPostType?: string;
    redditSpoiler?: boolean;
    redditNsfw?: boolean;
    // Threads
    threadsReplyControl?: "everyone" | "followers" | "following" | "mentioned";
    threadsTopicTag?: string;
    threadsLocationName?: string;
    // Bluesky
    blueskyEmbedLink?: string;
    blueskyEmbedEnabled?: boolean;
    // YouTube
    youtubeTitle?: string;
    youtubeDescription?: string;
    youtubeVideoType?: string;
  };
}

const PLATFORM_ORDER: Platform[] = [
  "instagram",
  "facebook",
  "twitter",
  "tiktok",
  "linkedin",
  "youtube",
  "pinterest",
  "threads",
  "bluesky",
  "reddit",
];

export function MultiPlatformPreviewPanel({
  caption,
  files,
  selectedPlatforms,
  selectedAccountIds,
  connectedAccounts,
  platformSettings,
}: MultiPlatformPreviewPanelProps) {
  const { t } = useTranslation("postpreview");
  const [isOpen, setIsOpen] = useState(false);

  const getAccountForPlatform = (platform: Platform) =>
    connectedAccounts.find(a => a.platform === platform && selectedAccountIds.includes(a.id));

  const hasVideo = files.some(f => f.fileType === "video");
  const orderedPlatforms = PLATFORM_ORDER.filter(p => selectedPlatforms.includes(p));

  const renderPreview = (platform: Platform) => {
    const account = getAccountForPlatform(platform);
    const username = account?.platform_username || "your_account";
    const avatarUrl = account?.avatar_url || undefined;

    switch (platform) {
      case "instagram":
        if (platformSettings.instagramPostTypes?.includes("reel") && hasVideo) {
          return (
            <InstagramReelsPreview
              caption={caption}
              mediaFile={files.find(f => f.fileType === "video")}
              username={username}
              avatarUrl={avatarUrl}
            />
          );
        }
        return (
          <InstagramCarouselPreview
            caption={caption}
            mediaFiles={files}
            username={username}
            avatarUrl={avatarUrl}
          />
        );

      case "facebook":
        if (hasVideo) {
          return (
            <FacebookReelsPreview
              caption={caption}
              mediaFile={files.find(f => f.fileType === "video")}
              username={username}
              avatarUrl={avatarUrl}
            />
          );
        }
        return null;

      case "twitter":
        return (
          <TwitterPostPreview
            caption={caption}
            mediaFile={files[0]}
            username={username}
            avatarUrl={avatarUrl}
            displayName={username}
          />
        );

      case "tiktok":
        if (hasVideo) {
          return (
            <TikTokVideoPreview
              caption={caption}
              mediaFile={files.find(f => f.fileType === "video")}
              username={username}
              avatarUrl={avatarUrl}
              soundName={platformSettings.tiktokTitle || undefined}
            />
          );
        }
        return null;

      case "linkedin":
        return (
          <LinkedInPostPreview
            caption={caption}
            mediaFile={files[0]}
            username={username}
            avatarUrl={avatarUrl}
            visibility={platformSettings.linkedinVisibility as any}
          />
        );

      case "youtube":
        if (platformSettings.youtubeVideoType === "short" && hasVideo) {
          return (
            <YouTubeShortsPreview
              title={platformSettings.youtubeTitle || caption}
              description={platformSettings.youtubeDescription}
              mediaFile={files.find(f => f.fileType === "video")}
              username={username}
              avatarUrl={avatarUrl}
            />
          );
        }
        return null;

      case "pinterest":
        return (
          <PinterestPinPreview
            caption={caption}
            mediaFile={files[0]}
            title={platformSettings.pinterestTitle}
            link={platformSettings.pinterestLink}
            boardName={platformSettings.selectedPinterestBoard?.name}
            username={username}
            avatarUrl={avatarUrl}
          />
        );

      case "threads":
        return (
          <ThreadsPostPreview
            caption={caption}
            mediaFile={files[0]}
            username={username}
            avatarUrl={avatarUrl}
            replyControl={platformSettings.threadsReplyControl}
            topicTag={platformSettings.threadsTopicTag}
            locationName={platformSettings.threadsLocationName}
          />
        );

      case "bluesky":
        return (
          <BlueskyPostPreview
            caption={caption}
            mediaFile={files[0]}
            username={username}
            avatarUrl={avatarUrl}
            embedLink={platformSettings.blueskyEmbedLink}
            embedEnabled={platformSettings.blueskyEmbedEnabled}
          />
        );

      case "reddit":
        return (
          <RedditPostPreview
            caption={caption}
            mediaFile={files[0]}
            title={platformSettings.redditTitle}
            subreddit={platformSettings.redditSubreddit}
            username={username}
            avatarUrl={avatarUrl}
            postType={platformSettings.redditPostType as any}
            spoiler={platformSettings.redditSpoiler}
            nsfw={platformSettings.redditNsfw}
          />
        );

      default:
        return null;
    }
  };

  if (selectedPlatforms.length === 0) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Grid3X3 className="w-4 h-4" />
          <span className="hidden sm:inline">{t("multiPlatform.button", "Multi-Platform Preview")}</span>
          <span className="sm:hidden">{t("multiPlatform.previewAll", "Preview All")}</span>
          <Badge variant="secondary" className="ms-1">
            {selectedPlatforms.length}
          </Badge>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] p-0">
        <DialogHeader className="p-6 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5" />
            {t("multiPlatform.title", "Multi-Platform Preview")}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("multiPlatform.description", "Compare how your post will look across {{count}} platforms", { count: selectedPlatforms.length })}
          </p>
        </DialogHeader>

        <Tabs defaultValue={orderedPlatforms[0]} className="w-full">
          <div className="px-6 border-b">
            <ScrollArea className="w-full">
              <TabsList className="inline-flex h-12 gap-1 bg-transparent p-0">
                {orderedPlatforms.map((platform) => (
                  <TabsTrigger
                    key={platform}
                    value={platform}
                    className="flex items-center gap-2 px-4 py-2 data-[state=active]:bg-muted rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary"
                  >
                    <PlatformIcon platform={platform} size="sm" />
                    <span className="capitalize hidden sm:inline">{platform}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>

          <ScrollArea className="h-[60vh]">
            <div className="p-6">
              {orderedPlatforms.map((platform) => (
                <TabsContent key={platform} value={platform} className="mt-0">
                  <div className="flex justify-center">
                    <div className="w-full max-w-lg">
                      {renderPreview(platform) || (
                        <div className="text-center py-12 text-muted-foreground">
                          <p>{t("multiPlatform.notAvailable", "Preview not available for this content type on {{platform}}", { platform })}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>
              ))}
            </div>
          </ScrollArea>
        </Tabs>

        {/* Side-by-side comparison for 2-3 platforms */}
        {orderedPlatforms.length >= 2 && orderedPlatforms.length <= 3 && (
          <div className="px-6 pb-6 border-t pt-4">
            <div className="flex items-center gap-2 mb-4">
              <Maximize2 className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">{t("multiPlatform.sideBySide", "Side-by-Side Comparison")}</span>
            </div>
            <ScrollArea className="w-full">
              <div className={`grid gap-4 ${orderedPlatforms.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {orderedPlatforms.slice(0, 3).map((platform) => (
                  <div key={platform} className="min-w-[300px]">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                      <PlatformIcon platform={platform} size="sm" />
                      <span className="font-medium capitalize">{platform}</span>
                    </div>
                    <div className="transform scale-90 origin-top">
                      {renderPreview(platform)}
                    </div>
                  </div>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
