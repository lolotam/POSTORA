import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import { useRealtimeQueryInvalidation } from "./useRealtimeQueryInvalidation";

export type ThreadsMentionStatus = "new" | "read" | "archived" | "replied";
export type ThreadsMentionSentiment = "positive" | "neutral" | "negative" | "unknown";

export interface ThreadsMention {
  id: string;
  user_id: string;
  social_account_id: string;
  threads_media_id: string | null;
  mention_id: string;
  mention_author_id: string | null;
  mention_author_username: string | null;
  mention_author_avatar_url: string | null;
  mention_text: string | null;
  mention_permalink: string | null;
  mentioned_at: string | null;
  status: ThreadsMentionStatus;
  raw_response: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // V2 fields
  has_reply: boolean;
  reply_text: string | null;
  reply_platform_post_id: string | null;
  reply_permalink: string | null;
  replied_at: string | null;
  replied_by: string | null;
  reply_error: string | null;
  sentiment: ThreadsMentionSentiment;
  labels: string[];
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  last_synced_at: string | null;
  source: "manual" | "webhook";
  notified_at: string | null;
}

const PRIMED_KEY_PREFIX = "threads-mentions:primed:";

function primedKey(userId: string | null | undefined): string | null {
  return userId ? `${PRIMED_KEY_PREFIX}${userId}` : null;
}

export function markMentionsPrimed(userId: string | null | undefined) {
  const key = primedKey(userId);
  if (!key) return;
  try {
    sessionStorage.setItem(key, "1");
    window.dispatchEvent(new CustomEvent("threads-mentions:primed-changed"));
  } catch {
    /* ignore */
  }
}

