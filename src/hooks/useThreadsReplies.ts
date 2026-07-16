import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ThreadSummary {
  id: string;
  text?: string | null;
  timestamp?: string | null;
  permalink?: string | null;
  media_type?: string | null;
}

export interface ThreadsReply {
  id: string;
  text?: string | null;
  username?: string | null;
  permalink?: string | null;
  timestamp?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  thumbnail_url?: string | null;
  has_replies?: boolean;
  is_reply?: boolean;
  is_reply_owned_by_me?: boolean;
  reply_audience?: string | null;
  hide_status?: string | null;
  root_post?: { id: string } | null;
  replied_to?: { id: string } | null;
}

export interface ReplyQuota {
  reply_quota_usage?: number;
  reply_config?: {
    quota_total?: number;
    quota_duration?: number;
  };
}

type EdgeResponse<T = unknown> = {
  ok: boolean;
  reason?: string;
  message?: string;
} & T;

/* -------------------------------------------------------------------------- */
/*  Reason → user-friendly toast                                              */
/* -------------------------------------------------------------------------- */

export function reasonToMessage(reason?: string, fallback?: string): string {
  switch (reason) {
    case "bad_request":
      return fallback || "Missing required field";
    case "expired_token":
      return "Your Threads connection has expired. Please reconnect.";
    case "missing_scope":
    case "permission_not_approved":
      return "Reconnect Threads to enable replies";
    case "invalid_media_id":
      return "That Threads post could not be found";
    case "rate_limited":
      return "You're replying too fast — try again shortly";
    case "reply_not_manageable":
      return "This reply cannot be managed";
    case "unsupported_feature":
      return "This action is not supported for your account";
    case "network_error":
      return "Network error — check your connection and try again";
    case "media_processing_failed":
      return fallback || "Threads could not process your media. Try a different file.";
    case "media_processing_timeout":
      return "Threads took too long to process your media. Please try again.";
    case "invalid_response":
      return "Threads returned an unexpected response";
    case "http_error":
      return "Threads returned an unexpected error — please try again";
    case "no_account":
      return "Threads account not found or inactive";
    case "unauthorized":
      return "Please sign in again";
    default:
      return fallback || "Something went wrong";
  }
}

/* -------------------------------------------------------------------------- */
/*  Edge function invocation helper                                           */
/* -------------------------------------------------------------------------- */

async function invokeEdge<T>(
  fn: "threads-replies" | "threads-manage-reply" | "threads-reply",
  body: Record<string, unknown>,
): Promise<EdgeResponse<T>> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    return { ok: false, reason: "network_error", message: error.message } as EdgeResponse<T>;
  }
  return (data || { ok: false, reason: "unknown", message: "No response" }) as EdgeResponse<T>;
}

/* -------------------------------------------------------------------------- */
/*  Query key helpers                                                         */
/* -------------------------------------------------------------------------- */

const keys = {
  userThreads: (accountId: string | null) => ["threads-replies", "user-threads", accountId] as const,
  threadReplies: (accountId: string | null, mediaId: string | null) =>
    ["threads-replies", "thread-replies", accountId, mediaId] as const,
  threadConversation: (accountId: string | null, mediaId: string | null) =>
    ["threads-replies", "thread-conversation", accountId, mediaId] as const,
  userReplies: (accountId: string | null) => ["threads-replies", "user-replies", accountId] as const,
  pendingReplies: (accountId: string | null) => ["threads-replies", "pending", accountId] as const,
  quota: (accountId: string | null) => ["threads-replies", "quota", accountId] as const,
  capability: (accountId: string | null) => ["threads-replies", "capability", accountId] as const,
};

/* -------------------------------------------------------------------------- */
/*  Session reset (mirror of clearMentionsSessionState)                       */
/* -------------------------------------------------------------------------- */

const REPLIES_CLEAR_EVENT = "threads-replies:clear";

export function clearRepliesSessionState() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith("threads-replies:")) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
    window.dispatchEvent(new CustomEvent(REPLIES_CLEAR_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * Drops all cached `["threads-replies", ...]` React Query entries when the
 * authed user changes or when `clearRepliesSessionState()` fires its event.
 * Mount inside any Replies-tab parent so the next render refetches fresh data.
 */
export function useClearRepliesOnSignout() {
  const qc = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const previousUserRef = useRef<string | null>(userId);

  // Clear cache when user identity changes (logout, or re-login as another user).
  useEffect(() => {
    if (previousUserRef.current !== userId) {
      previousUserRef.current = userId;
      qc.removeQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey[0] === "threads-replies",
      });
    }
  }, [userId, qc]);

  // Clear cache when an explicit logout event is dispatched.
  useEffect(() => {
    const handler = () => {
      qc.removeQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey[0] === "threads-replies",
      });
    };
    window.addEventListener(REPLIES_CLEAR_EVENT, handler);
    return () => window.removeEventListener(REPLIES_CLEAR_EVENT, handler);
  }, [qc]);
}

