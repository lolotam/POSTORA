import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Platform } from "@/lib/types";
import { PlatformChip } from "@/components/post/PlatformChip";
import { LinkedInDestinationStack } from "@/components/post/LinkedInDestinationStack";
import {
  InstagramSettings,
  FacebookSettings,
  LinkedInSettings,
  TwitterSettings,
  PinterestSettings,
  TikTokSettings,
  YouTubeSettings,
  ThreadsSettings,
  BlueskySettings,
  RedditSettings,
} from "@/components/post/settings";
import { TikTokSettingsState } from "@/components/post/settings/TikTokSettings";
import { YouTubeSettingsState } from "@/components/post/settings/YouTubeSettings";
import { TikTokPreCheck } from "./TikTokPreCheck";
import { YouTubeShortsPreview } from "./YouTubeShortsPreview";
import { FacebookReelsPreview } from "./FacebookReelsPreview";
import { InstagramCarouselPreview } from "./InstagramCarouselPreview";
import { InstagramReelsPreview } from "./InstagramReelsPreview";
import { TwitterPostPreview } from "./TwitterPostPreview";
import { TikTokVideoPreview } from "./TikTokVideoPreview";
import { LinkedInPostPreview } from "./LinkedInPostPreview";
import { PinterestPinPreview } from "./PinterestPinPreview";
import { RedditPostPreview } from "./RedditPostPreview";
import { ThreadsPostPreview } from "./ThreadsPostPreview";
import { BlueskyPostPreview } from "./BlueskyPostPreview";

interface MediaFile {
  id?: string;
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  file?: File;
  storagePath?: string;
  uploaded?: boolean;
  altText?: string;
  cloudinaryUrl?: string;
}

interface ConnectedAccount {
  id: string;
  platform: Platform;
  platform_username: string | null;
  platform_user_id: string;
  avatar_url: string | null;
  account_metadata?: Record<string, unknown>;
}

interface PlatformSettingsSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  uploadMethod: string;
  files: MediaFile[];
  caption: string;
  setCaption: (caption: string) => void;
  hasVideo: boolean;
  hasOnlyImages: boolean;
  selectedPlatforms: Platform[];
  selectedAccountIds: string[];
  connectedAccounts: ConnectedAccount[];
  platformSettings: any;
  tiktokSettingsState: TikTokSettingsState;
  onTiktokSettingsChange: (changes: Partial<TikTokSettingsState>) => void;
  youtubeSettingsState: YouTubeSettingsState;
  onYoutubeSettingsChange: (changes: Partial<YouTubeSettingsState>) => void;
  youtubeThumbnails: {
    generateAutoThumbnails: () => Promise<void> | void;
    generateAiThumbnail: (prompt: string, model: string, size: string, refImage?: string) => Promise<void> | void;
    downloadThumbnail: (url: string, filename: string) => void;
  };
  musicCopyright: {
    isChecking: boolean;
    result: any;
    checkMusicCopyright: (url: string) => Promise<any>;
  };
  isPosting: boolean;
  scheduleEnabled: boolean;
  toast: (opts: any) => void;
  supabase: any;
  flags?: {
    tiktokPreCheck?: boolean;
    threadsShareToIg?: boolean;
  };
  onPost?: () => void;
  ineligiblePlatforms?: Platform[];
  hiddenPlatforms?: Platform[];
}