export function clearMentionsSessionState() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(PRIMED_KEY_PREFIX) || k === "threads-mentions:filters")) {
        keys.push(k);
      }
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export function useMentionsSessionPrimed() {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [primed, setPrimed] = useState<boolean>(() => {
    const key = primedKey(userId);
    if (!key) return false;
    try {
      return sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const key = primedKey(userId);
    if (!key) {
      setPrimed(false);
      return;
    }
    try {
      setPrimed(sessionStorage.getItem(key) === "1");
    } catch {
      setPrimed(false);
    }
    const handler = () => {
      try {
        setPrimed(sessionStorage.getItem(key) === "1");
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("threads-mentions:primed-changed", handler);
    return () => window.removeEventListener("threads-mentions:primed-changed", handler);
  }, [userId]);

  const markPrimed = useCallback(() => markMentionsPrimed(userId), [userId]);

  return { primed, markPrimed };
}

/**
 * Loads stored Threads mentions for a connected account, newest first.
 */
export function useThreadsMentions(
  socialAccountId: string | null,
  options?: { enabled?: boolean },
) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const gateEnabled = options?.enabled !== false;

  const query = useQuery({
    queryKey: ["threads-mentions", socialAccountId, userId],
    queryFn: async (): Promise<ThreadsMention[]> => {
      if (!socialAccountId || !userId) return [];
      const { data, error } = await supabase
        .from("threads_mentions")
        .select("*")
        .eq("social_account_id", socialAccountId)
        .order("mentioned_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as unknown as ThreadsMention[];
    },
    enabled: !!socialAccountId && !!userId && gateEnabled,
    staleTime: 30_000,
  });

  const mentions = query.data || [];
  useRealtimeQueryInvalidation({
    table: "threads_mentions",
    userId,
    socialAccountId,
    queryKey: ["threads-mentions", socialAccountId, userId],
  });
  const unreadCount = mentions.filter((m) => m.status === "new").length;
  const lastSyncedAt = mentions.reduce<string | null>((acc, m) => {
    if (!m.last_synced_at) return acc;
    if (!acc) return m.last_synced_at;
    return new Date(m.last_synced_at) > new Date(acc) ? m.last_synced_at : acc;
  }, null);

  return {
    mentions,
    unreadCount,
    lastSyncedAt,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

function mapRefreshError(err: { error?: string; scope?: string; detail?: string }): string {
  switch (err.error) {
    case "missing_permission":
      return "Threads needs the 'Manage Mentions' permission. Please reconnect your Threads account from Profiles to grant it.";
    case "token_missing":
      return "Your Threads access token is missing or expired. Please reconnect from Profiles.";
    case "no_threads_account":
      return "This account is not a connected Threads account.";
    case "unauthorized":
      return "You do not have access to this account.";
    case "threads_api_failed":
      return err.detail || "Threads API call failed. Please try again.";
    default:
      return err.detail || "Failed to refresh mentions.";
  }
}

export function useRefreshThreadsMentions() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;

  return useMutation({
    mutationFn: async (socialAccountId: string) => {
      const { data, error } = await supabase.functions.invoke("threads-mentions", {
        body: { action: "refresh", social_account_id: socialAccountId },
      });
      if (error) throw error;
      if (data?.error) throw data;
      return data as { success: true; mentions: ThreadsMention[]; unread_count: number; fetched: number };
    },
    onSuccess: (data, socialAccountId) => {
      markMentionsPrimed(userId);
      queryClient.invalidateQueries({ queryKey: ["threads-mentions", socialAccountId] });
      toast({
        title: "Mentions refreshed",
        description: `${data.fetched ?? 0} mention${data.fetched === 1 ? "" : "s"} fetched from Threads.`,
      });
    },
    onError: (err: { error?: string; scope?: string; detail?: string } | Error) => {
      const msg = err instanceof Error ? err.message : mapRefreshError(err);
      toast({
        title: "Refresh failed",
        description: msg,
        variant: "destructive",
      });
    },
  });
}

export function useUpdateThreadsMentionStatus(socialAccountId: string | null) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id;

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ThreadsMentionStatus }) => {
      const { error } = await supabase
        .from("threads_mentions")
        .update({ status })
        .eq("id", id);
      if (error) throw error;
      return { id, status };
    },
    onMutate: async ({ id, status }) => {
      const queryKey = ["threads-mentions", socialAccountId, userId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ThreadsMention[]>(queryKey);
      if (previous) {
        queryClient.setQueryData<ThreadsMention[]>(
          queryKey,
          previous.map((m) => (m.id === id ? { ...m, status } : m)),
        );
      }
      return { previous, queryKey };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous && context.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast({
        title: "Update failed",
        description: "Could not update mention status. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: ({ status }) => {
      toast({
        title: status === "archived" ? "Mention archived" : "Mention marked as read",
      });
    },
  });
}

// =============================================================================
// V2 hooks
// =============================================================================

export interface MentionMetaPatch {
  sentiment?: ThreadsMentionSentiment;
  labels?: string[];
  assigned_to?: string | null;
}

export function useUpdateThreadsMentionMeta(socialAccountId: string | null) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id;

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: MentionMetaPatch }) => {
      const { data, error } = await supabase.functions.invoke("threads-mentions", {
        body: { action: "update_meta", mention_id: id, ...patch },
      });
      if (error) throw error;
      if (data?.error) throw data;
      return data as { success: true; mention: ThreadsMention };
    },
    onMutate: async ({ id, patch }) => {
      const queryKey = ["threads-mentions", socialAccountId, userId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ThreadsMention[]>(queryKey);
      if (previous) {
        queryClient.setQueryData<ThreadsMention[]>(
          queryKey,
          previous.map((m) =>
            m.id === id
              ? {
                  ...m,
                  ...(patch.sentiment !== undefined && { sentiment: patch.sentiment }),
                  ...(patch.labels !== undefined && { labels: patch.labels }),
                  ...(patch.assigned_to !== undefined && {
                    assigned_to: patch.assigned_to,
                    assigned_at: patch.assigned_to ? new Date().toISOString() : null,
                  }),
                }
              : m,
          ),
        );
      }
      return { previous, queryKey };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous && context.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast({
        title: "Update failed",
        description: "Could not update mention. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (data) => {
      const queryKey = ["threads-mentions", socialAccountId, userId];
      const fresh = data.mention;
      const previous = queryClient.getQueryData<ThreadsMention[]>(queryKey);
      if (previous) {
        queryClient.setQueryData<ThreadsMention[]>(
          queryKey,
          previous.map((m) => (m.id === fresh.id ? fresh : m)),
        );
      }
    },
  });
}