/* -------------------------------------------------------------------------- */
/*  Read hooks                                                                */
/* -------------------------------------------------------------------------- */

/** Infinite paginated picker — page size 10, halts when paging.cursors.after is missing. */
export function useUserThreadsInfinite(accountId: string | null) {
  const { session } = useAuth();
  return useInfiniteQuery({
    queryKey: keys.userThreads(accountId),
    enabled: !!accountId && !!session?.user?.id,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const res = await invokeEdge<{ data: ThreadSummary[]; paging: any }>("threads-replies", {
        action: "get_user_threads",
        social_account_id: accountId,
        limit: 10,
        after: pageParam,
      });
      if (!res.ok) {
        throw new Error(reasonToMessage(res.reason, res.message));
      }
      return res;
    },
    getNextPageParam: (last) => last?.paging?.cursors?.after ?? undefined,
  });
}

export function useThreadReplies(accountId: string | null, mediaId: string | null) {
  return useQuery({
    queryKey: keys.threadReplies(accountId, mediaId),
    enabled: !!accountId && !!mediaId,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
        action: "get_thread_replies",
        social_account_id: accountId,
        media_id: mediaId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.data || [];
    },
  });
}

export function useThreadConversation(accountId: string | null, mediaId: string | null) {
  return useQuery({
    queryKey: keys.threadConversation(accountId, mediaId),
    enabled: !!accountId && !!mediaId,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
        action: "get_thread_conversation",
        social_account_id: accountId,
        media_id: mediaId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.data || [];
    },
  });
}

export function useUserReplies(accountId: string | null) {
  return useQuery({
    queryKey: keys.userReplies(accountId),
    enabled: !!accountId,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
        action: "get_user_replies",
        social_account_id: accountId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.data || [];
    },
  });
}

/**
 * Fetch the full conversation for many media (post) IDs in parallel.
 * Shares its cache key with `useThreadConversation` so switching between the
 * Conversation tab and the My Replies tab is instant.
 */
export function useConversationsForMedia(
  accountId: string | null,
  mediaIds: string[],
) {
  const uniqueIds = useMemo(
    () => Array.from(new Set(mediaIds.filter(Boolean))),
    [mediaIds],
  );

  const queries = useQueries({
    queries: uniqueIds.map((mediaId) => ({
      queryKey: keys.threadConversation(accountId, mediaId),
      enabled: !!accountId && !!mediaId,
      placeholderData: keepPreviousData,
      queryFn: async () => {
        const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
          action: "get_thread_conversation",
          social_account_id: accountId,
          media_id: mediaId,
        });
        if (!res.ok)
          throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), {
            reason: res.reason,
          });
        return res.data || [];
      },
    })),
  });

  return useMemo(() => {
    const byMediaId: Record<string, ThreadsReply[]> = {};
    const errorsByMediaId: Record<string, Error | null> = {};
    const loadingByMediaId: Record<string, boolean> = {};
    uniqueIds.forEach((id, i) => {
      const q = queries[i];
      byMediaId[id] = (q?.data as ThreadsReply[]) || [];
      errorsByMediaId[id] = (q?.error as Error) || null;
      loadingByMediaId[id] = !!q?.isLoading;
    });
    return {
      byMediaId,
      errorsByMediaId,
      loadingByMediaId,
      isLoading: queries.some((q) => q.isLoading),
      refetch: (id: string) => {
        const i = uniqueIds.indexOf(id);
        if (i >= 0) queries[i]?.refetch();
      },
    };
  }, [uniqueIds, queries]);
}

export function usePendingReplies(accountId: string | null) {
  return useQuery({
    queryKey: keys.pendingReplies(accountId),
    enabled: !!accountId,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
        action: "get_pending_replies",
        social_account_id: accountId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.data || [];
    },
  });
}

export function useThreadPost(accountId: string | null, mediaId: string | null) {
  return useQuery({
    queryKey: ["threads-replies", "post", accountId, mediaId] as const,
    enabled: !!accountId && !!mediaId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply | null }>("threads-replies", {
        action: "get_post",
        social_account_id: accountId,
        media_id: mediaId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.data ?? null;
    },
  });
}