export function PlatformSettingsSection({
  isOpen,
  onOpenChange,
  uploadMethod,
  files,
  caption,
  setCaption,
  hasVideo,
  hasOnlyImages,
  selectedPlatforms,
  selectedAccountIds,
  connectedAccounts,
  platformSettings,
  tiktokSettingsState,
  onTiktokSettingsChange,
  youtubeSettingsState,
  onYoutubeSettingsChange,
  youtubeThumbnails,
  musicCopyright,
  isPosting,
  scheduleEnabled,
  toast,
  supabase,
  flags,
  onPost,
  ineligiblePlatforms = [],
  hiddenPlatforms = [],
}: PlatformSettingsSectionProps) {
  const isPlatformEligible = (platform: Platform) => !ineligiblePlatforms.includes(platform);
  const isPlatformVisible = (platform: Platform) => !hiddenPlatforms.includes(platform);
  const hasPlatformSelected = (platform: Platform) =>
    connectedAccounts.some(a => a.platform === platform && selectedAccountIds.includes(a.id));
  const selectedTikTokAccounts = connectedAccounts.filter(
    a => a.platform === "tiktok" && selectedAccountIds.includes(a.id)
  );

  // Determine the first platform that has a selected account for default tab
  const allPlatformOrder: Platform[] = ["instagram", "tiktok", "facebook", "twitter", "linkedin", "youtube", "pinterest", "threads", "bluesky", "reddit"];
  const firstSelectedPlatform = allPlatformOrder.find(p => hasPlatformSelected(p) && isPlatformEligible(p) && isPlatformVisible(p)) || "facebook";
  const hasAnyPlatformSelected = allPlatformOrder.some(p => hasPlatformSelected(p) && isPlatformEligible(p) && isPlatformVisible(p));

  // Helper to get all selected accounts for a platform
  const getSelectedAccountsForPlatform = (platform: Platform) => 
    connectedAccounts
      .filter(a => a.platform === platform && selectedAccountIds.includes(a.id))
      .map(a => ({
        id: a.id,
        platform_username: a.platform_username,
        avatar_url: a.avatar_url,
        platform_user_id: a.platform_user_id,
      }));

  const getAccountForPlatform = (platform: Platform) =>
    connectedAccounts.find(a => a.platform === platform && selectedAccountIds.includes(a.id));

  // Platforms that require media (hidden in text-only mode)
  const mediaRequiredPlatforms: Platform[] = ["instagram", "tiktok", "youtube", "pinterest"];
  const visiblePlatforms = allPlatformOrder.filter((p) => {
    if (uploadMethod === "text" && mediaRequiredPlatforms.includes(p)) return false;
    return isPlatformEligible(p) && isPlatformVisible(p) && hasPlatformSelected(p);
  });

  // LinkedIn: build the destination avatar stack rendered under the chip
  const linkedinPagesAvailable = connectedAccounts
    .filter((a) => a.platform === "linkedin" && selectedAccountIds.includes(a.id))
    .flatMap(
      (a) =>
        (a.account_metadata as { linkedin_pages?: Array<{ id: string; name: string; vanityName?: string; logoUrl?: string }> })
          ?.linkedin_pages || []
    );
  const linkedinPrimaryAccount = getAccountForPlatform("linkedin");
  const linkedinDestinations = (platformSettings.linkedinSelectedDestinationIds as string[] | undefined ?? ["personal"]).map((id) => {
    if (id === "personal") {
      return {
        id: "personal",
        name: linkedinPrimaryAccount?.platform_username || "Personal Profile",
        avatarUrl: linkedinPrimaryAccount?.avatar_url ?? undefined,
        isPersonal: true,
      };
    }
    const page = linkedinPagesAvailable.find((p) => p.id === id);
    return {
      id,
      name: page?.name || id,
      avatarUrl: page?.logoUrl,
      isPersonal: false,
    };
  });

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <div className="rounded-xl border border-border bg-card/50">
        <CollapsibleTrigger className="w-full p-4 sm:p-6 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-left">Platform-specific settings</h3>
            <p className="text-xs text-muted-foreground text-left">Adjust requirements for each platform</p>
          </div>
          <ChevronDown className={cn("w-5 h-5 transition-transform", isOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
            {uploadMethod === "text" && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-700 dark:text-amber-300 mb-2">
                <strong>Text-Only Mode:</strong> Instagram, TikTok, Pinterest, and YouTube require media and are hidden.
              </div>
            )}

            <Tabs defaultValue={firstSelectedPlatform} key={firstSelectedPlatform} className="w-full">
              {!hasAnyPlatformSelected ? (
                <div className="p-6 text-center text-muted-foreground text-sm">
                  Select accounts in Step 2 to configure platform-specific settings.
                </div>
              ) : (
              <>
              <TabsList className="flex flex-wrap justify-start sm:justify-center items-start gap-3 sm:gap-4 h-auto p-2 bg-transparent">
                {visiblePlatforms.map((p) => (
                  <PlatformChip key={p} platform={p} value={p}>
                    {p === "linkedin" && linkedinDestinations.length > 0 && (
                      <LinkedInDestinationStack destinations={linkedinDestinations} />
                    )}
                  </PlatformChip>
                ))}
              </TabsList>

              {isPlatformEligible("instagram") && isPlatformVisible("instagram") && hasPlatformSelected("instagram") && <TabsContent value="instagram" className="mt-4 space-y-6">
                <InstagramSettings
                  postTypes={platformSettings.instagramPostTypes}
                  setPostTypes={platformSettings.setInstagramPostTypes}
                  location={platformSettings.postLocation}
                  setLocation={platformSettings.setPostLocation}
                  firstComment={platformSettings.firstComment}
                  setFirstComment={platformSettings.setFirstComment}
                  collaborator={platformSettings.instagramCollaborator}
                  setCollaborator={platformSettings.setInstagramCollaborator}
                  hasVideo={hasVideo}
                  shareToFeed={platformSettings.instagramShareToFeed}
                  setShareToFeed={platformSettings.setInstagramShareToFeed}
                  coverThumbnailOffset={platformSettings.instagramCoverThumbnailOffset}
                  setCoverThumbnailOffset={platformSettings.setInstagramCoverThumbnailOffset}
                  audioName={platformSettings.instagramAudioName}
                  setAudioName={platformSettings.setInstagramAudioName}
                  altText={platformSettings.instagramAltText}
                  setAltText={platformSettings.setInstagramAltText}
                  hideLikeCounts={platformSettings.instagramHideLikeCounts}
                  setHideLikeCounts={platformSettings.setInstagramHideLikeCounts}
                   disableComments={platformSettings.instagramDisableComments}
                   setDisableComments={platformSettings.setInstagramDisableComments}
                   selectedAccounts={getSelectedAccountsForPlatform("instagram")}
                   locationId={platformSettings.instagramLocationId}
                   setLocationId={platformSettings.setInstagramLocationId}
                   locationName={platformSettings.instagramLocationName}
                   setLocationName={platformSettings.setInstagramLocationName}
                   selectedAccountId={getSelectedAccountsForPlatform("instagram")[0]?.id}
                   shareToStory={platformSettings.instagramShareToStory}
                   setShareToStory={platformSettings.setInstagramShareToStory}
                   onSelectPlace={(place) => {
                     if (!place || !place.id) {
                       platformSettings.setInstagramLocationObject(null);
                     } else {
                       platformSettings.setInstagramLocationObject(place);
                     }
                   }}
                 />
                
                {/* Carousel Preview */}
                {files.length > 1 && platformSettings.instagramPostTypes.includes("feed") && (
                  <InstagramCarouselPreview
                    caption={caption}
                    mediaFiles={files.map(f => ({ previewUrl: f.previewUrl, fileType: f.fileType }))}
                    username={getAccountForPlatform("instagram")?.platform_username || "your_account"}
                    avatarUrl={getAccountForPlatform("instagram")?.avatar_url || undefined}
                  />
                )}

                {/* Reels Preview */}
                {platformSettings.instagramPostTypes.includes("reel") && hasVideo && (
                  <InstagramReelsPreview
                    caption={caption}
                    mediaFile={files.find(f => f.fileType === "video") ? { previewUrl: files.find(f => f.fileType === "video")!.previewUrl, fileType: "video" } : undefined}
                    username={getAccountForPlatform("instagram")?.platform_username || "your_account"}
                    avatarUrl={getAccountForPlatform("instagram")?.avatar_url || undefined}
                  />
                )}
              </TabsContent>}

              {isPlatformEligible("tiktok") && isPlatformVisible("tiktok") && hasPlatformSelected("tiktok") && <TabsContent value="tiktok" className="mt-4">
                {flags?.tiktokPreCheck && hasVideo && files.find(f => f.fileType === "video") && (
                  <TikTokPreCheck
                    file={files.find(f => f.fileType === "video")?.file || null}
                    previewUrl={files.find(f => f.fileType === "video")?.cloudinaryUrl || files.find(f => f.fileType === "video")?.previewUrl || null}
                    mediaFileId={files.find(f => f.fileType === "video")?.storagePath || null}
                    isFileUploaded={!!files.find(f => f.fileType === "video")?.uploaded}
                    maxVideoDurationSec={platformSettings.tiktokCreatorInfo?.max_video_post_duration_sec}
                    onTranscodeComplete={(newMediaId) => {
                      platformSettings.setTiktokTranscodedMediaId(newMediaId);
                      platformSettings.setTiktokPreCheckPassed(true);
                    }}
                  />
                )}
                <TikTokSettings
                  settings={tiktokSettingsState}
                  onSettingsChange={onTiktokSettingsChange}
                  creatorInfo={platformSettings.tiktokCreatorInfo}
                  loadingCreatorInfo={platformSettings.loadingCreatorInfo}
                  hasVideo={hasVideo}
                  hasOnlyImages={hasOnlyImages}
                  isCheckingMusic={musicCopyright.isChecking}
                  musicCopyrightResult={musicCopyright.result}
                  onRunMusicCheck={async () => {
                    // Find video file - for stock videos, check if uploaded is true
                    const videoFile = files.find(f => f.fileType === "video" && f.uploaded);
                    
                    if (!videoFile) {
                      console.error('[MusicCheck] No uploaded video file found');
                      toast({
                        title: "No video available",
                        description: "Please wait for the video to finish uploading.",
                        variant: "destructive",
                      });
                      return;
                    }

                    console.log('[MusicCheck] Video file found:', {
                      id: videoFile.id,
                      storagePath: videoFile.storagePath,
                      cloudinaryUrl: videoFile.cloudinaryUrl?.slice(0, 60),
                      previewUrl: videoFile.previewUrl?.slice(0, 60),
                    });

                    // Priority order for getting video URL:
                    // 1. Database lookup via storagePath
                    // 2. cloudinaryUrl (set during upload)
                    // 3. previewUrl (for stock videos, this contains the video URL)
                    
                    let videoUrl: string | null = null;
                    
                    if (videoFile.storagePath) {
                      const { data: fileData, error } = await supabase
                        .from('media_files')
                        .select('file_path')
                        .eq('id', videoFile.storagePath)
                        .single();

                      if (fileData?.file_path) {
                        videoUrl = fileData.file_path;
                        console.log('[MusicCheck] Using database file_path:', videoUrl?.slice(0, 80));
                      } else {
                        console.warn('[MusicCheck] Database lookup failed:', error);
                      }
                    }
                    
                    // Fallback to cloudinaryUrl
                    if (!videoUrl && videoFile.cloudinaryUrl) {
                      videoUrl = videoFile.cloudinaryUrl;
                      console.log('[MusicCheck] Using cloudinaryUrl:', videoUrl?.slice(0, 80));
                    }
                    
                    // Final fallback to previewUrl (stock videos have direct URL here)
                    if (!videoUrl && videoFile.previewUrl && videoFile.previewUrl.startsWith('http')) {
                      videoUrl = videoFile.previewUrl;
                      console.log('[MusicCheck] Using previewUrl:', videoUrl?.slice(0, 80));
                    }
                    
                    if (videoUrl) {
                      await musicCopyright.checkMusicCopyright(videoUrl);
                    } else {
                      console.error('[MusicCheck] No video URL available');
                      toast({
                        title: "Cannot check copyright",
                        description: "Unable to find video URL for copyright check.",
                        variant: "destructive",
                      });
                    }
                  }}
                  canRunMusicCheck={files.some(f => f.fileType === "video" && f.uploaded)}
                  selectedAccounts={selectedTikTokAccounts.map(a => ({
                    id: a.id,
                    platform_username: a.platform_username,
                    avatar_url: a.avatar_url,
                    tiktok_username: (a.account_metadata as { tiktok_username?: string } | null)?.tiktok_username || null,
                  }))}
                  hasDraft={platformSettings.hasTiktokDraft}
                  onLoadDraft={() => {
                    const draft = platformSettings.loadTiktokDraft();
                    if (draft?.caption) setCaption(draft.caption);
                    toast({ title: "Draft loaded", description: "Your TikTok draft has been restored." });
                  }}
                  onSaveDraft={() => {
                    platformSettings.saveTiktokDraft(caption, selectedPlatforms);
                    toast({ title: "Draft saved", description: "Your TikTok post has been saved." });
                  }}
                  onDiscard={() => {
                    platformSettings.resetTiktokSettings();
                    toast({ title: "Discarded", description: "TikTok settings have been reset." });
                  }}
                  isPosting={isPosting}
                  scheduleEnabled={scheduleEnabled}
                  mediaFiles={files.map(f => ({
                    previewUrl: f.previewUrl,
                    fileType: f.fileType,
                    file: f.file,
                    fileName: f.file?.name,
                  }))}
                  caption={caption}
                  onUpload={onPost}
                />
              </TabsContent>}

              {isPlatformEligible("facebook") && isPlatformVisible("facebook") && hasPlatformSelected("facebook") && <TabsContent value="facebook" className="mt-4 space-y-6">
                <FacebookSettings
                  postTypes={platformSettings.facebookPostTypes}
                  setPostTypes={platformSettings.setFacebookPostTypes}
                  location={platformSettings.facebookLocation}
                  setLocation={platformSettings.setFacebookLocation}
                  firstComment={platformSettings.facebookFirstComment}
                  setFirstComment={platformSettings.setFacebookFirstComment}
                  link={platformSettings.facebookLink}
                  setLink={platformSettings.setFacebookLink}
                  shareToStory={platformSettings.facebookShareToStory}
                  setShareToStory={platformSettings.setFacebookShareToStory}
                  hasVideo={hasVideo}
                  selectedAccounts={getSelectedAccountsForPlatform("facebook")}
                  reelDescription={platformSettings.facebookReelDescription}
                  setReelDescription={platformSettings.setFacebookReelDescription}
                  tags={platformSettings.facebookTags}
                  setTags={platformSettings.setFacebookTags}
                  locationId={platformSettings.facebookLocationId}
                  setLocationId={platformSettings.setFacebookLocationId}
                  locationName={platformSettings.facebookLocationName}
                  setLocationName={platformSettings.setFacebookLocationName}
                  accountId={getSelectedAccountsForPlatform("facebook")[0]?.id}
                  reelCollaborator={platformSettings.facebookReelCollaborator}
                  setReelCollaborator={platformSettings.setFacebookReelCollaborator}
                  onSelectPlace={(place) => {
                    if (!place || !place.id) {
                      platformSettings.setFacebookLocationObject(null);
                    } else {
                      platformSettings.setFacebookLocationObject(place);
                    }
                  }}
                />
                
                {platformSettings.facebookPostTypes.includes("reel") && hasVideo && (
                  <FacebookReelsPreview
                    caption={caption}
                    mediaFile={files.find(f => f.fileType === "video") ? { previewUrl: files.find(f => f.fileType === "video")!.previewUrl, fileType: "video" } : undefined}
                    username={getAccountForPlatform("facebook")?.platform_username || "Your Page"}
                    avatarUrl={getAccountForPlatform("facebook")?.avatar_url || undefined}
                  />
                )}
              </TabsContent>}

              {isPlatformEligible("twitter") && isPlatformVisible("twitter") && hasPlatformSelected("twitter") && <TabsContent value="twitter" className="mt-4">
                <TwitterSettings
                  settings={{
                    threadMode: platformSettings.twitterThreadMode,
                    postAsLongTweet: platformSettings.twitterPostAsLongTweet,
                    customTitle: platformSettings.twitterCustomTitle,
                    replySettings: platformSettings.twitterReplySettings,
                    forSuperFollowersOnly: platformSettings.twitterForSuperFollowersOnly,
                    shareWithFollowers: platformSettings.twitterShareWithFollowers,
                    replyToTweetId: platformSettings.twitterReplyToTweetId,
                    quoteTweetUrl: platformSettings.twitterQuoteTweetUrl,
                    taggedUserIds: platformSettings.twitterTaggedUserIds,
                    excludeReplyUserIds: platformSettings.twitterExcludeReplyUserIds,
                    placeId: platformSettings.twitterPlaceId,
                    communityId: platformSettings.twitterCommunityId,
                    dmDeepLink: platformSettings.twitterDmDeepLink,
                    nullcast: platformSettings.twitterNullcast,
                    thumbnailUrl: platformSettings.twitterThumbnailUrl,
                    thumbnailFile: platformSettings.twitterThumbnailFile,
                    pollEnabled: platformSettings.twitterPollEnabled,
                    pollOptions: platformSettings.twitterPollOptions,
                    pollDuration: platformSettings.twitterPollDuration,
                  }}
                  onChange={(changes) => {
                    if (changes.threadMode !== undefined) platformSettings.setTwitterThreadMode(changes.threadMode);
                    if (changes.postAsLongTweet !== undefined) platformSettings.setTwitterPostAsLongTweet(changes.postAsLongTweet);
                    if (changes.customTitle !== undefined) platformSettings.setTwitterCustomTitle(changes.customTitle);
                    if (changes.replySettings !== undefined) platformSettings.setTwitterReplySettings(changes.replySettings);
                    if (changes.forSuperFollowersOnly !== undefined) platformSettings.setTwitterForSuperFollowersOnly(changes.forSuperFollowersOnly);
                    if (changes.shareWithFollowers !== undefined) platformSettings.setTwitterShareWithFollowers(changes.shareWithFollowers);
                    if (changes.replyToTweetId !== undefined) platformSettings.setTwitterReplyToTweetId(changes.replyToTweetId);
                    if (changes.quoteTweetUrl !== undefined) platformSettings.setTwitterQuoteTweetUrl(changes.quoteTweetUrl);
                    if (changes.taggedUserIds !== undefined) platformSettings.setTwitterTaggedUserIds(changes.taggedUserIds);
                    if (changes.excludeReplyUserIds !== undefined) platformSettings.setTwitterExcludeReplyUserIds(changes.excludeReplyUserIds);
                    if (changes.placeId !== undefined) platformSettings.setTwitterPlaceId(changes.placeId);
                    if (changes.communityId !== undefined) platformSettings.setTwitterCommunityId(changes.communityId);
                    if (changes.dmDeepLink !== undefined) platformSettings.setTwitterDmDeepLink(changes.dmDeepLink);
                    if (changes.nullcast !== undefined) platformSettings.setTwitterNullcast(changes.nullcast);
                    if (changes.thumbnailUrl !== undefined) platformSettings.setTwitterThumbnailUrl(changes.thumbnailUrl);
                    if (changes.thumbnailFile !== undefined) platformSettings.setTwitterThumbnailFile(changes.thumbnailFile);
                    if (changes.pollEnabled !== undefined) platformSettings.setTwitterPollEnabled(changes.pollEnabled);
                    if (changes.pollOptions !== undefined) platformSettings.setTwitterPollOptions(changes.pollOptions);
                    if (changes.pollDuration !== undefined) platformSettings.setTwitterPollDuration(changes.pollDuration);
                  }}
                  caption={caption}
                  selectedAccounts={getSelectedAccountsForPlatform("twitter")}
                />
                
                {/* Twitter Post Preview */}
                {(caption || files.length > 0) && (
                  <div className="mt-6 border-t pt-4">
                    <TwitterPostPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      username={getAccountForPlatform("twitter")?.platform_username || "your_handle"}
                      avatarUrl={getAccountForPlatform("twitter")?.avatar_url || undefined}
                      displayName={getAccountForPlatform("twitter")?.platform_username || undefined}
                    />
                  </div>
                )}
              </TabsContent>}

              {isPlatformEligible("linkedin") && isPlatformVisible("linkedin") && hasPlatformSelected("linkedin") && <TabsContent value="linkedin" className="mt-4 space-y-6">
                <LinkedInSettings
                  visibility={platformSettings.linkedinVisibility}
                  setVisibility={platformSettings.setLinkedinVisibility}
                  linkedInTitle={platformSettings.linkedinTitle}
                  setLinkedInTitle={platformSettings.setLinkedinTitle}
                  linkedInDescription={platformSettings.linkedinDescription}
                  setLinkedInDescription={platformSettings.setLinkedinDescription}
                  selectedDestinationIds={platformSettings.linkedinSelectedDestinationIds}
                  setSelectedDestinationIds={platformSettings.setLinkedinSelectedDestinationIds}
                  availablePages={
                    connectedAccounts
                      .filter(a => a.platform === "linkedin" && selectedAccountIds.includes(a.id))
                      .flatMap(a => (a.account_metadata as { linkedin_pages?: Array<{ id: string; name: string; vanityName?: string; logoUrl?: string }> })?.linkedin_pages || [])
                  }
                  selectedAccounts={getSelectedAccountsForPlatform("linkedin")}
                />
                
                {/* LinkedIn Post Preview */}
                {(caption || files.length > 0) && (
                  <div className="border-t pt-4">
                    <LinkedInPostPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      username={getAccountForPlatform("linkedin")?.platform_username || "Your Name"}
                      avatarUrl={getAccountForPlatform("linkedin")?.avatar_url || undefined}
                      headline={(getAccountForPlatform("linkedin")?.account_metadata as { headline?: string })?.headline || "Professional"}
                      visibility={platformSettings.linkedinVisibility}
                    />
                  </div>
                )}
              </TabsContent>}

              {isPlatformEligible("youtube") && isPlatformVisible("youtube") && hasPlatformSelected("youtube") && <TabsContent value="youtube" className="mt-4 space-y-6">
                <YouTubeSettings
                  settings={youtubeSettingsState}
                  onSettingsChange={onYoutubeSettingsChange}
                  hasVideo={hasVideo}
                  autoThumbnails={platformSettings.youtubeAutoThumbnails}
                  selectedAutoThumbnail={platformSettings.youtubeSelectedAutoThumbnail}
                  onSelectAutoThumbnail={platformSettings.setYoutubeSelectedAutoThumbnail}
                  onGenerateAutoThumbnails={async () => { youtubeThumbnails.generateAutoThumbnails(); }}
                  aiGeneratedThumbnails={platformSettings.youtubeAiGeneratedThumbnails}
                  onGenerateAiThumbnail={async (prompt: string, model: string, size: string, refImage?: string) => { youtubeThumbnails.generateAiThumbnail(prompt, model, size, refImage); }}
                  isGeneratingAiThumbnail={platformSettings.youtubeGeneratingAiThumbnail}
                  onDownloadThumbnail={youtubeThumbnails.downloadThumbnail}
                  selectedAccounts={getSelectedAccountsForPlatform("youtube")}
                />
                
                {youtubeSettingsState.videoType === "short" && hasVideo && (
                  <YouTubeShortsPreview
                    title={youtubeSettingsState.title || caption}
                    description={youtubeSettingsState.description}
                    mediaFile={files.find(f => f.fileType === "video") ? { previewUrl: files.find(f => f.fileType === "video")!.previewUrl, fileType: "video" } : undefined}
                    username={getAccountForPlatform("youtube")?.platform_username || "Your Channel"}
                    avatarUrl={getAccountForPlatform("youtube")?.avatar_url || undefined}
                  />
                )}
              </TabsContent>}

              {isPlatformEligible("pinterest") && isPlatformVisible("pinterest") && hasPlatformSelected("pinterest") && <TabsContent value="pinterest" className="mt-4 space-y-6">
                <PinterestSettings
                  boards={platformSettings.pinterestBoards}
                  selectedBoard={platformSettings.selectedPinterestBoard}
                  setSelectedBoard={platformSettings.setSelectedPinterestBoard}
                  loadingBoards={platformSettings.loadingPinterestBoards}
                  refreshBoards={platformSettings.refreshPinterestBoards}
                  title={platformSettings.pinterestTitle}
                  setTitle={platformSettings.setPinterestTitle}
                  link={platformSettings.pinterestLink}
                  setLink={platformSettings.setPinterestLink}
                  altText={platformSettings.pinterestAltText}
                  setAltText={platformSettings.setPinterestAltText}
                  note={platformSettings.pinterestNote}
                  setNote={platformSettings.setPinterestNote}
                  mediaCount={files.length}
                  selectedAccounts={getSelectedAccountsForPlatform("pinterest")}
                />
                
                {/* Pinterest Pin Preview */}
                {files.length > 0 && (
                  <div className="border-t pt-4">
                    <PinterestPinPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      title={platformSettings.pinterestTitle}
                      link={platformSettings.pinterestLink}
                      boardName={platformSettings.selectedPinterestBoard?.name || "My Board"}
                      username={getAccountForPlatform("pinterest")?.platform_username || "your_profile"}
                      avatarUrl={getAccountForPlatform("pinterest")?.avatar_url || undefined}
                    />
                  </div>
                )}
              </TabsContent>}

              {isPlatformEligible("threads") && isPlatformVisible("threads") && hasPlatformSelected("threads") && <TabsContent value="threads" className="mt-4 space-y-6">
                <ThreadsSettings
                  settings={{
                    replyControl: platformSettings.threadsReplyControl,
                    hideFromFeed: platformSettings.threadsHideFromFeed,
                    altText: platformSettings.threadsAltText,
                    crossShareToIg: platformSettings.threadsCrossShareToIg,
                    crossShareToIgDarkMode: platformSettings.threadsCrossShareToIgDarkMode,
                    firstComment: platformSettings.threadsFirstComment,
                    topicTag: platformSettings.threadsTopicTag,
                  }}
                  onChange={(changes) => {
                    if (changes.replyControl !== undefined) platformSettings.setThreadsReplyControl(changes.replyControl);
                    if (changes.hideFromFeed !== undefined) platformSettings.setThreadsHideFromFeed(changes.hideFromFeed);
                    if (changes.altText !== undefined) platformSettings.setThreadsAltText(changes.altText);
                    if (changes.crossShareToIg !== undefined) platformSettings.setThreadsCrossShareToIg(changes.crossShareToIg);
                    if (changes.crossShareToIgDarkMode !== undefined) platformSettings.setThreadsCrossShareToIgDarkMode(changes.crossShareToIgDarkMode);
                    if (changes.firstComment !== undefined) platformSettings.setThreadsFirstComment(changes.firstComment);
                    if (changes.topicTag !== undefined) platformSettings.setThreadsTopicTag(changes.topicTag);
                  }}
                  hasMedia={files.length > 0}
                  hasVideo={files.some((f) => f.fileType === "video")}
                  selectedAccounts={getSelectedAccountsForPlatform("threads")}
                  locationId={platformSettings.threadsLocationId}
                  locationName={platformSettings.threadsLocationName}
                  onLocationIdChange={platformSettings.setThreadsLocationId}
                  onLocationNameChange={platformSettings.setThreadsLocationName}
                  showShareToIg={flags?.threadsShareToIg}
                  onSelectPlace={(place) => {
                    if (!place || !place.id) {
                      platformSettings.setThreadsLocationObject(null);
                    } else {
                      platformSettings.setThreadsLocationObject(place);
                    }
                  }}
                />

                {/* Threads Post Preview */}
                {(caption || files.length > 0) && (
                  <div className="border-t pt-4">
                    <ThreadsPostPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      username={getAccountForPlatform("threads")?.platform_username || "your_account"}
                      avatarUrl={getAccountForPlatform("threads")?.avatar_url || undefined}
                      replyControl={platformSettings.threadsReplyControl}
                      topicTag={platformSettings.threadsTopicTag}
                      locationName={platformSettings.threadsLocationName}
                    />
                  </div>
                )}
              </TabsContent>}

              {isPlatformEligible("bluesky") && isPlatformVisible("bluesky") && hasPlatformSelected("bluesky") && <TabsContent value="bluesky" className="mt-4 space-y-6">
                <BlueskySettings
                  settings={{
                    altText: platformSettings.blueskyAltText,
                    language: platformSettings.blueskyLanguage,
                    embedLink: platformSettings.blueskyEmbedLink,
                    embedEnabled: platformSettings.blueskyEmbedEnabled,
                    contentWarning: platformSettings.blueskyContentWarning || "",
                    adultContent: platformSettings.blueskyAdultContent || false,
                    replyControl: platformSettings.blueskyReplyControl || "everyone",
                    replySettings: platformSettings.blueskyReplySettings,
                  }}
                  onChange={(changes) => {
                    if (changes.altText !== undefined) platformSettings.setBlueskyAltText(changes.altText);
                    if (changes.language !== undefined) platformSettings.setBlueskyLanguage(changes.language);
                    if (changes.embedLink !== undefined) platformSettings.setBlueskyEmbedLink(changes.embedLink);
                    if (changes.embedEnabled !== undefined) platformSettings.setBlueskyEmbedEnabled(changes.embedEnabled);
                    if (changes.contentWarning !== undefined) platformSettings.setBlueskyContentWarning(changes.contentWarning);
                    if (changes.adultContent !== undefined) platformSettings.setBlueskyAdultContent(changes.adultContent);
                    if (changes.replyControl !== undefined) platformSettings.setBlueskyReplyControl(changes.replyControl);
                    if (changes.replySettings !== undefined) platformSettings.setBlueskyReplySettings(changes.replySettings);
                  }}
                  hasMedia={files.length > 0}
                  selectedAccounts={getSelectedAccountsForPlatform("bluesky")}
                />
                
                {/* Bluesky Post Preview */}
                {(caption || files.length > 0) && (
                  <div className="border-t pt-4">
                    <BlueskyPostPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      username={getAccountForPlatform("bluesky")?.platform_username || "your.handle"}
                      avatarUrl={getAccountForPlatform("bluesky")?.avatar_url || undefined}
                      embedLink={platformSettings.blueskyEmbedLink}
                      embedEnabled={platformSettings.blueskyEmbedEnabled}
                    />
                  </div>
                )}
              </TabsContent>}

              {isPlatformEligible("reddit") && isPlatformVisible("reddit") && hasPlatformSelected("reddit") && <TabsContent value="reddit" className="mt-4 space-y-6">
                <RedditSettings
                  settings={{
                    subreddit: platformSettings.redditSubreddit,
                    title: platformSettings.redditTitle,
                    postType: platformSettings.redditPostType,
                    linkUrl: platformSettings.redditLinkUrl,
                    spoiler: platformSettings.redditSpoiler,
                    nsfw: platformSettings.redditNsfw,
                    sendReplies: platformSettings.redditSendReplies,
                    flair: platformSettings.redditFlair,
                  }}
                  onChange={(changes) => {
                    if (changes.subreddit !== undefined) platformSettings.setRedditSubreddit(changes.subreddit);
                    if (changes.title !== undefined) platformSettings.setRedditTitle(changes.title);
                    if (changes.postType !== undefined) platformSettings.setRedditPostType(changes.postType);
                    if (changes.linkUrl !== undefined) platformSettings.setRedditLinkUrl(changes.linkUrl);
                    if (changes.spoiler !== undefined) platformSettings.setRedditSpoiler(changes.spoiler);
                    if (changes.nsfw !== undefined) platformSettings.setRedditNsfw(changes.nsfw);
                    if (changes.sendReplies !== undefined) platformSettings.setRedditSendReplies(changes.sendReplies);
                    if (changes.flair !== undefined) platformSettings.setRedditFlair(changes.flair);
                  }}
                  hasMedia={files.length > 0}
                  selectedAccounts={getSelectedAccountsForPlatform("reddit")}
                />
                
                {/* Reddit Post Preview */}
                {(caption || platformSettings.redditTitle || files.length > 0) && (
                  <div className="border-t pt-4">
                    <RedditPostPreview
                      caption={caption}
                      mediaFile={files[0] ? { previewUrl: files[0].previewUrl, fileType: files[0].fileType } : undefined}
                      title={platformSettings.redditTitle}
                      subreddit={platformSettings.redditSubreddit}
                      username={getAccountForPlatform("reddit")?.platform_username || "your_username"}
                      avatarUrl={getAccountForPlatform("reddit")?.avatar_url || undefined}
                      postType={platformSettings.redditPostType}
                      linkUrl={platformSettings.redditLinkUrl}
                      spoiler={platformSettings.redditSpoiler}
                      nsfw={platformSettings.redditNsfw}
                    />
                  </div>
                )}
              </TabsContent>}
              </>
              )}
            </Tabs>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