export function useReplyToThreadsMention(socialAccountId: string | null) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user?.id;

  return useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) => {
      if (!socialAccountId) throw new Error("No account selected");
      const { data, error } = await supabase.functions.invoke("threads-mentions", {
        body: {
          action: "reply",
          mention_id: id,
          text,
          social_account_id: socialAccountId,
        },
      });
      if (error) throw error;
      if (data?.error) throw data;
      return data as { success: true; mention: ThreadsMention };
    },
    onSuccess: (data) => {
      const queryKey = ["threads-mentions", socialAccountId, userId];
      const fresh = data.mention;
      const previous = queryClient.getQueryData<ThreadsMention[]>(queryKey);
      if (previous && fresh) {
        queryClient.setQueryData<ThreadsMention[]>(
          queryKey,
          previous.map((m) => (m.id === fresh.id ? fresh : m)),
        );
      }
      toast({ title: "Reply sent", description: "Your reply was posted on Threads." });
    },
    onError: (err: { error?: string; detail?: string; reason?: string } | Error) => {
      const msg = err instanceof Error
        ? err.message
        : err.detail || err.reason || "Could not send your reply.";
      toast({
        title: "Reply failed",
        description: msg,
        variant: "destructive",
      });
    },
  });
}

// =============================================================================
// Filters hook (client-side)
// =============================================================================

export type SortOrder = "newest" | "oldest";
export type StatusFilter = "all" | ThreadsMentionStatus;
export type SentimentFilter = "all" | ThreadsMentionSentiment;
export type AssignedFilter = "all" | "unassigned" | "me" | string;
export type HasReplyFilter = "all" | "replied" | "not_replied";

export interface ThreadsMentionsFiltersState {
  status: StatusFilter;
  sentiment: SentimentFilter;
  labels: string[];
  assigned: AssignedFilter;
  hasReply: HasReplyFilter;
  sort: SortOrder;
  search: string;
}

const DEFAULT_FILTERS: ThreadsMentionsFiltersState = {
  status: "all",
  sentiment: "all",
  labels: [],
  assigned: "all",
  hasReply: "all",
  sort: "newest",
  search: "",
};

const STORAGE_KEY = "threads-mentions:filters";

function loadStoredFilters(): ThreadsMentionsFiltersState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function useThreadsMentionsFilters() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id ?? null;
  const [filters, setFiltersState] = useState<ThreadsMentionsFiltersState>(() => loadStoredFilters());

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }, [filters]);

  const setFilters = useCallback(
    (patch: Partial<ThreadsMentionsFiltersState>) => {
      setFiltersState((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const reset = useCallback(() => setFiltersState(DEFAULT_FILTERS), []);

  const applyFilters = useCallback(
    (mentions: ThreadsMention[]): ThreadsMention[] => {
      const search = filters.search.trim().toLowerCase();
      const out = mentions.filter((m) => {
        if (filters.status !== "all" && m.status !== filters.status) return false;
        if (filters.sentiment !== "all" && (m.sentiment || "unknown") !== filters.sentiment) return false;
        if (filters.hasReply === "replied" && !m.has_reply) return false;
        if (filters.hasReply === "not_replied" && m.has_reply) return false;
        if (filters.labels.length > 0) {
          const set = new Set((m.labels || []).map((l) => l.toLowerCase()));
          if (!filters.labels.every((l) => set.has(l.toLowerCase()))) return false;
        }
        if (filters.assigned !== "all") {
          if (filters.assigned === "unassigned") {
            if (m.assigned_to) return false;
          } else if (filters.assigned === "me") {
            if (m.assigned_to !== currentUserId) return false;
          } else {
            if (m.assigned_to !== filters.assigned) return false;
          }
        }
        if (search) {
          const hay = `${m.mention_author_username || ""} ${m.mention_text || ""}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      });
      out.sort((a, b) => {
        const ad = a.mentioned_at ? new Date(a.mentioned_at).getTime() : 0;
        const bd = b.mentioned_at ? new Date(b.mentioned_at).getTime() : 0;
        return filters.sort === "newest" ? bd - ad : ad - bd;
      });
      return out;
    },
    [filters, currentUserId],
  );

  return { filters, setFilters, reset, applyFilters, defaultFilters: DEFAULT_FILTERS };
}

// All labels seen in the current dataset — useful for filter chips.
export function useAvailableLabels(mentions: ThreadsMention[]): string[] {
  return useMemo(() => {
    const set = new Set<string>();
    for (const m of mentions) {
      for (const l of m.labels || []) {
        if (l) set.add(l);
      }
    }
    return Array.from(set).sort();
  }, [mentions]);
}
