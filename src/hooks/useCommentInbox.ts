import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import { useRealtimeQueryInvalidation } from "./useRealtimeQueryInvalidation";

export interface Comment {
  id: string;
  author_name: string;
  author_id?: string;
  author_avatar?: string | null;
  message: string;
  created_time: string;
  is_hidden?: boolean;
  is_reply?: boolean;
  parent_id?: string;
  post_id?: string;
  post_message?: string;
  like_count?: number;
  platform: "facebook" | "instagram";
  replies?: Comment[];
}

interface UseCommentsOptions {
  platform: "facebook" | "instagram";
  socialAccountId: string | null;
  pageId?: string;
  igUserId?: string;
  enabled?: boolean;
}

function parsePageComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const post of data.data) {
    if (!post.comments?.data) continue;
    for (const c of post.comments.data) {
      // Facebook's picture field returns { data: { url, is_silhouette } }. A
      // silhouette is Meta's placeholder for "no real photo available", not a
      // usable image, so treat it the same as no avatar.
      const picture = c.from?.picture?.data;
      comments.push({
        id: c.id,
        author_name: c.from?.name || "Unknown",
        author_id: c.from?.id,
        author_avatar: picture && !picture.is_silhouette ? picture.url : null,
        message: c.message || "",
        created_time: c.created_time,
        is_hidden: c.is_hidden || false,
        // The feed request asks for the `stream` filter, so replies arrive in the same
        // flat list as the comments they answer, each carrying its parent. Reading it
        // here is what lets the inbox render a thread instead of a pile.
        is_reply: Boolean(c.parent?.id),
        parent_id: c.parent?.id,
        post_id: post.id,
        post_message: post.message || "",
        platform: "facebook",
      });
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}

function parseIgComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const media of data.data) {
    const engagement = media.like_count != null || media.comments_count != null
      ? `${media.like_count ?? 0} likes · ${media.comments_count ?? 0} comments`
      : "";
    const postLabel = media.caption
      ? `${media.caption}${engagement ? ` · ${engagement}` : ""}`
      : (engagement ? `[${media.media_type || "media"}] ${engagement}` : "");
    if (!media.comments?.data) continue;
    for (const c of media.comments.data) {
      comments.push({
        id: c.id,
        author_name: c.from?.username || c.username || "Unknown",
        author_id: c.from?.id,
        author_avatar: c.author_avatar || null,
        message: c.text || "",
        like_count: c.like_count,
        created_time: c.timestamp,
        is_hidden: c.hidden || false,
        is_reply: false,
        post_id: media.id,
        post_message: postLabel,
        platform: "instagram",
      });
      // Flatten replies so they show in the inbox as well.
      const replies = c.replies?.data || [];
      for (const r of replies) {
        comments.push({
          id: r.id,
          author_name: r.from?.username || r.username || "Unknown",
          author_id: r.from?.id,
          author_avatar: r.author_avatar || null,
          message: r.text || "",
          like_count: r.like_count,
          created_time: r.timestamp,
          is_hidden: r.hidden || false,
          is_reply: true,
          parent_id: c.id,
          post_id: media.id,
          post_message: postLabel,
          platform: "instagram",
        });
      }
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}

// comment-manager returns Meta-side failures as a 200 response with an
// error/error_type field in the body, not a transport-level error — every
// caller must check this or a rejected Meta call (e.g. a hide/reply Meta
// rejects) gets reported as a false success.
function throwIfCommentManagerError(data: any): void {
  if (!data?.error_type && !data?.error) return;
  const rawErr = data.error;
  let message: string;
  if (typeof rawErr === "string") {
    message = rawErr;
  } else if (rawErr && typeof rawErr === "object") {
    const e = rawErr as {
      error_user_msg?: string;
      message?: string;
      error?: { message?: string };
      error_description?: string;
    };
    message =
      e.error_user_msg ||
      e.message ||
      e.error?.message ||
      e.error_description ||
      JSON.stringify(rawErr);
  } else {
    message = "Comment manager request failed";
  }
  const err = new Error(message) as Error & { errorType?: string };
  err.errorType = data.error_type;
  throw err;
}

export function useComments({ platform, socialAccountId, pageId, igUserId, enabled = true }: UseCommentsOptions) {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: ["comments", platform, socialAccountId],
    queryFn: async () => {
      const action = platform === "facebook" ? "get_page_comments" : "get_ig_comments";
      const { data, error } = await supabase.functions.invoke("comment-manager", {
        body: {
          action,
          social_account_id: socialAccountId,
          page_id: pageId,
          ig_user_id: igUserId,
        },
      });
      if (error) throw error;
      throwIfCommentManagerError(data);
      return platform === "facebook" ? parsePageComments(data) : parseIgComments(data);
    },
    enabled: enabled && !!socialAccountId && (!!pageId || !!igUserId),
    staleTime: 60 * 1000,
    refetchInterval: 30_000,
  });
  useRealtimeQueryInvalidation({
    table: "social_inbox_events",
    userId: session?.user?.id,
    socialAccountId,
    queryKey: ["comments", platform, socialAccountId],
  });
  return query;
}

export function useReplyComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, message, socialAccountId }: { commentId: string; message: string; socialAccountId: string }) => {
      const { data, error } = await supabase.functions.invoke("comment-manager", {
        body: { action: "reply_comment", comment_id: commentId, message, social_account_id: socialAccountId },
      });
      if (error) throw error;
      throwIfCommentManagerError(data);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comments"] });
      toast({ title: "Reply sent", description: "Your reply has been posted." });
    },
    onError: (error) => {
      toast({ title: "Reply failed", description: error.message, variant: "destructive" });
    },
  });
}

export function useHideComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, socialAccountId, isHidden = true }: { commentId: string; socialAccountId: string; isHidden?: boolean }) => {
      const { data, error } = await supabase.functions.invoke("comment-manager", {
        body: { action: "hide_comment", comment_id: commentId, social_account_id: socialAccountId, is_hidden: isHidden },
      });
      if (error) throw error;
      throwIfCommentManagerError(data);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comments"] });
      toast({ title: "Comment updated", description: "Comment visibility changed." });
    },
    onError: (error) => {
      toast({ title: "Action failed", description: error.message, variant: "destructive" });
    },
  });
}

export function useDeleteComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ commentId, socialAccountId }: { commentId: string; socialAccountId: string }) => {
      const { data, error } = await supabase.functions.invoke("comment-manager", {
        body: { action: "delete_comment", comment_id: commentId, social_account_id: socialAccountId },
      });
      if (error) throw error;
      throwIfCommentManagerError(data);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comments"] });
      toast({ title: "Comment deleted", description: "The comment has been removed." });
    },
    onError: (error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });
}
