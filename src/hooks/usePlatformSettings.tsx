import { useState, useEffect } from "react";
import { Platform } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export type LocationSource = "threads" | "facebook" | "nominatim" | "meta";

export type LocationObject = {
  id: string;
  name: string;
  address?: string;
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  source: LocationSource;
  taggable_on_threads?: boolean;
  taggable_on_instagram?: boolean | null;
  taggable_on_facebook?: boolean | null;
  eligibility_reason?: string;
  // Allow LocationObject to be assignable to Json (Supabase metadata column type).
  [key: string]: string | number | boolean | null | undefined;
};

export interface TikTokCreatorInfo {
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
  creator_nickname?: string;
  creator_avatar_url?: string;
  creator_username?: string;
  /** REQUIRED: If true, creator has reached daily posting limit - block posting attempts */
  creator_posting_blocked?: boolean;
  /** Error message if posting is blocked */
  posting_blocked_reason?: string;
  /** Daily posting limit total (from TikTok API) */
  daily_limit_total?: number;
  /** Daily posting limit remaining (from TikTok API) */
  daily_limit_remaining?: number;
}

export interface PinterestBoard {
  id: string;
  name: string;
  pin_count?: number;
}

export function usePlatformSettings(userId: string | undefined, selectedAccountIds: string[], selectedPlatforms: Platform[]) {
  const { toast } = useToast();

  // TikTok settings
  const [tiktokPrivacyLevel, setTiktokPrivacyLevel] = useState<string>("");
  const [tiktokAllowComment, setTiktokAllowComment] = useState(false);
  const [tiktokAllowDuet, setTiktokAllowDuet] = useState(false);
  const [tiktokAllowStitch, setTiktokAllowStitch] = useState(false);
  const [tiktokTitle, setTiktokTitle] = useState("");
  const [tiktokDiscloseContent, setTiktokDiscloseContent] = useState(false);
  const [tiktokYourBrand, setTiktokYourBrand] = useState(false);
  const [tiktokBrandedContent, setTiktokBrandedContent] = useState(false);
  const [tiktokAiGenerated, setTiktokAiGenerated] = useState(false);
  const [tiktokConsentAgreed, setTiktokConsentAgreed] = useState(false);
  const [tiktokMusicCheck, setTiktokMusicCheck] = useState(true);
  const [tiktokContentCheck, setTiktokContentCheck] = useState(true);
  const [tiktokMusicCheckStatus, setTiktokMusicCheckStatus] = useState<"pending" | "checking" | "passed" | "warning">("pending");
  const [tiktokContentCheckStatus, setTiktokContentCheckStatus] = useState<"pending" | "checking" | "passed" | "warning">("pending");
  const [tiktokCoverTime, setTiktokCoverTime] = useState(0);
  const [tiktokCoverPreview, setTiktokCoverPreview] = useState<string | null>(null);
  const [hasTiktokDraft, setHasTiktokDraft] = useState(false);
  const [tiktokPreCheckPassed, setTiktokPreCheckPassed] = useState(true);
  const [tiktokTranscodedMediaId, setTiktokTranscodedMediaId] = useState<string | null>(null);
  const [tiktokCreatorInfo, setTiktokCreatorInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loadingCreatorInfo, setLoadingCreatorInfo] = useState(false);

  // Pinterest settings
  const [pinterestBoards, setPinterestBoards] = useState<PinterestBoard[]>([]);
  const [selectedPinterestBoard, setSelectedPinterestBoard] = useState<string>("");
  const [loadingPinterestBoards, setLoadingPinterestBoards] = useState(false);
  const [pinterestTitle, setPinterestTitle] = useState("");
  const [pinterestLink, setPinterestLink] = useState("");
  const [pinterestAltText, setPinterestAltText] = useState("");
  const [pinterestNote, setPinterestNote] = useState("");

  // Facebook settings
  const [facebookPostTypes, setFacebookPostTypes] = useState<("feed" | "story" | "reel")[]>(["feed"]);
  
  const [facebookLocation, setFacebookLocation] = useState("");
  const [facebookLocationId, setFacebookLocationId] = useState("");
  const [facebookLocationName, setFacebookLocationName] = useState("");
  const [facebookFirstComment, setFacebookFirstComment] = useState("");
  const [facebookLink, setFacebookLink] = useState("");
  const [facebookShareToStory, setFacebookShareToStory] = useState(false);
  const [facebookTags, setFacebookTags] = useState("");
  const [facebookReelCollaborator, setFacebookReelCollaborator] = useState("");

  // Instagram settings
  const [instagramPostTypes, setInstagramPostTypes] = useState<("feed" | "story" | "reel")[]>(["feed"]);
  const [instagramCollaborator, setInstagramCollaborator] = useState("");
  const [postLocation, setPostLocation] = useState("");
  const [firstComment, setFirstComment] = useState("");
  const [enableFirstComment, setEnableFirstComment] = useState(false);
  const [instagramShareToFeed, setInstagramShareToFeed] = useState(true);
  const [instagramCoverThumbnailOffset, setInstagramCoverThumbnailOffset] = useState(0);
  const [instagramAudioName, setInstagramAudioName] = useState("");
  const [instagramAltText, setInstagramAltText] = useState("");
  const [instagramHideLikeCounts, setInstagramHideLikeCounts] = useState(false);
  const [instagramDisableComments, setInstagramDisableComments] = useState(false);
  const [instagramLocationId, setInstagramLocationId] = useState("");
  const [instagramLocationName, setInstagramLocationName] = useState("");
  const [instagramShareToStory, setInstagramShareToStory] = useState(false);

  // Structured location objects (full place details for each platform)
  const [facebookLocationObject, setFacebookLocationObject] = useState<LocationObject | null>(null);
  const [instagramLocationObject, setInstagramLocationObject] = useState<LocationObject | null>(null);
  const [threadsLocationObject, setThreadsLocationObject] = useState<LocationObject | null>(null);

  // Twitter settings
  const [twitterThreadMode, setTwitterThreadMode] = useState(false);
  const [twitterPostAsLongTweet, setTwitterPostAsLongTweet] = useState(false);
  const [twitterCustomTitle, setTwitterCustomTitle] = useState("");
  const [twitterReplySettings, setTwitterReplySettings] = useState<"everyone" | "following" | "mentionedUsers" | "subscribers" | "verified">("everyone");
  const [twitterForSuperFollowersOnly, setTwitterForSuperFollowersOnly] = useState(false);
  const [twitterShareWithFollowers, setTwitterShareWithFollowers] = useState(true);
  const [twitterReplyToTweetId, setTwitterReplyToTweetId] = useState("");
  const [twitterQuoteTweetUrl, setTwitterQuoteTweetUrl] = useState("");
  const [twitterTaggedUserIds, setTwitterTaggedUserIds] = useState("");
  const [twitterExcludeReplyUserIds, setTwitterExcludeReplyUserIds] = useState("");
  const [twitterPlaceId, setTwitterPlaceId] = useState("");
  const [twitterCommunityId, setTwitterCommunityId] = useState("");
  const [twitterDmDeepLink, setTwitterDmDeepLink] = useState("");
  const [twitterNullcast, setTwitterNullcast] = useState(false);
  const [twitterThumbnailUrl, setTwitterThumbnailUrl] = useState("");
  const [twitterThumbnailFile, setTwitterThumbnailFile] = useState<File | null>(null);
  const [twitterPollEnabled, setTwitterPollEnabled] = useState(false);
  const [twitterPollOptions, setTwitterPollOptions] = useState<string[]>(["", ""]);
  const [twitterPollDuration, setTwitterPollDuration] = useState("1440");
  // LinkedIn settings
  const [linkedinVisibility, setLinkedinVisibility] = useState<"PUBLIC" | "CONNECTIONS" | "LOGGED_IN" | "CONTAINER">("PUBLIC");
  const [linkedinTitle, setLinkedinTitle] = useState("");
  const [linkedinDescription, setLinkedinDescription] = useState("");
  const [linkedinSelectedDestinationIds, setLinkedinSelectedDestinationIds] = useState<string[]>(["personal"]);

  // YouTube settings
  const [youtubeVideoType, setYoutubeVideoType] = useState<"video" | "short">("video");
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubeVisibility, setYoutubeVisibility] = useState<"public" | "unlisted" | "private">("public");
  const [youtubeTags, setYoutubeTags] = useState("");
  const [youtubeCategory, setYoutubeCategory] = useState("22");
  const [youtubeMadeForKids, setYoutubeMadeForKids] = useState(false);
  const [youtubeAllowEmbedding, setYoutubeAllowEmbedding] = useState(true);
  const [youtubePublicStatsViewable, setYoutubePublicStatsViewable] = useState(true);
  const [youtubeContainsSyntheticMedia, setYoutubeContainsSyntheticMedia] = useState(false);
  const [youtubeHasPaidPromotion, setYoutubeHasPaidPromotion] = useState(false);
  const [youtubeNotifySubscribers, setYoutubeNotifySubscribers] = useState(true);
  const [youtubeCommentsEnabled, setYoutubeCommentsEnabled] = useState(true);
  const [youtubeCommentModeration, setYoutubeCommentModeration] = useState<"none" | "basic" | "strict">("none");
  const [youtubeWhoCanComment, setYoutubeWhoCanComment] = useState<"anyone" | "subscribers" | "approved">("anyone");
  const [youtubeCommentSortBy, setYoutubeCommentSortBy] = useState<"top" | "newest">("top");
  const [youtubeShowLikeCount, setYoutubeShowLikeCount] = useState(true);
  const [youtubeShortsRemixing, setYoutubeShortsRemixing] = useState<"videoAndAudio" | "audioOnly" | "none">("videoAndAudio");
  const [youtubeRecordingDate, setYoutubeRecordingDate] = useState<string>("");
  const [youtubeVideoLocation, setYoutubeVideoLocation] = useState("");
  const [youtubeLicense, setYoutubeLicense] = useState<"youtube" | "creativeCommon">("youtube");
  const [youtubeVideoLanguage, setYoutubeVideoLanguage] = useState("");
  const [youtubeAudioLanguage, setYoutubeAudioLanguage] = useState("");
  const [youtubeCaptionCertification, setYoutubeCaptionCertification] = useState<"none" | "professional" | "auto">("none");
  const [youtubeTitleDescLanguage, setYoutubeTitleDescLanguage] = useState("");
  const [youtubeThumbnailMode, setYoutubeThumbnailMode] = useState<"upload" | "auto" | "test">("auto");
  const [youtubeThumbnailUrl, setYoutubeThumbnailUrl] = useState("");
  const [youtubeThumbnailFile, setYoutubeThumbnailFile] = useState<File | null>(null);
  const [youtubeThumbnailDialogOpen, setYoutubeThumbnailDialogOpen] = useState(false);
  const [youtubeAutoThumbnails, setYoutubeAutoThumbnails] = useState<string[]>([]);
  const [youtubeSelectedAutoThumbnail, setYoutubeSelectedAutoThumbnail] = useState<number | null>(null);
  const [youtubeAiThumbnailPrompt, setYoutubeAiThumbnailPrompt] = useState("");
  const [youtubeAiThumbnailRef, setYoutubeAiThumbnailRef] = useState<string>("");
  const [youtubeGeneratingAiThumbnail, setYoutubeGeneratingAiThumbnail] = useState(false);
  const [youtubeAiGeneratedThumbnails, setYoutubeAiGeneratedThumbnails] = useState<string[]>([]);
  const [youtubeAiThumbnailModel, setYoutubeAiThumbnailModel] = useState<"nano-banana" | "pro">("nano-banana");
  const [youtubeAiThumbnailSize, setYoutubeAiThumbnailSize] = useState<"1k" | "2k" | "4k">("1k");
  const [youtubePlaylist, setYoutubePlaylist] = useState("");
  const [youtubeAllowedCountries, setYoutubeAllowedCountries] = useState("");
  const [youtubeBlockedCountries, setYoutubeBlockedCountries] = useState("");
  const [youtubeFirstComment, setYoutubeFirstComment] = useState("");
  const [youtubeEnableFirstComment, setYoutubeEnableFirstComment] = useState(false);

  // Facebook Reel settings
  const [facebookReelDescription, setFacebookReelDescription] = useState("");

  // Threads settings
  const [threadsReplyControl, setThreadsReplyControl] = useState<"everyone" | "followers" | "following" | "mentioned">("everyone");
  const [threadsHideFromFeed, setThreadsHideFromFeed] = useState(false);
  const [threadsAltText, setThreadsAltText] = useState("");
  const [threadsLocationId, setThreadsLocationId] = useState("");
  const [threadsLocationName, setThreadsLocationName] = useState("");
  const [threadsCrossShareToIg, setThreadsCrossShareToIg] = useState(false);
  const [threadsCrossShareToIgDarkMode, setThreadsCrossShareToIgDarkMode] = useState(false);
  const [threadsFirstComment, setThreadsFirstComment] = useState("");
  const [threadsTopicTag, setThreadsTopicTag] = useState("");

  // Bluesky settings
  const [blueskyAltText, setBlueskyAltText] = useState("");
  const [blueskyLanguage, setBlueskyLanguage] = useState("");
  const [blueskyEmbedLink, setBlueskyEmbedLink] = useState("");
  const [blueskyEmbedEnabled, setBlueskyEmbedEnabled] = useState(false);
  const [blueskyContentWarning, setBlueskyContentWarning] = useState("");
  const [blueskyAdultContent, setBlueskyAdultContent] = useState(false);
  const [blueskyReplyControl, setBlueskyReplyControl] = useState<"everyone" | "following" | "mentions" | "none">("everyone");
  const [blueskyReplySettings, setBlueskyReplySettings] = useState<{
    selectedOption: "anyone" | "nobody" | "following" | "mentioned" | "list";
    selectedListUri: string | null;
  }>({
    selectedOption: "anyone",
    selectedListUri: null,
  });

  // Reddit settings
  const [redditSubreddit, setRedditSubreddit] = useState("");
  const [redditTitle, setRedditTitle] = useState("");
  const [redditPostType, setRedditPostType] = useState<"self" | "link" | "image">("self");
  const [redditLinkUrl, setRedditLinkUrl] = useState("");
  const [redditSpoiler, setRedditSpoiler] = useState(false);
  const [redditNsfw, setRedditNsfw] = useState(false);
  const [redditSendReplies, setRedditSendReplies] = useState(true);
  const [redditFlair, setRedditFlair] = useState("");

  // Check for existing TikTok draft on mount
  useEffect(() => {
    const draft = localStorage.getItem('tiktok_draft');
    if (draft) {
      setHasTiktokDraft(true);
    }
  }, []);

  // Load TikTok draft
  const loadTiktokDraft = () => {
    const draftStr = localStorage.getItem('tiktok_draft');
    if (!draftStr) return null;

    try {
      const draft = JSON.parse(draftStr);
      if (draft.tiktokSettings) {
        if (draft.tiktokSettings.privacyLevel) setTiktokPrivacyLevel(draft.tiktokSettings.privacyLevel);
        if (draft.tiktokSettings.allowComment !== undefined) setTiktokAllowComment(draft.tiktokSettings.allowComment);
        if (draft.tiktokSettings.allowDuet !== undefined) setTiktokAllowDuet(draft.tiktokSettings.allowDuet);
        if (draft.tiktokSettings.allowStitch !== undefined) setTiktokAllowStitch(draft.tiktokSettings.allowStitch);
        if (draft.tiktokSettings.title) setTiktokTitle(draft.tiktokSettings.title);
        if (draft.tiktokSettings.discloseContent !== undefined) setTiktokDiscloseContent(draft.tiktokSettings.discloseContent);
        if (draft.tiktokSettings.aiGenerated !== undefined) setTiktokAiGenerated(draft.tiktokSettings.aiGenerated);
        if (draft.tiktokSettings.yourBrand !== undefined) setTiktokYourBrand(draft.tiktokSettings.yourBrand);
        if (draft.tiktokSettings.brandedContent !== undefined) setTiktokBrandedContent(draft.tiktokSettings.brandedContent);
      }
      localStorage.removeItem('tiktok_draft');
      setHasTiktokDraft(false);
      return draft;
    } catch (e) {
      console.error("Failed to load draft:", e);
      return null;
    }
  };

  // Save TikTok draft
  const saveTiktokDraft = (caption: string, platforms: Platform[]) => {
    const draft = {
      caption,
      platforms,
      tiktokSettings: {
        privacyLevel: tiktokPrivacyLevel,
        allowComment: tiktokAllowComment,
        allowDuet: tiktokAllowDuet,
        allowStitch: tiktokAllowStitch,
        title: tiktokTitle,
        discloseContent: tiktokDiscloseContent,
        aiGenerated: tiktokAiGenerated,
        yourBrand: tiktokYourBrand,
        brandedContent: tiktokBrandedContent,
      },
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem('tiktok_draft', JSON.stringify(draft));
    setHasTiktokDraft(true);
  };

  // Reset TikTok settings
  const resetTiktokSettings = () => {
    setTiktokPrivacyLevel("");
    setTiktokAllowComment(false);
    setTiktokAllowDuet(false);
    setTiktokAllowStitch(false);
    setTiktokTitle("");
    setTiktokDiscloseContent(false);
    setTiktokYourBrand(false);
    setTiktokBrandedContent(false);
    setTiktokAiGenerated(false);
    setTiktokConsentAgreed(false);
    localStorage.removeItem('tiktok_draft');
    setHasTiktokDraft(false);
  };

  // Fetch Pinterest boards
  const fetchPinterestBoards = async () => {
    if (!userId) return;

    setLoadingPinterestBoards(true);
    try {
      const { data, error } = await supabase.functions.invoke("pinterest-boards", {
        body: { user_id: userId },
      });

      if (error) throw error;

      if (data?.boards && data.boards.length > 0) {
        setPinterestBoards(data.boards);
        setSelectedPinterestBoard(data.boards[0].id);
      } else if (data?.error) {
        toast({
          title: "Pinterest boards",
          description: data.error,
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to fetch Pinterest boards:", error);
      toast({
        title: "Failed to load boards",
        description: "Could not fetch your Pinterest boards.",
        variant: "destructive",
      });
    } finally {
      setLoadingPinterestBoards(false);
    }
  };

  // Refresh Pinterest boards
  const refreshPinterestBoards = async () => {
    if (!userId) return;

    setLoadingPinterestBoards(true);
    try {
      const { data, error } = await supabase.functions.invoke("pinterest-boards", {
        body: { user_id: userId },
      });

      if (error) throw error;

      if (data?.boards && data.boards.length > 0) {
        setPinterestBoards(data.boards);
        if (!selectedPinterestBoard) {
          setSelectedPinterestBoard(data.boards[0].id);
        }
        toast({
          title: "Boards refreshed",
          description: `Found ${data.boards.length} Pinterest board${data.boards.length > 1 ? 's' : ''}.`,
        });
      } else {
        toast({
          title: "No boards found",
          description: "Create a board on Pinterest first, then click Refresh.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to refresh Pinterest boards:", error);
      toast({
        title: "Failed to refresh",
        description: "Could not fetch your Pinterest boards. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoadingPinterestBoards(false);
    }
  };

  // Fetch TikTok creator info
  const fetchTiktokCreatorInfo = async (accountId: string) => {
    setLoadingCreatorInfo(true);
    try {
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: { action: "creator_info", account_id: accountId },
      });

      if (error) throw error;

      if (data?.creator_info) {
        setTiktokCreatorInfo(data.creator_info);
      }
    } catch (error) {
      console.error("Failed to fetch TikTok creator info:", error);
      setTiktokCreatorInfo(null);
    } finally {
      setLoadingCreatorInfo(false);
    }
  };

  // Build post metadata
  const buildPostMetadata = () => {
    // Pre-publish safety net: strip Instagram/Threads location if the stored
    // selected place is not actually taggable. Mirrors LocationAutocomplete's
    // strict selection rules so a stale or programmatic selection can never
    // sneak through. Publishing is never blocked.
    let safeInstagramLocationId = instagramLocationId;
    let safeInstagramLocationObject = instagramLocationObject;
    if (selectedPlatforms.includes("instagram") && instagramLocationId) {
      const obj = instagramLocationObject;
      const validIg =
        !!obj &&
        obj.id === instagramLocationId &&
        obj.source === "facebook" &&
        obj.taggable_on_instagram === true &&
        !String(instagramLocationId).startsWith("osm_");
      if (!validIg) {
        safeInstagramLocationId = "";
        safeInstagramLocationObject = null;
        toast({
          title: "Instagram location removed",
          description: "Instagram location was removed because it is not taggable.",
        });
      }
    }

    let safeThreadsLocationId = threadsLocationId;
    let safeThreadsLocationObject = threadsLocationObject;
    if (selectedPlatforms.includes("threads") && threadsLocationId) {
      const obj = threadsLocationObject;
      const validTh =
        !!obj &&
        obj.id === threadsLocationId &&
        obj.source === "threads" &&
        obj.taggable_on_threads === true &&
        !String(threadsLocationId).startsWith("osm_");
      if (!validTh) {
        safeThreadsLocationId = "";
        safeThreadsLocationObject = null;
        toast({
          title: "Threads location removed",
          description: "Threads location was removed because it is not a native Threads location.",
        });
      }
    }

    return {
      selected_account_ids: selectedAccountIds,
      // Pinterest settings
      pinterest_board_id: selectedPinterestBoard || null,
      pinterest_title: pinterestTitle || null,
      pinterest_link: pinterestLink || null,
      pinterest_alt_text: pinterestAltText || null,
      pinterest_note: pinterestNote || null,
      // TikTok settings
      tiktok_privacy_level: selectedPlatforms.includes("tiktok") ? tiktokPrivacyLevel : null,
      tiktok_allow_comment: selectedPlatforms.includes("tiktok") ? tiktokAllowComment : null,
      tiktok_allow_duet: selectedPlatforms.includes("tiktok") ? tiktokAllowDuet : null,
      tiktok_allow_stitch: selectedPlatforms.includes("tiktok") ? tiktokAllowStitch : null,
      tiktok_title: selectedPlatforms.includes("tiktok") ? tiktokTitle : null,
      tiktok_disclose_content: selectedPlatforms.includes("tiktok") ? tiktokDiscloseContent : null,
      tiktok_your_brand: selectedPlatforms.includes("tiktok") ? tiktokYourBrand : null,
      tiktok_branded_content: selectedPlatforms.includes("tiktok") ? tiktokBrandedContent : null,
      tiktok_ai_generated: selectedPlatforms.includes("tiktok") ? tiktokAiGenerated : null,
      // Facebook settings
      facebook_post_type: selectedPlatforms.includes("facebook") ? facebookPostTypes : null,
      
      facebook_location: facebookLocation || null,
      facebook_location_id:
        selectedPlatforms.includes("facebook") && facebookLocationId && !facebookLocationId.startsWith("osm_")
          ? facebookLocationId
          : null,
      facebook_location_object:
        selectedPlatforms.includes("facebook") && facebookLocationObject && facebookLocationObject.id && !String(facebookLocationObject.id).startsWith("osm_")
          ? facebookLocationObject
          : null,
      facebook_location_skipped_reason:
        selectedPlatforms.includes("facebook") && facebookLocationId && facebookLocationId.startsWith("osm_")
          ? "osm_reference"
          : null,
      facebook_first_comment: facebookFirstComment || null,
      facebook_link: facebookLink || null,
      facebook_share_to_story: selectedPlatforms.includes("facebook") ? facebookShareToStory : null,
      facebook_tags: facebookTags || null,
      facebook_reel_collaborator: facebookReelCollaborator || null,
      // Instagram settings
      instagram_post_type: selectedPlatforms.includes("instagram") ? instagramPostTypes : null,
      instagram_location: postLocation || null,
      instagram_first_comment: firstComment || null,
      instagram_collaborator: instagramCollaborator || null,
      instagram_share_to_feed: selectedPlatforms.includes("instagram") ? instagramShareToFeed : null,
      instagram_cover_thumbnail_offset: selectedPlatforms.includes("instagram") ? instagramCoverThumbnailOffset : null,
      instagram_audio_name: instagramAudioName || null,
      instagram_alt_text: instagramAltText || null,
      instagram_hide_like_counts: selectedPlatforms.includes("instagram") ? instagramHideLikeCounts : null,
      instagram_disable_comments: selectedPlatforms.includes("instagram") ? instagramDisableComments : null,
      instagram_location_id:
        selectedPlatforms.includes("instagram") && safeInstagramLocationId && !safeInstagramLocationId.startsWith("osm_")
          ? safeInstagramLocationId
          : null,
      instagram_location_object:
        selectedPlatforms.includes("instagram") && safeInstagramLocationObject && safeInstagramLocationObject.id && !String(safeInstagramLocationObject.id).startsWith("osm_")
          ? safeInstagramLocationObject
          : null,
      instagram_location_skipped_reason:
        selectedPlatforms.includes("instagram") && instagramLocationId && !safeInstagramLocationId
          ? (instagramLocationId.startsWith("osm_") ? "osm_reference" : "not_taggable")
          : null,
      instagram_share_to_story: selectedPlatforms.includes("instagram") ? instagramShareToStory : null,
      // Twitter settings
      twitter_thread_mode: selectedPlatforms.includes("twitter") ? twitterThreadMode : null,
      twitter_post_as_long_tweet: selectedPlatforms.includes("twitter") ? twitterPostAsLongTweet : null,
      twitter_custom_title: twitterCustomTitle || null,
      twitter_reply_settings: selectedPlatforms.includes("twitter") ? twitterReplySettings : null,
      twitter_for_super_followers_only: selectedPlatforms.includes("twitter") ? twitterForSuperFollowersOnly : null,
      twitter_share_with_followers: selectedPlatforms.includes("twitter") ? twitterShareWithFollowers : null,
      twitter_reply_to_tweet_id: twitterReplyToTweetId || null,
      twitter_quote_tweet_url: twitterQuoteTweetUrl || null,
      twitter_tagged_user_ids: twitterTaggedUserIds ? twitterTaggedUserIds.split(",").map(id => id.trim()).filter(Boolean) : null,
      twitter_exclude_reply_user_ids: twitterExcludeReplyUserIds ? twitterExcludeReplyUserIds.split(",").map(id => id.trim()).filter(Boolean) : null,
      twitter_place_id: twitterPlaceId || null,
      twitter_community_id: twitterCommunityId || null,
      twitter_dm_deep_link: twitterDmDeepLink || null,
      twitter_nullcast: selectedPlatforms.includes("twitter") ? twitterNullcast : null,
      twitter_thumbnail_url: twitterThumbnailUrl || null,
      twitter_poll_enabled: selectedPlatforms.includes("twitter") ? twitterPollEnabled : null,
      twitter_poll_options: twitterPollEnabled ? twitterPollOptions.filter(o => o.trim()) : null,
      twitter_poll_duration: twitterPollEnabled ? parseInt(twitterPollDuration) : null,
      // LinkedIn settings
      linkedin_visibility: selectedPlatforms.includes("linkedin") ? linkedinVisibility : null,
      linkedin_title: linkedinTitle || null,
      linkedin_description: linkedinDescription || null,
      linkedin_destination_ids: selectedPlatforms.includes("linkedin") ? linkedinSelectedDestinationIds : null,
      // Back-compat: legacy single page id consumed by older deploys of process-post.
      linkedin_page_id: linkedinSelectedDestinationIds.find((id) => id !== "personal") ?? null,
      // YouTube settings
      youtube_video_type: selectedPlatforms.includes("youtube") ? youtubeVideoType : null,
      youtube_title: youtubeTitle || null,
      youtube_description: youtubeDescription || null,
      youtube_visibility: selectedPlatforms.includes("youtube") ? youtubeVisibility : null,
      youtube_tags: youtubeTags ? youtubeTags.split(",").map(t => t.trim()).filter(Boolean) : null,
      youtube_category: youtubeCategory || null,
      youtube_made_for_kids: selectedPlatforms.includes("youtube") ? youtubeMadeForKids : null,
      youtube_allow_embedding: selectedPlatforms.includes("youtube") ? youtubeAllowEmbedding : null,
      youtube_public_stats_viewable: selectedPlatforms.includes("youtube") ? youtubePublicStatsViewable : null,
      youtube_contains_synthetic_media: selectedPlatforms.includes("youtube") ? youtubeContainsSyntheticMedia : null,
      youtube_has_paid_promotion: selectedPlatforms.includes("youtube") ? youtubeHasPaidPromotion : null,
      youtube_notify_subscribers: selectedPlatforms.includes("youtube") ? youtubeNotifySubscribers : null,
      youtube_video_language: youtubeVideoLanguage || null,
      youtube_audio_language: youtubeAudioLanguage || null,
      youtube_recording_date: youtubeRecordingDate || null,
      youtube_license: selectedPlatforms.includes("youtube") ? youtubeLicense : null,
      youtube_allowed_countries: youtubeAllowedCountries ? youtubeAllowedCountries.split(",").map(c => c.trim()).filter(Boolean) : null,
      youtube_blocked_countries: youtubeBlockedCountries ? youtubeBlockedCountries.split(",").map(c => c.trim()).filter(Boolean) : null,
      youtube_first_comment: youtubeEnableFirstComment && youtubeFirstComment ? youtubeFirstComment : null,
      youtube_thumbnail_url: youtubeThumbnailUrl || null,
      // Facebook Reel description
      facebook_reel_description: facebookReelDescription || null,
      // Threads settings
      threads_reply_control: selectedPlatforms.includes("threads") ? threadsReplyControl : null,
      threads_hide_from_feed: selectedPlatforms.includes("threads") ? threadsHideFromFeed : null,
      threads_alt_text: threadsAltText || null,
      // Threads: only serialize the location id when we have proof it is a native Threads place.
      // Without that proof (legacy posts, Facebook fallback, OSM), we skip with a reason so process-post can warn.
      threads_location_id: (() => {
        if (!selectedPlatforms.includes("threads")) return null;
        if (!safeThreadsLocationId) return null;
        if (safeThreadsLocationId.startsWith("osm_")) return null;
        const obj = safeThreadsLocationObject;
        if (obj && obj.id === safeThreadsLocationId && obj.source === "threads" && obj.taggable_on_threads === true) {
          return safeThreadsLocationId;
        }
        return null;
      })(),
      threads_location_object:
        selectedPlatforms.includes("threads") && safeThreadsLocationObject && safeThreadsLocationObject.id && safeThreadsLocationObject.source === "threads" && safeThreadsLocationObject.taggable_on_threads === true
          ? safeThreadsLocationObject
          : null,
      threads_location_skipped_reason: (() => {
        if (!selectedPlatforms.includes("threads")) return null;
        if (!threadsLocationId) return null;
        if (threadsLocationId.startsWith("osm_")) return "osm_reference";
        const obj = threadsLocationObject;
        if (!obj || obj.id !== threadsLocationId) return "unverified_source";
        if (obj.source !== "threads") return "non_native_source";
        if (obj.taggable_on_threads !== true) return "not_taggable";
        return null;
      })(),
      threads_cross_share_to_ig: selectedPlatforms.includes("threads") ? threadsCrossShareToIg : null,
      threads_cross_share_to_ig_dark_mode: selectedPlatforms.includes("threads") ? threadsCrossShareToIgDarkMode : null,
      threads_first_comment: selectedPlatforms.includes("threads") ? (threadsFirstComment || null) : null,
      threads_topic_tag: (() => {
        if (!selectedPlatforms.includes("threads")) return null;
        const cleaned = (threadsTopicTag || "").replace(/[.&]/g, "").slice(0, 50).trim();
        return cleaned.length ? cleaned : null;
      })(),
      // Bluesky settings
      bluesky_alt_text: blueskyAltText || null,
      bluesky_language: blueskyLanguage || null,
      bluesky_embed_link: blueskyEmbedEnabled && blueskyEmbedLink ? blueskyEmbedLink : null,
      bluesky_content_warning: blueskyContentWarning || null,
      bluesky_adult_content: blueskyAdultContent || null,
      bluesky_reply_control: selectedPlatforms.includes("bluesky") ? blueskyReplyControl : null,
      bluesky_reply_settings: selectedPlatforms.includes("bluesky") ? blueskyReplySettings : null,
      // Reddit settings
      reddit_subreddit: selectedPlatforms.includes("reddit") ? redditSubreddit : null,
      reddit_title: selectedPlatforms.includes("reddit") ? redditTitle : null,
      reddit_post_type: selectedPlatforms.includes("reddit") ? redditPostType : null,
      reddit_link_url: redditPostType === "link" ? redditLinkUrl : null,
      reddit_spoiler: selectedPlatforms.includes("reddit") ? redditSpoiler : null,
      reddit_nsfw: selectedPlatforms.includes("reddit") ? redditNsfw : null,
      reddit_send_replies: selectedPlatforms.includes("reddit") ? redditSendReplies : null,
      reddit_flair: redditFlair || null,
    };
  };

  // Validate TikTok settings
  const validateTiktokSettings = (hasVideo: boolean): string | null => {
    // REQUIRED: Block posting if creator has reached daily limit
    if (tiktokCreatorInfo?.creator_posting_blocked) {
      return tiktokCreatorInfo.posting_blocked_reason || "You've reached your daily TikTok posting limit. Please try again later.";
    }
    // Title is now optional - TikTok will use main caption if tiktok_title is empty
    if (!tiktokPrivacyLevel) {
      return "Please select a privacy level for your TikTok post.";
    }
    if (!tiktokConsentAgreed) {
      return "Please agree to TikTok's terms before posting.";
    }
    if (tiktokDiscloseContent && !tiktokYourBrand && !tiktokBrandedContent) {
      return "Please select at least one content disclosure option.";
    }
    if (tiktokBrandedContent && tiktokPrivacyLevel === "SELF_ONLY") {
      return "Branded content cannot be set to private. Please change the privacy setting.";
    }
    if (hasVideo && !tiktokPreCheckPassed && !tiktokTranscodedMediaId) {
      return "Please transcode your video or upload a compliant 9:16 video (720×1280+).";
    }
    return null;
  };

  // Validate Pinterest settings
  const validatePinterestSettings = (): string | null => {
    if (pinterestBoards.length === 0) {
      return "You don't have any Pinterest boards. Please create a board on Pinterest first.";
    }
    if (!selectedPinterestBoard) {
      return "Please select a Pinterest board to save your pin to.";
    }
    return null;
  };

  return {
    // TikTok
    tiktokPrivacyLevel, setTiktokPrivacyLevel,
    tiktokAllowComment, setTiktokAllowComment,
    tiktokAllowDuet, setTiktokAllowDuet,
    tiktokAllowStitch, setTiktokAllowStitch,
    tiktokTitle, setTiktokTitle,
    tiktokDiscloseContent, setTiktokDiscloseContent,
    tiktokYourBrand, setTiktokYourBrand,
    tiktokBrandedContent, setTiktokBrandedContent,
    tiktokAiGenerated, setTiktokAiGenerated,
    tiktokConsentAgreed, setTiktokConsentAgreed,
    tiktokMusicCheck, setTiktokMusicCheck,
    tiktokContentCheck, setTiktokContentCheck,
    tiktokMusicCheckStatus, setTiktokMusicCheckStatus,
    tiktokContentCheckStatus, setTiktokContentCheckStatus,
    tiktokCoverTime, setTiktokCoverTime,
    tiktokCoverPreview, setTiktokCoverPreview,
    hasTiktokDraft, setHasTiktokDraft,
    tiktokPreCheckPassed, setTiktokPreCheckPassed,
    tiktokTranscodedMediaId, setTiktokTranscodedMediaId,
    tiktokCreatorInfo, setTiktokCreatorInfo,
    loadingCreatorInfo,
    loadTiktokDraft,
    saveTiktokDraft,
    resetTiktokSettings,
    fetchTiktokCreatorInfo,
    validateTiktokSettings,

    // Pinterest
    pinterestBoards, setPinterestBoards,
    selectedPinterestBoard, setSelectedPinterestBoard,
    loadingPinterestBoards,
    pinterestTitle, setPinterestTitle,
    pinterestLink, setPinterestLink,
    pinterestAltText, setPinterestAltText,
    pinterestNote, setPinterestNote,
    fetchPinterestBoards,
    refreshPinterestBoards,
    validatePinterestSettings,

    // Facebook
    facebookPostTypes, setFacebookPostTypes,
    
    facebookLocation, setFacebookLocation,
    facebookLocationId, setFacebookLocationId,
    facebookLocationName, setFacebookLocationName,
    facebookLocationObject, setFacebookLocationObject,
    facebookFirstComment, setFacebookFirstComment,
    facebookLink, setFacebookLink,
    facebookShareToStory, setFacebookShareToStory,
    facebookTags, setFacebookTags,
    facebookReelCollaborator, setFacebookReelCollaborator,

    // Instagram
    instagramPostTypes, setInstagramPostTypes,
    instagramCollaborator, setInstagramCollaborator,
    postLocation, setPostLocation,
    firstComment, setFirstComment,
    enableFirstComment, setEnableFirstComment,
    instagramShareToFeed, setInstagramShareToFeed,
    instagramCoverThumbnailOffset, setInstagramCoverThumbnailOffset,
    instagramAudioName, setInstagramAudioName,
    instagramAltText, setInstagramAltText,
    instagramHideLikeCounts, setInstagramHideLikeCounts,
    instagramDisableComments, setInstagramDisableComments,
    instagramLocationId, setInstagramLocationId,
    instagramLocationName, setInstagramLocationName,
    instagramLocationObject, setInstagramLocationObject,
    instagramShareToStory, setInstagramShareToStory,

    // Twitter
    twitterThreadMode, setTwitterThreadMode,
    twitterPostAsLongTweet, setTwitterPostAsLongTweet,
    twitterCustomTitle, setTwitterCustomTitle,
    twitterReplySettings, setTwitterReplySettings,
    twitterForSuperFollowersOnly, setTwitterForSuperFollowersOnly,
    twitterShareWithFollowers, setTwitterShareWithFollowers,
    twitterReplyToTweetId, setTwitterReplyToTweetId,
    twitterQuoteTweetUrl, setTwitterQuoteTweetUrl,
    twitterTaggedUserIds, setTwitterTaggedUserIds,
    twitterExcludeReplyUserIds, setTwitterExcludeReplyUserIds,
    twitterPlaceId, setTwitterPlaceId,
    twitterCommunityId, setTwitterCommunityId,
    twitterDmDeepLink, setTwitterDmDeepLink,
    twitterNullcast, setTwitterNullcast,
    twitterThumbnailUrl, setTwitterThumbnailUrl,
    twitterThumbnailFile, setTwitterThumbnailFile,
    twitterPollEnabled, setTwitterPollEnabled,
    twitterPollOptions, setTwitterPollOptions,
    twitterPollDuration, setTwitterPollDuration,

    // LinkedIn
    linkedinVisibility, setLinkedinVisibility,
    linkedinTitle, setLinkedinTitle,
    linkedinDescription, setLinkedinDescription,
    linkedinSelectedDestinationIds, setLinkedinSelectedDestinationIds,

    // YouTube
    youtubeVideoType, setYoutubeVideoType,
    youtubeTitle, setYoutubeTitle,
    youtubeDescription, setYoutubeDescription,
    youtubeVisibility, setYoutubeVisibility,
    youtubeTags, setYoutubeTags,
    youtubeCategory, setYoutubeCategory,
    youtubeMadeForKids, setYoutubeMadeForKids,
    youtubeAllowEmbedding, setYoutubeAllowEmbedding,
    youtubePublicStatsViewable, setYoutubePublicStatsViewable,
    youtubeContainsSyntheticMedia, setYoutubeContainsSyntheticMedia,
    youtubeHasPaidPromotion, setYoutubeHasPaidPromotion,
    youtubeNotifySubscribers, setYoutubeNotifySubscribers,
    youtubeCommentsEnabled, setYoutubeCommentsEnabled,
    youtubeCommentModeration, setYoutubeCommentModeration,
    youtubeWhoCanComment, setYoutubeWhoCanComment,
    youtubeCommentSortBy, setYoutubeCommentSortBy,
    youtubeShowLikeCount, setYoutubeShowLikeCount,
    youtubeShortsRemixing, setYoutubeShortsRemixing,
    youtubeRecordingDate, setYoutubeRecordingDate,
    youtubeVideoLocation, setYoutubeVideoLocation,
    youtubeLicense, setYoutubeLicense,
    youtubeVideoLanguage, setYoutubeVideoLanguage,
    youtubeAudioLanguage, setYoutubeAudioLanguage,
    youtubeCaptionCertification, setYoutubeCaptionCertification,
    youtubeTitleDescLanguage, setYoutubeTitleDescLanguage,
    youtubeThumbnailMode, setYoutubeThumbnailMode,
    youtubeThumbnailUrl, setYoutubeThumbnailUrl,
    youtubeThumbnailFile, setYoutubeThumbnailFile,
    youtubeThumbnailDialogOpen, setYoutubeThumbnailDialogOpen,
    youtubeAutoThumbnails, setYoutubeAutoThumbnails,
    youtubeSelectedAutoThumbnail, setYoutubeSelectedAutoThumbnail,
    youtubeAiThumbnailPrompt, setYoutubeAiThumbnailPrompt,
    youtubeAiThumbnailRef, setYoutubeAiThumbnailRef,
    youtubeGeneratingAiThumbnail, setYoutubeGeneratingAiThumbnail,
    youtubeAiGeneratedThumbnails, setYoutubeAiGeneratedThumbnails,
    youtubeAiThumbnailModel, setYoutubeAiThumbnailModel,
    youtubeAiThumbnailSize, setYoutubeAiThumbnailSize,
    youtubePlaylist, setYoutubePlaylist,
    youtubeAllowedCountries, setYoutubeAllowedCountries,
    youtubeBlockedCountries, setYoutubeBlockedCountries,
    youtubeFirstComment, setYoutubeFirstComment,
    youtubeEnableFirstComment, setYoutubeEnableFirstComment,

    // Facebook Reel
    facebookReelDescription, setFacebookReelDescription,

    // Threads
    threadsReplyControl, setThreadsReplyControl,
    threadsHideFromFeed, setThreadsHideFromFeed,
    threadsAltText, setThreadsAltText,
    threadsLocationId, setThreadsLocationId,
    threadsLocationName, setThreadsLocationName,
    threadsLocationObject, setThreadsLocationObject,
    threadsCrossShareToIg, setThreadsCrossShareToIg,
    threadsCrossShareToIgDarkMode, setThreadsCrossShareToIgDarkMode,
    threadsFirstComment, setThreadsFirstComment,
    threadsTopicTag, setThreadsTopicTag,

    // Bluesky
    blueskyAltText, setBlueskyAltText,
    blueskyLanguage, setBlueskyLanguage,
    blueskyEmbedLink, setBlueskyEmbedLink,
    blueskyEmbedEnabled, setBlueskyEmbedEnabled,
    blueskyContentWarning, setBlueskyContentWarning,
    blueskyAdultContent, setBlueskyAdultContent,
    blueskyReplyControl, setBlueskyReplyControl,
    blueskyReplySettings, setBlueskyReplySettings,

    // Reddit
    redditSubreddit, setRedditSubreddit,
    redditTitle, setRedditTitle,
    redditPostType, setRedditPostType,
    redditLinkUrl, setRedditLinkUrl,
    redditSpoiler, setRedditSpoiler,
    redditNsfw, setRedditNsfw,
    redditSendReplies, setRedditSendReplies,
    redditFlair, setRedditFlair,

    // Build metadata
    buildPostMetadata,
  };
}
