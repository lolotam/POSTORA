import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, ExternalLink, Mic, Sparkles, Trash2, MessageSquarePlus, Send } from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useTranscription } from "@/hooks/useTranscription";
import { useOwnedThreadsAccounts } from "@/hooks/useOwnedThreadsAccounts";
import { TranscriptPanel } from "./TranscriptPanel";
import { ContentGenerationPanel } from "./ContentGenerationPanel";
import { mapThreadsReason } from "./ThreadsErrorCard";
import type { BrandPost } from "@/types/brand-intelligence";

interface PostDetailDrawerProps {
  post: BrandPost | null;
  isOpen: boolean;
  onClose: () => void;
  /** Username of the profile being viewed (used to detect owned posts for Delete) */
  platformUsername?: string;
  /** Called after a successful Threads delete so the parent can update its grid */
  onDeleted?: (postId: string) => void;
}

function highlightText(text: string) {
  return text.split(/(\s)/).map((word, i) => {
    if (word.startsWith("#")) return <span key={i} className="text-violet-400 font-medium">{word}</span>;
    if (word.startsWith("@")) return <span key={i} className="text-blue-400">{word}</span>;
    return word;
  });
}

export function PostDetailDrawer({ post, isOpen, onClose, platformUsername, onDeleted }: PostDetailDrawerProps) {
  const { t } = useTranslation("analytics");
  const [showGeneration, setShowGeneration] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [isCommenting, setIsCommenting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCommentBox, setShowCommentBox] = useState(false);
  const { transcript, language, duration, isTranscribing, transcribe } = useTranscription();
  const { ownsUsername } = useOwnedThreadsAccounts();

  if (!post) return null;

  const ownedAccountId = ownsUsername(platformUsername);

  const isVideo = post.mediaType === "VIDEO" || post.mediaType === "REEL";
  const isTikTokEmbed = !!post.mediaUrl && /tiktok\.com\/(embed|player)/i.test(post.mediaUrl);
  const formatDuration = (s?: number) => {
    if (!s || s <= 0) return null;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  };
  const durationLabel = formatDuration(post.duration);

  const stats = [
    { id: "likes", emoji: "❤️", label: t("stats.likes", "Likes"), value: post.likesCount },
    { id: "comments", emoji: "💬", label: t("stats.comments", "Comments"), value: post.commentsCount },
    { id: "views", emoji: "▶️", label: t("stats.views", "Views"), value: post.videoViewCount || 0 },
    { id: "shares", emoji: "🔁", label: t("stats.shares", "Shares"), value: post.sharesCount || 0 },
    { id: "saves", emoji: "🔖", label: t("stats.saves", "Saves"), value: post.savesCount || 0 },
    { id: "score", emoji: "🔥", label: t("stats.score", "Score"), value: post.engagementScore },
  ];

  const handleDelete = async () => {
    if (!ownedAccountId) return;
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("threads-delete-post", {
        body: { thread_id: post.id, social_account_id: ownedAccountId },
      });
      if (error) throw new Error(error.message || t("errors.deleteFailed", "Delete failed"));
      if (data && data.ok === false) {
        const mapped = mapThreadsReason(data, "discovery");
        toast.error(mapped.message || t("errors.couldNotDelete", "Could not delete on Threads"));
        return;
      }
      toast.success(t("toast.postDeleted", "Post deleted from Threads"));
      onDeleted?.(post.id);
      onClose();
    } catch (err) {
      toast.error((err as Error).message || t("errors.deleteFailed", "Delete failed"));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleComment = async () => {
    const text = commentText.trim();
    if (!text) {
      toast.error(t("errors.commentEmpty", "Comment cannot be empty"));
      return;
    }
    setIsCommenting(true);
    try {
      const { data, error } = await supabase.functions.invoke("threads-comment", {
        body: {
          thread_id: post.id,
          text,
          ...(ownedAccountId ? { social_account_id: ownedAccountId } : {}),
        },
      });
      if (error) throw new Error(error.message || t("errors.commentFailed", "Comment failed"));
      if (data && data.ok === false) {
        const mapped = mapThreadsReason(data, "discovery");
        toast.error(mapped.message || t("errors.couldNotComment", "Could not post comment"));
        return;
      }
      const permalink: string | undefined = data?.permalink;
      if (permalink) {
        toast.success(t("toast.commentPosted", "Comment posted on Threads"), {
          action: { label: t("common:view", "View"), onClick: () => window.open(permalink, "_blank") },
        });
      } else {
        toast.success(t("toast.commentPosted", "Comment posted on Threads"));
      }
      setCommentText("");
      setShowCommentBox(false);
    } catch (err) {
      const msg = (err as Error).message || t("errors.commentFailed", "Comment failed");
      const friendly = /Failed to send a request to the Edge Function/i.test(msg)
        ? t("errors.commentUnavailable", "Comment service is temporarily unavailable. Please try again in a moment.")
        : msg;
      toast.error(friendly);
    } finally {
      setIsCommenting(false);
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[580px] overflow-y-auto p-0">
        <SheetHeader className="p-4 pb-0">
          <SheetTitle className="text-lg">{t("posts.title", "Post Details")}</SheetTitle>
        </SheetHeader>

        <div className="p-4 space-y-4">
          {/* Media Preview */}
          <div className="rounded-lg overflow-hidden bg-muted relative">
            {isVideo && isTikTokEmbed ? (
              <div className="relative w-full" style={{ aspectRatio: "9 / 16", maxHeight: 500 }}>
                <iframe
                  src={post.mediaUrl}
                  title={t("video.tiktokTitle", "TikTok video")}
                  allow="encrypted-media;"
                  allowFullScreen
                  className="absolute inset-0 w-full h-full border-0"
                />
              </div>
            ) : isVideo && post.mediaUrl ? (
              <video
                src={post.mediaUrl}
                controls
                poster={post.thumbnailUrl}
                className="w-full max-h-[400px] object-contain"
              />
            ) : post.thumbnailUrl || post.mediaUrl ? (
              <img
                src={post.thumbnailUrl || post.mediaUrl}
                alt=""
                className="w-full max-h-[400px] object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="w-full h-64 flex items-center justify-center text-muted-foreground text-sm">
                {t("posts.previewUnavailable", "Preview unavailable")}
              </div>
            )}
            {durationLabel && (
              <Badge variant="secondary" className="absolute bottom-2 end-2 bg-black/70 text-white border-0 text-xs">
                ⏱ {durationLabel}
              </Badge>
            )}
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-2">
            {stats.map((s) => (
              <Card key={s.id} className="overflow-hidden">
                <CardContent className="p-3 text-center">
                  <p className="text-xs text-muted-foreground">{s.emoji} {s.label}</p>
                  <p className="text-sm font-bold">{s.value.toLocaleString()}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Caption */}
          {post.caption && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t("posts.caption", "Caption")}</p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{highlightText(post.caption)}</p>
            </div>
          )}

          {/* Meta */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {post.timestamp && (
              <span>{format(new Date(post.timestamp), "MMMM d, yyyy • h:mm a")}</span>
            )}
            {post.permalink && (
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" asChild>
                <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                  {t("posts.viewOriginal", "View Original")} <ExternalLink className="w-3 h-3" />
                </a>
              </Button>
            )}
          </div>

          {/* Threads actions: comment + delete */}
          <div className="space-y-2 pt-2 border-t">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowCommentBox((v) => !v)}
              >
                <MessageSquarePlus className="w-4 h-4" />
                {t("actions.addComment", "Add comment")}
              </Button>

              {ownedAccountId && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive">
                      <Trash2 className="w-4 h-4" />
                      {t("actions.deleteFromThreads", "Delete from Threads")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("dialog.deleteThreadsTitle", "Delete this post from Threads?")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("dialog.deleteThreadsBody", "This removes the post from Meta. Your local history record stays so you can still see it here.")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
                        {isDeleting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
                        {t("common:delete", "Delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>

            {showCommentBox && (
              <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                <Textarea
                  placeholder={t("keyword.replyPlaceholder", "Write a reply…")}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  maxLength={500}
                  rows={3}
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{commentText.length}/500</p>
                  <Button size="sm" className="gap-1.5" onClick={handleComment} disabled={isCommenting || !commentText.trim()}>
                    {isCommenting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    {t("actions.postComment", "Post comment")}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="space-y-2 pt-2 border-t">
            {isVideo && (
              <>
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => post.mediaUrl && transcribe(post.mediaUrl)}
                  disabled={isTranscribing}
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("transcript.transcribing", "Transcribing with AI...")}
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4" />
                      {t("actions.transcribeAudio", "🎙 Transcribe Audio")}
                    </>
                  )}
                </Button>

                {transcript && (
                  <TranscriptPanel
                    transcript={transcript}
                    language={language}
                    duration={duration}
                    onUseTranscript={() => setShowGeneration(true)}
                  />
                )}
              </>
            )}

            <Button
              className="w-full gap-2 bg-gradient-to-r from-violet-500 to-pink-500 hover:from-violet-600 hover:to-pink-600 text-white border-0"
              onClick={() => setShowGeneration(!showGeneration)}
            >
              <Sparkles className="w-4 h-4" />
              {t("actions.generateContent", "✨ Generate Content from this Post")}
            </Button>

            {showGeneration && (
              <ContentGenerationPanel
                sourceText={transcript || post.caption || ""}
                sourcePost={post}
              />
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