export function useReplyQuota(accountId: string | null) {
  return useQuery({
    queryKey: keys.quota(accountId),
    enabled: !!accountId,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await invokeEdge<{ quota: ReplyQuota | null }>("threads-replies", {
        action: "get_reply_quota",
        social_account_id: accountId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res.quota;
    },
  });
}

/** Lightweight capability probe — runs once per account. */
export function useReplyCapability(accountId: string | null) {
  return useQuery({
    queryKey: keys.capability(accountId),
    enabled: !!accountId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await invokeEdge<{ data: ThreadsReply[] }>("threads-replies", {
        action: "get_user_replies",
        social_account_id: accountId,
        limit: 1,
      });
      // We only care whether the call would have succeeded for replies access
      if (res.ok) return { ok: true as const };
      const reason = res.reason || "unknown";
      const needsReconnect =
        reason === "missing_scope" ||
        reason === "permission_not_approved" ||
        reason === "expired_token" ||
        reason === "invalid_token";
      return { ok: false as const, reason, needsReconnect };
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Mutations (with optimistic patching)                                      */
/* -------------------------------------------------------------------------- */

function patchReplyInLists(
  qc: ReturnType<typeof useQueryClient>,
  accountId: string | null,
  replyId: string,
  patch: Partial<ThreadsReply>,
) {
  const all = qc.getQueriesData<ThreadsReply[]>({
    predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "threads-replies" && q.queryKey.includes(accountId),
  });
  for (const [key, list] of all) {
    if (!Array.isArray(list)) continue;
    qc.setQueryData(key, list.map((r) => (r.id === replyId ? { ...r, ...patch } : r)));
  }
}

async function upsertCacheRow(
  userId: string,
  socialAccountId: string,
  mediaId: string,
  reply: ThreadsReply,
  status: "visible" | "hidden" | "pending" | "approved" | "rejected",
) {
  await supabase.from("threads_reply_cache").upsert(
    {
      user_id: userId,
      social_account_id: socialAccountId,
      media_id: mediaId,
      reply_id: reply.id,
      parent_id: reply.replied_to?.id ?? null,
      root_post_id: reply.root_post?.id ?? null,
      username: reply.username ?? null,
      text: reply.text ?? null,
      permalink: reply.permalink ?? null,
      timestamp: reply.timestamp ?? null,
      media_type: reply.media_type ?? null,
      media_url: reply.media_url ?? null,
      thumbnail_url: reply.thumbnail_url ?? null,
      has_replies: reply.has_replies ?? false,
      is_reply: reply.is_reply ?? true,
      is_reply_owned_by_me: reply.is_reply_owned_by_me ?? false,
      hide_status: reply.hide_status ?? null,
      reply_audience: reply.reply_audience ?? null,
      status,
      raw_data: reply as any,
    },
    { onConflict: "social_account_id,reply_id" },
  );
}

export function useThreadsReplyMutations(accountId: string | null) {
  const qc = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id;

  const invalidate = useCallback(() => {
    if (!accountId) return;
    qc.invalidateQueries({
      predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "threads-replies" && q.queryKey.includes(accountId),
    });
  }, [qc, accountId]);

  const hide = useMutation({
    mutationFn: async (replyId: string) => {
      if (!accountId) throw new Error("No account selected");
      const res = await invokeEdge<{ reply_id: string }>("threads-manage-reply", {
        action: "hide_reply",
        social_account_id: accountId,
        reply_id: replyId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res;
    },
    onMutate: async (replyId) => {
      patchReplyInLists(qc, accountId, replyId, { hide_status: "HIDDEN" });
    },
    onSuccess: async (_d, replyId) => {
      toast({ title: "Reply hidden", description: "The reply is no longer visible to others." });
      if (userId && accountId) {
        await supabase
          .from("threads_reply_cache")
          .update({ status: "hidden", hide_status: "HIDDEN" })
          .eq("social_account_id", accountId)
          .eq("reply_id", replyId);
      }
    },
    onError: (err: Error) => {
      toast({ title: "Could not hide reply", description: err.message, variant: "destructive" });
      invalidate();
    },
    onSettled: invalidate,
  });

  const unhide = useMutation({
    mutationFn: async (replyId: string) => {
      if (!accountId) throw new Error("No account selected");
      const res = await invokeEdge<{ reply_id: string }>("threads-manage-reply", {
        action: "unhide_reply",
        social_account_id: accountId,
        reply_id: replyId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res;
    },
    onMutate: async (replyId) => {
      patchReplyInLists(qc, accountId, replyId, { hide_status: "NOT_HUSHED" });
    },
    onSuccess: async (_d, replyId) => {
      toast({ title: "Reply unhidden", description: "The reply is visible again." });
      if (userId && accountId) {
        await supabase
          .from("threads_reply_cache")
          .update({ status: "visible", hide_status: null })
          .eq("social_account_id", accountId)
          .eq("reply_id", replyId);
      }
    },
    onError: (err: Error) => {
      toast({ title: "Could not unhide reply", description: err.message, variant: "destructive" });
      invalidate();
    },
    onSettled: invalidate,
  });

  const approve = useMutation({
    mutationFn: async (replyId: string) => {
      if (!accountId) throw new Error("No account selected");
      const res = await invokeEdge<{ reply_id: string }>("threads-manage-reply", {
        action: "approve_pending_reply",
        social_account_id: accountId,
        reply_id: replyId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res;
    },
    onMutate: async (replyId) => {
      patchReplyInLists(qc, accountId, replyId, { hide_status: "NOT_HUSHED" });
    },
    onSuccess: async (_d, replyId) => {
      toast({ title: "Reply approved" });
      if (userId && accountId) {
        await supabase
          .from("threads_reply_cache")
          .update({ status: "approved" })
          .eq("social_account_id", accountId)
          .eq("reply_id", replyId);
      }
    },
    onError: (err: Error) => {
      toast({ title: "Could not approve reply", description: err.message, variant: "destructive" });
      invalidate();
    },
    onSettled: invalidate,
  });

  const reject = useMutation({
    mutationFn: async (replyId: string) => {
      if (!accountId) throw new Error("No account selected");
      const res = await invokeEdge<{ reply_id: string }>("threads-manage-reply", {
        action: "reject_pending_reply",
        social_account_id: accountId,
        reply_id: replyId,
      });
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res;
    },
    onMutate: async (replyId) => {
      patchReplyInLists(qc, accountId, replyId, { hide_status: "HIDDEN" });
    },
    onSuccess: async (_d, replyId) => {
      toast({ title: "Reply rejected" });
      if (userId && accountId) {
        await supabase
          .from("threads_reply_cache")
          .update({ status: "rejected", hide_status: "HIDDEN" })
          .eq("social_account_id", accountId)
          .eq("reply_id", replyId);
      }
    },
    onError: (err: Error) => {
      toast({ title: "Could not reject reply", description: err.message, variant: "destructive" });
      invalidate();
    },
    onSettled: invalidate,
  });

  const createReply = useMutation({
    mutationFn: async (input: {
      reply_to_id: string;
      text: string;
      media_id?: string;
      topic_tag?: string;
      media_type?: "IMAGE" | "VIDEO";
      media_url?: string;
    }) => {
      if (!accountId) throw new Error("No account selected");
      // Client-side mirror of edge validation for instant feedback
      const cleanText = input.text.trim();
      const hasMedia = !!(input.media_type && input.media_url);
      if (!cleanText && !hasMedia) throw new Error("Reply text or media is required");
      if (!input.reply_to_id.trim()) throw new Error("Missing reply target");

      // Client-side mirror of topic-tag sanitization
      const rawTopic = (input.topic_tag ?? "").trim();
      const cleanedTopic = rawTopic ? rawTopic.replace(/[.&]/g, "").slice(0, 50).trim() : "";

      const res = await invokeEdge<{
        reply_id: string;
        permalink: string | null;
        truncated: boolean;
        topic_tag_debug?: Record<string, unknown>;
      }>(
        "threads-reply",
        {
          action: "create_reply",
          social_account_id: accountId,
          reply_to_id: input.reply_to_id,
          text: cleanText,
          ...(hasMedia ? { media_type: input.media_type, media_url: input.media_url } : {}),
          ...(cleanedTopic ? { topic_tag: cleanedTopic } : rawTopic ? { topic_tag: rawTopic } : {}),
        },
      );
      if (!res.ok) throw Object.assign(new Error(reasonToMessage(res.reason, res.message)), { reason: res.reason });
      return res;
    },
    onSuccess: async (data, input) => {
      const desc = data.truncated ? "Your reply was published (text was truncated to 500 chars)." : "Your reply was published.";
      if (data.permalink) {
        toast({
          title: "Reply sent",
          description: desc,
          action: undefined,
        });
      } else {
        toast({ title: "Reply sent", description: desc });
      }
      if (userId && accountId && input.media_id && data.reply_id) {
        await upsertCacheRow(userId, accountId, input.media_id, {
          id: data.reply_id,
          text: input.text,
          permalink: data.permalink ?? null,
          timestamp: new Date().toISOString(),
          is_reply: true,
          is_reply_owned_by_me: true,
          replied_to: { id: input.reply_to_id },
          // Surface topic-tag debug into raw_data for History view
          ...(data.topic_tag_debug ? { topic_tag_debug: data.topic_tag_debug } : {}),
        }, "visible");
      }
    },
    onError: (err: Error) => {
      toast({ title: "Could not send reply", description: err.message, variant: "destructive" });
    },
    onSettled: invalidate,
  });

  return useMemo(
    () => ({ hide, unhide, approve, reject, createReply }),
    [hide, unhide, approve, reject, createReply],
  );
}
