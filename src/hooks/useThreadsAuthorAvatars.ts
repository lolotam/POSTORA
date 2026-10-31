import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ThreadsAuthorAvatarResolver {
  getAvatar: (username: string | null | undefined) => string | null;
  selfUsername: string | null;
  selfAvatar: string | null;
}

/**
 * Loads avatars for the connected Threads account and any mention authors
 * we've previously cached. Returns a resolver mapping `username -> avatar url`.
 */
export function useThreadsAuthorAvatars(accountId: string | null): ThreadsAuthorAvatarResolver {
  const { data } = useQuery({
    queryKey: ["threads-author-avatars", accountId],
    enabled: !!accountId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!accountId) return { selfUsername: null, selfAvatar: null, map: {} as Record<string, string> };

      const [{ data: account }, { data: mentions }] = await Promise.all([
        supabase
          .from("social_accounts")
          .select("platform_username, avatar_url")
          .eq("id", accountId)
          .maybeSingle(),
        supabase
          .from("threads_mentions")
          .select("mention_author_username, mention_author_avatar_url")
          .eq("social_account_id", accountId)
          .not("mention_author_avatar_url", "is", null)
          .limit(1000),
      ]);

      const map: Record<string, string> = {};
      for (const row of mentions || []) {
        const u = row.mention_author_username?.toLowerCase?.();
        const url = row.mention_author_avatar_url;
        if (u && url) map[u] = url;
      }

      return {
        selfUsername: account?.platform_username ?? null,
        selfAvatar: account?.avatar_url ?? null,
        map,
      };
    },
  });

  return useMemo<ThreadsAuthorAvatarResolver>(() => {
    const selfUsername = data?.selfUsername ?? null;
    const selfAvatar = data?.selfAvatar ?? null;
    const map = data?.map ?? {};
    const selfKey = selfUsername?.toLowerCase() ?? null;
    return {
      selfUsername,
      selfAvatar,
      getAvatar: (username) => {
        if (!username) return null;
        const key = username.toLowerCase().replace(/^@/, "");
        if (selfKey && key === selfKey && selfAvatar) return selfAvatar;
        return map[key] ?? null;
      },
    };
  }, [data]);
}