import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { TikTokVideoPreview } from "@/components/post/TikTokVideoPreview";
import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Loader2, Upload, Link as LinkIcon, Search, CheckCircle2, Clock, AlertCircle, Sparkles, X, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TIKTOK_RED = "#FE2C55";

// Privacy option labels mapping
const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  FOLLOWER_OF_CREATOR: "Followers",
  MUTUAL_FOLLOW_FRIENDS: "Friends only",
  SELF_ONLY: "Only me",
};

interface CreatorInfo {
  creator_nickname?: string;
  creator_username?: string;
  creator_avatar_url?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
  creator_posting_blocked?: boolean;
  daily_limit_remaining?: number;
  daily_limit_total?: number;
}

function useCreatorInfo(accountId: string | undefined) {
  return useQuery<CreatorInfo | null>({
    queryKey: ["tiktok-creator-info-publish", accountId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: { action: "creator_info", social_account_id: accountId },
      });
      if (error) throw error;
      return data?.creator_info || data || null;
    },
    enabled: !!accountId,
    staleTime: 2 * 60 * 1000,
  });
}

export default function TikTokPublish() {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data: tiktokAccounts } = useQuery({
    queryKey: ["tiktok-demo-accounts", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select("*")
        .eq("user_id", user!.id)
        .eq("platform", "tiktok")
        .eq("is_active", true);
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const connectedAccount = tiktokAccounts?.[0];
  const { data: creatorInfo, isLoading: creatorInfoLoading } = useCreatorInfo(connectedAccount?.id);

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <div className="w-full flex items-center justify-between">
          <Link to="/"><Logo size="sm" /></Link>
          <nav className="flex gap-4">
            <Link to="/tiktok-auth" className="text-sm font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors">
              Authentication
            </Link>
            <Link to="/tiktok-publish" className="text-sm font-medium text-zinc-900 dark:text-white border-b-2 border-zinc-900 dark:border-white pb-1">
              Publish
            </Link>
          </nav>
        </div>
      </header>

      <main className="w-full px-6 py-10">
        {!connectedAccount ? (
          <div className="text-center py-16">
            <AlertCircle className="w-12 h-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-white mb-2">No TikTok Account Connected</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">Connect your TikTok account first to publish videos.</p>
            <Link to="/tiktok-auth">
              <Button className="bg-black text-white hover:bg-zinc-800">Go to Authentication</Button>
            </Link>
          </div>
        ) : (
          <>
            {/* Account Info — uses creator_info from API */}
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-zinc-200 dark:border-zinc-800">
              <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden">
                {(creatorInfo?.creator_avatar_url || connectedAccount.avatar_url) ? (
                  <img src={creatorInfo?.creator_avatar_url || connectedAccount.avatar_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm font-bold text-zinc-500">T</span>
                )}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-white">
                  @{creatorInfo?.creator_username || connectedAccount.platform_username}
                </p>
                {creatorInfo?.creator_nickname && creatorInfo.creator_nickname !== creatorInfo.creator_username && (
                  <p className="text-xs text-zinc-500">{creatorInfo.creator_nickname}</p>
                )}
                <p className="text-xs text-zinc-400">Connected Account</p>
              </div>
              {creatorInfoLoading && <Loader2 className="w-4 h-4 animate-spin text-zinc-400 ms-auto" />}
            </div>

            {/* Daily Posting Limit */}
            {creatorInfo?.daily_limit_total != null && creatorInfo?.daily_limit_remaining != null && (
              <div className="mb-6 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Daily posting limit</span>
                  <span className="text-xs text-zinc-500">
                    {creatorInfo.daily_limit_total - creatorInfo.daily_limit_remaining}/{creatorInfo.daily_limit_total} used
                  </span>
                </div>
                <Progress
                  value={((creatorInfo.daily_limit_total - creatorInfo.daily_limit_remaining) / creatorInfo.daily_limit_total) * 100}
                  className="h-2"
                />
              </div>
            )}

            {/* Posting Blocked Alert */}
            {creatorInfo?.creator_posting_blocked && (
              <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">Posting is currently blocked</p>
                  <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-0.5">
                    Your TikTok account has reached its daily posting limit or is temporarily restricted.
                  </p>
                </div>
              </div>
            )}

            <Tabs defaultValue="publish" className="w-full">
              <TabsList className="w-full grid grid-cols-3 mb-8">
                <TabsTrigger value="publish">Publish Video</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="status">Check Status</TabsTrigger>
              </TabsList>

              <TabsContent value="publish">
                <PublishSection
                  accountId={connectedAccount.id}
                  username={creatorInfo?.creator_username || connectedAccount.platform_username || "your_account"}
                  creatorInfo={creatorInfo}
                />
              </TabsContent>
              <TabsContent value="schedule">
                <ScheduleSection
                  accountId={connectedAccount.id}
                  username={creatorInfo?.creator_username || connectedAccount.platform_username || "your_account"}
                  creatorInfo={creatorInfo}
                />
              </TabsContent>
              <TabsContent value="status">
                <StatusSection accountId={connectedAccount.id} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}

/* ═══ Shared: Privacy Select ═══ */
function PrivacySelect({
  value,
  onChange,
  creatorInfo,
  brandedContent,
}: {
  value: string;
  onChange: (v: string) => void;
  creatorInfo: CreatorInfo | null | undefined;
  brandedContent?: boolean;
}) {
  const options = useMemo(() => {
    if (creatorInfo?.privacy_level_options?.length) {
      return creatorInfo.privacy_level_options.map((v) => ({
        value: v,
        label: PRIVACY_LABELS[v] || v,
      }));
    }
    // Fallback if API didn't return options
    return Object.entries(PRIVACY_LABELS).map(([v, l]) => ({ value: v, label: l }));
  }, [creatorInfo?.privacy_level_options]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-zinc-900 dark:text-white font-medium">Who can view this video</Label>
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Required</span>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600"
      >
        <option value="" disabled>Select privacy level</option>
        {options.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            disabled={brandedContent && opt.value === "SELF_ONLY"}
          >
            {opt.label}
          </option>
        ))}
      </select>
      {brandedContent && value === "SELF_ONLY" && (
        <p className="text-xs text-red-500">Privacy cannot be "Only me" when branded content is enabled.</p>
      )}
    </div>
  );
}

/* ═══ Shared: Interaction Toggles ═══ */
function InteractionToggles({
  allowComment, setAllowComment,
  allowDuet, setAllowDuet,
  allowStitch, setAllowStitch,
  privacy,
  creatorInfo,
}: {
  allowComment: boolean; setAllowComment: (v: boolean) => void;
  allowDuet: boolean; setAllowDuet: (v: boolean) => void;
  allowStitch: boolean; setAllowStitch: (v: boolean) => void;
  privacy: string;
  creatorInfo: CreatorInfo | null | undefined;
}) {
  const isSelfOnly = privacy === "SELF_ONLY";
  const commentApiDisabled = creatorInfo?.comment_disabled === true;
  const duetApiDisabled = creatorInfo?.duet_disabled === true;
  const stitchApiDisabled = creatorInfo?.stitch_disabled === true;

  return (
    <div className="space-y-3">
      <Label className="text-zinc-900 dark:text-white font-medium">Allow users to</Label>
      {isSelfOnly && (
        <p className="text-xs text-zinc-400">Interaction settings are not available for private videos.</p>
      )}
      <div className={`space-y-3 ${isSelfOnly ? "opacity-50" : ""}`}>
        <label className="flex items-center gap-3 cursor-pointer">
          <Checkbox
            checked={allowComment}
            onCheckedChange={(v) => setAllowComment(!!v)}
            disabled={isSelfOnly || commentApiDisabled}
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">Comment</span>
          {commentApiDisabled && !isSelfOnly && (
            <span className="text-xs text-zinc-400 italic">(disabled by account settings)</span>
          )}
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <Checkbox
            checked={allowDuet}
            onCheckedChange={(v) => setAllowDuet(!!v)}
            disabled={isSelfOnly || duetApiDisabled}
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">Duet</span>
          {duetApiDisabled && !isSelfOnly && (
            <span className="text-xs text-zinc-400 italic">(disabled by account settings)</span>
          )}
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <Checkbox
            checked={allowStitch}
            onCheckedChange={(v) => setAllowStitch(!!v)}
            disabled={isSelfOnly || stitchApiDisabled}
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">Stitch</span>
          {stitchApiDisabled && !isSelfOnly && (
            <span className="text-xs text-zinc-400 italic">(disabled by account settings)</span>
          )}
        </label>
      </div>
    </div>
  );
}

/* ═══ Shared: Commercial Disclosure ═══ */
function CommercialDisclosure({
  discloseContent, setDiscloseContent,
  yourBrand, setYourBrand,
  brandedContent, setBrandedContent,
  aiGenerated, setAiGenerated,
  privacy, setPrivacy,
}: {
  discloseContent: boolean; setDiscloseContent: (v: boolean) => void;
  yourBrand: boolean; setYourBrand: (v: boolean) => void;
  brandedContent: boolean; setBrandedContent: (v: boolean) => void;
  aiGenerated: boolean; setAiGenerated: (v: boolean) => void;
  privacy: string; setPrivacy: (v: string) => void;
}) {
  const disclosureInvalid = discloseContent && !yourBrand && !brandedContent;
  const brandedContentLocked = discloseContent && privacy === "SELF_ONLY";

  // If privacy switches to SELF_ONLY while branded content is on, force it off
  useEffect(() => {
    if (brandedContentLocked && brandedContent) {
      setBrandedContent(false);
    }
  }, [brandedContentLocked, brandedContent, setBrandedContent]);

  return (
    <>
      {/* Disclose Video Content */}
      <div className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-zinc-900 dark:text-white font-medium">Disclose video content</Label>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Turn on to disclose that this video promotes goods or services in exchange for something of value.{" "}
              <a
                href="https://www.tiktok.com/creators/creator-portal/en-us/getting-paid-to-create/branded-content/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-zinc-900 dark:text-white"
              >
                Learn more
              </a>
            </p>
          </div>
          <Switch checked={discloseContent} onCheckedChange={setDiscloseContent} />
        </div>

        {discloseContent && (
          <div className="space-y-3 ps-1 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            {disclosureInvalid && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                You must select at least one option below.
              </p>
            )}
            <label className="flex items-start gap-3 cursor-pointer">
              <Checkbox checked={yourBrand} onCheckedChange={(v) => setYourBrand(!!v)} className="mt-0.5" />
              <div>
                <span className="text-sm font-medium text-zinc-900 dark:text-white">Your brand</span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  You are promoting yourself or your own business. This video will be classified as Brand Organic.
                </p>
              </div>
            </label>
            <label className={`flex items-start gap-3 ${brandedContentLocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
              <Checkbox
                checked={brandedContent}
                disabled={brandedContentLocked}
                onCheckedChange={(v) => {
                  if (brandedContentLocked) return;
                  const val = !!v;
                  setBrandedContent(val);
                  if (val && privacy === "SELF_ONLY") setPrivacy("");
                }}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium text-zinc-900 dark:text-white">Branded content</span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  You are promoting another brand or a third party. This video will be classified as Branded Content.
                </p>
                {brandedContentLocked && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Branded content can't be used with "Only me". Switch privacy to Public, Friends, or Followers to enable it.
                  </p>
                )}
              </div>
            </label>
          </div>
        )}
      </div>

      {/* AI-Generated Content */}
      <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 p-4">
        <div>
          <Label className="text-zinc-900 dark:text-white font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> AI-generated content
          </Label>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Turn on to disclose that this video contains AI-generated content.
          </p>
        </div>
        <Switch checked={aiGenerated} onCheckedChange={setAiGenerated} />
      </div>
    </>
  );
}

/* ═══ Shared: Music Consent ═══ */
function MusicConsent({
  musicConsent, setMusicConsent,
  brandedContent = false,
}: {
  musicConsent: boolean; setMusicConsent: (v: boolean) => void;
  brandedContent?: boolean;
}) {
  return (
    <>
      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <Checkbox checked={musicConsent} onCheckedChange={(v) => setMusicConsent(!!v)} className="mt-0.5" />
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            By posting, you agree to TikTok's{" "}
            {brandedContent && (
              <>
                <a
                  href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-zinc-900 dark:text-white"
                >
                  Branded Content Policy
                </a>
                {" "}and{" "}
              </>
            )}
            <a
              href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-zinc-900 dark:text-white"
            >
              Music Usage Confirmation
            </a>.
          </span>
        </label>
      </div>
    </>
  );
}

/* ─── Publish Section ─── */
const PUBLISH_DRAFT_KEY = "tiktok-publish-draft";

function PublishSection({ accountId, username, creatorInfo }: { accountId: string; username: string; creatorInfo: CreatorInfo | null | undefined }) {
  const { toast } = useToast();

  const savedDraft = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(PUBLISH_DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  const [draftRestored, setDraftRestored] = useState(!!savedDraft);
  const [videoSource, setVideoSource] = useState<"url" | "file">(savedDraft?.videoSource || "url");
  const [videoUrl, setVideoUrl] = useState(savedDraft?.videoUrl || "");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (videoFile) {
      const url = URL.createObjectURL(videoFile);
      setPreviewUrl(url);
      // Get video duration
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        setVideoDuration(video.duration);
        URL.revokeObjectURL(video.src);
      };
      video.src = url;
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
      setVideoDuration(null);
    }
  }, [videoFile]);

  const [title, setTitle] = useState(savedDraft?.title || "");
  const [caption, setCaption] = useState(savedDraft?.caption || "");
  const [privacy, setPrivacy] = useState(savedDraft?.privacy || "");
  const [allowComment, setAllowComment] = useState(savedDraft?.allowComment ?? false);
  const [allowDuet, setAllowDuet] = useState(savedDraft?.allowDuet ?? false);
  const [allowStitch, setAllowStitch] = useState(savedDraft?.allowStitch ?? false);
  const [discloseContent, setDiscloseContent] = useState(savedDraft?.discloseContent ?? false);
  const [yourBrand, setYourBrand] = useState(savedDraft?.yourBrand ?? false);
  const [brandedContent, setBrandedContent] = useState(savedDraft?.brandedContent ?? false);
  const [aiGenerated, setAiGenerated] = useState(savedDraft?.aiGenerated ?? false);
  const [autoAddMusic, setAutoAddMusic] = useState(savedDraft?.autoAddMusic ?? false);
  const [musicConsent, setMusicConsent] = useState(savedDraft?.musicConsent ?? false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [result, setResult] = useState<any>(null);

  // Auto-save draft
  useEffect(() => {
    const draft = {
      videoSource, videoUrl, title, caption, privacy,
      allowComment, allowDuet, allowStitch,
      discloseContent, yourBrand, brandedContent,
      aiGenerated, autoAddMusic, musicConsent,
    };
    sessionStorage.setItem(PUBLISH_DRAFT_KEY, JSON.stringify(draft));
  }, [videoSource, videoUrl, title, caption, privacy, allowComment, allowDuet, allowStitch, discloseContent, yourBrand, brandedContent, aiGenerated, autoAddMusic, musicConsent]);

  const clearDraft = useCallback(() => {
    sessionStorage.removeItem(PUBLISH_DRAFT_KEY);
    setDraftRestored(false);
    setVideoSource("url");
    setVideoUrl("");
    setVideoFile(null);
    setTitle("");
    setCaption("");
    setPrivacy("");
    setAllowComment(false);
    setAllowDuet(false);
    setAllowStitch(false);
    setDiscloseContent(false);
    setYourBrand(false);
    setBrandedContent(false);
    setAiGenerated(false);
    setAutoAddMusic(false);
    setMusicConsent(false);
    setResult(null);
  }, []);

  // Auto-fill caption (Description) from video filename — non-destructive.
  const lastAutoFilledRef = useRef<string>("");
  const deriveDescriptionFromName = useCallback((rawName: string) => {
    const justName = rawName.split(/[\\/?#]/).pop() || rawName;
    const base = justName.replace(/\.[^/.]+$/, "");
    const cleaned = base
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, 2050);
  }, []);

  // When a local video file is selected/swapped
  useEffect(() => {
    if (!videoFile) return;
    const derived = deriveDescriptionFromName(videoFile.name);
    if (!derived) return;
    setCaption((prev) => {
      if (!prev || prev === lastAutoFilledRef.current) {
        lastAutoFilledRef.current = derived;
        return derived;
      }
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile]);

  // When the URL source changes
  useEffect(() => {
    if (videoSource !== "url" || !videoUrl) return;
    const derived = deriveDescriptionFromName(videoUrl);
    if (!derived) return;
    setCaption((prev) => {
      if (!prev || prev === lastAutoFilledRef.current) {
        lastAutoFilledRef.current = derived;
        return derived;
      }
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, videoSource]);

  // When the video is removed, clear caption only if user hadn't customized it
  useEffect(() => {
    const noVideo = videoSource === "file" ? !videoFile : !videoUrl;
    if (!noVideo) return;
    setCaption((prev) => {
      if (prev && prev === lastAutoFilledRef.current) {
        lastAutoFilledRef.current = "";
        return "";
      }
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFile, videoUrl, videoSource]);

  const disclosureInvalid = discloseContent && !yourBrand && !brandedContent;
  const brandedPrivacyConflict = brandedContent && privacy === "SELF_ONLY";
  const maxDuration = creatorInfo?.max_video_post_duration_sec;
  const durationExceeded = maxDuration && videoDuration && videoDuration > maxDuration;
  const isBlocked = creatorInfo?.creator_posting_blocked === true;

  const canPublish = privacy && title.trim() && (videoSource === "url" ? videoUrl : videoFile) && musicConsent && !disclosureInvalid && !brandedPrivacyConflict && !durationExceeded && !isBlocked;

  const handlePublish = async () => {
    if (!canPublish) return;
    setIsPublishing(true);
    setResult(null);
    try {
      const safeBrandedContent = privacy === "SELF_ONLY" ? false : brandedContent;
      const body: any = {
        action: "publish",
        social_account_id: accountId,
        privacy_level: privacy,
        allow_comment: allowComment,
        allow_duet: allowDuet,
        allow_stitch: allowStitch,
        disclose: discloseContent,
        your_brand: yourBrand,
        branded_content: safeBrandedContent,
        ai_generated: aiGenerated,
        title,
        caption,
      };

      if (videoSource === "url") {
        body.video_url = videoUrl;
      } else if (videoFile) {
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(videoFile);
        });
        body.video_base64 = base64;
        body.video_filename = videoFile.name;
        body.video_size = videoFile.size;
        body.chunk_size = videoFile.size;
        body.total_chunk_count = 1;
      }

      const { data, error } = await supabase.functions.invoke("tiktok-demo-publish", { body });
      if (error) throw error;
      setResult(data);
      if (data?.success === false) {
        toast({ title: "Publish failed", description: data.user_message || data.error || "Unknown error", variant: "destructive" });
      } else if (data?.publish_id) {
        sessionStorage.removeItem(PUBLISH_DRAFT_KEY);
        setDraftRestored(false);
        toast({ title: "Video submitted!", description: `Publish ID: ${data.publish_id}` });
      }
    } catch (error) {
      toast({ title: "Publish failed", description: error instanceof Error ? error.message : "Failed to publish video", variant: "destructive" });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
      <div className="lg:col-span-3 space-y-6">
        {draftRestored && (
          <div className="flex items-center justify-between rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-4 py-2.5">
            <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">✏️ Draft restored from your previous session</p>
            <button onClick={clearDraft} className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-medium">
              <X className="w-3 h-3" /> Clear Draft
            </button>
          </div>
        )}

        {/* Video Source */}
        <div className="space-y-3">
          <Label className="text-zinc-900 dark:text-white font-medium">Video Source</Label>
          <div className="flex gap-2">
            <button onClick={() => setVideoSource("url")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${videoSource === "url" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
              <LinkIcon className="w-4 h-4" /> External URL
            </button>
            <button onClick={() => setVideoSource("file")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${videoSource === "file" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
              <Upload className="w-4 h-4" /> Local File
            </button>
          </div>

          {videoSource === "url" ? (
            <Input placeholder="https://example.com/video.mp4" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700" />
          ) : (
            <div className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 rounded-lg p-6 text-center">
              <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files?.[0] || null)} className="hidden" id="video-upload" />
              <label htmlFor="video-upload" className="cursor-pointer">
                <Upload className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-600 mb-2" />
                <p className="text-sm text-zinc-500">{videoFile ? videoFile.name : "Click to select a video file"}</p>
              </label>
            </div>
          )}

          {/* Video Duration Warning */}
          {durationExceeded && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 dark:text-red-400">
                Video duration ({Math.round(videoDuration!)}s) exceeds the maximum allowed ({maxDuration}s). Please select a shorter video.
              </p>
            </div>
          )}
        </div>

        {/* Caption info note */}
        <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            ℹ️ TikTok shows one caption under the video. Title and description will be combined (title on top, blank line, then description).
          </p>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <Label className="text-zinc-900 dark:text-white font-medium">Title <span className="text-destructive">*</span></Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={150}
            placeholder="Title (shown at the top of your video caption)"
            className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700"
          />
          <p className="text-xs text-zinc-400 text-end">{title.length}/150</p>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label className="text-zinc-900 dark:text-white font-medium">Description</Label>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={2050}
            rows={3}
            placeholder="Description (appended after the title; shown together as one caption on TikTok)"
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600 resize-none"
          />
          <p className="text-xs text-zinc-400 text-end">{caption.length}/2050</p>
        </div>

        {/* Privacy — Dynamic from API */}
        <PrivacySelect
          value={privacy}
          onChange={(v) => {
            setPrivacy(v);
            if (v === "SELF_ONLY") {
              setBrandedContent(false);
              setAllowComment(false);
              setAllowDuet(false);
              setAllowStitch(false);
            }
          }}
          creatorInfo={creatorInfo}
          brandedContent={brandedContent}
        />

        {/* Interaction Toggles — API-driven disabled states */}
        <InteractionToggles
          allowComment={allowComment} setAllowComment={setAllowComment}
          allowDuet={allowDuet} setAllowDuet={setAllowDuet}
          allowStitch={allowStitch} setAllowStitch={setAllowStitch}
          privacy={privacy}
          creatorInfo={creatorInfo}
        />

        {/* Commercial Disclosure + AI Generated */}
        <CommercialDisclosure
          discloseContent={discloseContent} setDiscloseContent={setDiscloseContent}
          yourBrand={yourBrand} setYourBrand={setYourBrand}
          brandedContent={brandedContent} setBrandedContent={setBrandedContent}
          aiGenerated={aiGenerated} setAiGenerated={setAiGenerated}
          privacy={privacy} setPrivacy={setPrivacy}
        />

        {/* Music Consent */}
        <MusicConsent
          musicConsent={musicConsent} setMusicConsent={setMusicConsent}
          brandedContent={brandedContent}
        />

        {/* Publish Button */}
        <button
          onClick={handlePublish}
          disabled={!canPublish || isPublishing}
          className="flex items-center justify-center gap-2 w-full h-12 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-semibold text-base hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPublishing ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          Publish to TikTok
        </button>

        {/* Result */}
        {result && (
          <div className={`rounded-lg border p-4 space-y-2 ${result.success === false ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
            <p className="text-sm font-medium text-zinc-900 dark:text-white">
              {result.success === false ? "❌ Publish Failed" : "✅ Video Submitted"}
            </p>
            {result.publish_id && <p className="text-xs text-zinc-500">Publish ID: <code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{result.publish_id}</code></p>}
            {result.user_message && result.success === false && <p className="text-sm text-red-600 dark:text-red-400">{result.user_message}</p>}
            {result.error_code && <p className="text-xs text-zinc-400 font-mono">Error code: {result.error_code}</p>}
          </div>
        )}
      </div>

      {/* Right Column: Sticky Preview */}
      <div className="lg:col-span-2">
        <div className="sticky top-8">
          {((videoSource === "file" && previewUrl) || (videoSource === "url" && videoUrl)) ? (
            <TikTokVideoPreview
              caption={[title.trim(), caption.trim()].filter(Boolean).join("\n\n")}
              mediaFile={{ previewUrl: videoSource === "file" ? previewUrl! : videoUrl, fileType: "video" }}
              username={username}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 p-8 text-center">
              <Upload className="w-10 h-10 mx-auto text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm text-zinc-400">Select a video to see preview</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Schedule Section ─── */
const SCHEDULE_DRAFT_KEY = "tiktok-schedule-draft";

function ScheduleSection({ accountId, username, creatorInfo }: { accountId: string; username: string; creatorInfo: CreatorInfo | null | undefined }) {
  const { toast } = useToast();

  const savedDraft = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(SCHEDULE_DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  const [draftRestored, setDraftRestored] = useState(!!savedDraft);
  const [videoSource, setVideoSource] = useState<"url" | "file">(savedDraft?.videoSource || "url");
  const [videoUrl, setVideoUrl] = useState(savedDraft?.videoUrl || "");
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const [schedulePreviewUrl, setSchedulePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (videoFile) {
      const url = URL.createObjectURL(videoFile);
      setSchedulePreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setSchedulePreviewUrl(null);
    }
  }, [videoFile]);

  const [privacy, setPrivacy] = useState(savedDraft?.privacy || "");
  const [title, setTitle] = useState(savedDraft?.title || "");
  const [caption, setCaption] = useState(savedDraft?.caption || "");
  const [scheduleDate, setScheduleDate] = useState(savedDraft?.scheduleDate || "");
  const [scheduleTime, setScheduleTime] = useState(savedDraft?.scheduleTime || "");
  const [allowComment, setAllowComment] = useState(savedDraft?.allowComment ?? false);
  const [allowDuet, setAllowDuet] = useState(savedDraft?.allowDuet ?? false);
  const [allowStitch, setAllowStitch] = useState(savedDraft?.allowStitch ?? false);
  const [discloseContent, setDiscloseContent] = useState(savedDraft?.discloseContent ?? false);
  const [yourBrand, setYourBrand] = useState(savedDraft?.yourBrand ?? false);
  const [brandedContent, setBrandedContent] = useState(savedDraft?.brandedContent ?? false);
  const [aiGenerated, setAiGenerated] = useState(savedDraft?.aiGenerated ?? false);
  const [autoAddMusic, setAutoAddMusic] = useState(savedDraft?.autoAddMusic ?? false);
  const [musicConsent, setMusicConsent] = useState(savedDraft?.musicConsent ?? false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [result, setResult] = useState<any>(null);

  // Auto-save draft
  useEffect(() => {
    const draft = {
      videoSource, videoUrl, privacy, title, caption, scheduleDate, scheduleTime,
      allowComment, allowDuet, allowStitch,
      discloseContent, yourBrand, brandedContent,
      aiGenerated, autoAddMusic, musicConsent,
    };
    sessionStorage.setItem(SCHEDULE_DRAFT_KEY, JSON.stringify(draft));
  }, [videoSource, videoUrl, privacy, title, caption, scheduleDate, scheduleTime, allowComment, allowDuet, allowStitch, discloseContent, yourBrand, brandedContent, aiGenerated, autoAddMusic, musicConsent]);

  const clearDraft = useCallback(() => {
    sessionStorage.removeItem(SCHEDULE_DRAFT_KEY);
    setDraftRestored(false);
    setVideoSource("url");
    setVideoUrl("");
    setVideoFile(null);
    setPrivacy("");
    setTitle("");
    setCaption("");
    setScheduleDate("");
    setScheduleTime("");
    setAllowComment(false);
    setAllowDuet(false);
    setAllowStitch(false);
    setDiscloseContent(false);
    setYourBrand(false);
    setBrandedContent(false);
    setAiGenerated(false);
    setAutoAddMusic(false);
    setMusicConsent(false);
    setResult(null);
  }, []);

  const disclosureInvalid = discloseContent && !yourBrand && !brandedContent;
  const brandedPrivacyConflict = brandedContent && privacy === "SELF_ONLY";
  const isBlocked = creatorInfo?.creator_posting_blocked === true;

  const canSchedule = privacy && title.trim() && (videoSource === "url" ? videoUrl : videoFile) && scheduleDate && scheduleTime && musicConsent && !disclosureInvalid && !brandedPrivacyConflict && !isBlocked;

  const handleSchedule = async () => {
    if (!canSchedule) return;
    setIsScheduling(true);
    setResult(null);
    try {
      const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}`).toISOString();
      const safeBrandedContent = privacy === "SELF_ONLY" ? false : brandedContent;
      const body: any = {
        action: "schedule",
        social_account_id: accountId,
        privacy_level: privacy,
        scheduled_at: scheduledAt,
        allow_comment: allowComment,
        allow_duet: allowDuet,
        allow_stitch: allowStitch,
        disclose: discloseContent,
        your_brand: yourBrand,
        branded_content: safeBrandedContent,
        ai_generated: aiGenerated,
        title,
        caption,
      };
      if (videoSource === "url") {
        body.video_url = videoUrl;
      } else if (videoFile) {
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve((reader.result as string).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(videoFile);
        });
        body.video_base64 = base64;
        body.video_filename = videoFile.name;
        body.video_size = videoFile.size;
        body.chunk_size = videoFile.size;
        body.total_chunk_count = 1;
      }

      const { data, error } = await supabase.functions.invoke("tiktok-demo-publish", { body });
      if (error) throw error;
      setResult(data);
      if (data?.success === false) {
        toast({ title: "Schedule failed", description: data.user_message || data.error || "Unknown error", variant: "destructive" });
      } else if (data?.publish_id) {
        sessionStorage.removeItem(SCHEDULE_DRAFT_KEY);
        setDraftRestored(false);
        toast({ title: "Video scheduled!", description: `Publish ID: ${data.publish_id}` });
      }
    } catch (error) {
      toast({ title: "Schedule failed", description: error instanceof Error ? error.message : "Failed to schedule video", variant: "destructive" });
    } finally {
      setIsScheduling(false);
    }
  };

  return (
    <div className="space-y-6">
      {draftRestored && (
        <div className="flex items-center justify-between rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-4 py-2.5">
          <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">✏️ Draft restored from your previous session</p>
          <button onClick={clearDraft} className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-medium">
            <X className="w-3 h-3" /> Clear Draft
          </button>
        </div>
      )}

      {/* Video Source */}
      <div className="space-y-3">
        <Label className="text-zinc-900 dark:text-white font-medium">Video Source</Label>
        <div className="flex gap-2">
          <button onClick={() => setVideoSource("url")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${videoSource === "url" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
            <LinkIcon className="w-4 h-4" /> External URL
          </button>
          <button onClick={() => setVideoSource("file")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${videoSource === "file" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
            <Upload className="w-4 h-4" /> Local File
          </button>
        </div>

        {videoSource === "url" ? (
          <Input placeholder="https://example.com/video.mp4" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700" />
        ) : (
          <div className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 rounded-lg p-6 text-center">
            <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files?.[0] || null)} className="hidden" id="schedule-video-upload" />
            <label htmlFor="schedule-video-upload" className="cursor-pointer">
              <Upload className="w-8 h-8 mx-auto text-zinc-300 dark:text-zinc-600 mb-2" />
              <p className="text-sm text-zinc-500">{videoFile ? videoFile.name : "Click to select a video file"}</p>
            </label>
          </div>
        )}

        {/* TikTok Video Preview */}
        {(videoSource === "file" && schedulePreviewUrl) && (
          <div className="mt-4">
            <TikTokVideoPreview caption={[title.trim(), caption.trim()].filter(Boolean).join("\n\n")} mediaFile={{ previewUrl: schedulePreviewUrl, fileType: "video" }} username={username} />
          </div>
        )}
        {(videoSource === "url" && videoUrl) && (
          <div className="mt-4">
            <TikTokVideoPreview caption={[title.trim(), caption.trim()].filter(Boolean).join("\n\n")} mediaFile={{ previewUrl: videoUrl, fileType: "video" }} username={username} />
          </div>
        )}
      </div>

      {/* Caption info note */}
      <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2">
        <p className="text-xs text-blue-700 dark:text-blue-300">
          ℹ️ TikTok shows one caption under the video. Title and description will be combined (title on top, blank line, then description).
        </p>
      </div>

      {/* Title */}
      <div className="space-y-2">
        <Label className="text-zinc-900 dark:text-white font-medium">Title <span className="text-destructive">*</span></Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={150}
          placeholder="Title (shown at the top of your video caption)"
          className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700"
        />
        <p className="text-xs text-zinc-400 text-end">{title.length}/150</p>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label className="text-zinc-900 dark:text-white font-medium">Description</Label>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          maxLength={2050}
          rows={3}
          placeholder="Description (appended after the title; shown together as one caption on TikTok)"
          className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600 resize-none"
        />
        <p className="text-xs text-zinc-400 text-end">{caption.length}/2050</p>
      </div>

      {/* Privacy — Dynamic from API */}
      <PrivacySelect
        value={privacy}
        onChange={(v) => {
          setPrivacy(v);
          if (v === "SELF_ONLY") {
            setBrandedContent(false);
            setAllowComment(false);
            setAllowDuet(false);
            setAllowStitch(false);
          }
        }}
        creatorInfo={creatorInfo}
        brandedContent={brandedContent}
      />

      {/* Schedule Date/Time */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label className="text-zinc-900 dark:text-white font-medium">Date</Label>
          <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700" />
        </div>
        <div className="space-y-2">
          <Label className="text-zinc-900 dark:text-white font-medium">Time</Label>
          <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700" />
        </div>
      </div>

      {/* Interaction Toggles — API-driven */}
      <InteractionToggles
        allowComment={allowComment} setAllowComment={setAllowComment}
        allowDuet={allowDuet} setAllowDuet={setAllowDuet}
        allowStitch={allowStitch} setAllowStitch={setAllowStitch}
        privacy={privacy}
        creatorInfo={creatorInfo}
      />

      {/* Commercial Disclosure + AI Generated */}
      <CommercialDisclosure
        discloseContent={discloseContent} setDiscloseContent={setDiscloseContent}
        yourBrand={yourBrand} setYourBrand={setYourBrand}
        brandedContent={brandedContent} setBrandedContent={setBrandedContent}
        aiGenerated={aiGenerated} setAiGenerated={setAiGenerated}
        privacy={privacy} setPrivacy={setPrivacy}
      />

      {/* Music Consent */}
      <MusicConsent
        musicConsent={musicConsent} setMusicConsent={setMusicConsent}
        brandedContent={brandedContent}
      />

      <button
        onClick={handleSchedule}
        disabled={!canSchedule || isScheduling}
        className="flex items-center justify-center gap-2 w-full h-12 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-semibold text-base hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isScheduling ? <Loader2 className="w-5 h-5 animate-spin" /> : <Clock className="w-5 h-5" />}
        Schedule on TikTok
      </button>

      {result && (
        <div className={`rounded-lg border p-4 space-y-2 ${result.success === false ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30' : 'border-zinc-200 dark:border-zinc-800'}`}>
          <p className="text-sm font-medium text-zinc-900 dark:text-white">
            {result.success === false ? "❌ Schedule Failed" : "✅ Video Scheduled"}
          </p>
          {result.publish_id && <p className="text-xs text-zinc-500 mt-1">Publish ID: <code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{result.publish_id}</code></p>}
          {result.user_message && result.success === false && <p className="text-sm text-red-600 dark:text-red-400">{result.user_message}</p>}
          {result.error_code && <p className="text-xs text-zinc-400 font-mono">Error code: {result.error_code}</p>}
        </div>
      )}
    </div>
  );
}

/* ─── Status Check Section ─── */
function StatusSection({ accountId }: { accountId: string }) {
  const { toast } = useToast();
  const [publishId, setPublishId] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [statusResult, setStatusResult] = useState<any>(null);

  const handleCheckStatus = async () => {
    if (!publishId.trim()) return;
    setIsChecking(true);
    setStatusResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("tiktok-demo-publish", {
        body: { action: "status", social_account_id: accountId, publish_id: publishId.trim() },
      });
      if (error) throw error;
      setStatusResult(data);
    } catch (error) {
      toast({ title: "Status check failed", description: error instanceof Error ? error.message : "Failed to check status", variant: "destructive" });
    } finally {
      setIsChecking(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PUBLISH_COMPLETE":
        return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3" /> Published</span>;
      case "PROCESSING_UPLOAD":
      case "PROCESSING_DOWNLOAD":
        return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 px-2 py-1 rounded-full"><Clock className="w-3 h-3" /> Processing</span>;
      case "FAILED":
        return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 dark:bg-red-950 dark:text-red-400 px-2 py-1 rounded-full"><AlertCircle className="w-3 h-3" /> Failed</span>;
      default:
        return <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400 px-2 py-1 rounded-full">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-zinc-900 dark:text-white font-medium">Publish ID</Label>
        <Input placeholder="Enter a publish ID to check its status" value={publishId} onChange={(e) => setPublishId(e.target.value)} className="bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700" />
      </div>

      <button
        onClick={handleCheckStatus}
        disabled={!publishId.trim() || isChecking}
        className="flex items-center justify-center gap-2 w-full h-12 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 font-semibold text-base hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isChecking ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
        Check Status
      </button>

      {statusResult && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-900 dark:text-white">Publish Status</p>
            {statusResult.status && getStatusBadge(statusResult.status)}
          </div>
          {statusResult.publicaly_available_post_id && (
            <div>
              <p className="text-xs text-zinc-400">Post ID</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 font-mono">{statusResult.publicaly_available_post_id}</p>
            </div>
          )}
          {statusResult.fail_reason && (
            <div>
              <p className="text-xs text-zinc-400">Fail Reason</p>
              <p className="text-sm text-red-500">{statusResult.fail_reason}</p>
            </div>
          )}
          {statusResult.uploaded_bytes !== undefined && (
            <div>
              <p className="text-xs text-zinc-400">Upload Progress</p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{statusResult.uploaded_bytes} bytes uploaded</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
