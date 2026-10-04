import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Search,
  ExternalLink,
  Hash,
  AtSign,
  Shield,
  History as HistoryIcon,
  X,
  Calendar,
  MessageSquare,
  Quote as QuoteIcon,
  Repeat2,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { mapThreadsReason, ThreadsErrorCard, type ThreadsErrorState } from "./ThreadsErrorCard";

interface KeywordResult {
  id: string;
  text: string;
  username: string;
  timestamp: string;
  permalink: string;
  mediaType: string;
  mediaUrl: string;
  thumbnailUrl: string;
  hasReplies?: boolean;
  isQuotePost?: boolean;
  isReply?: boolean;
}

interface RecentSearch {
  id: string;
  query: string;
  search_type: string;
  since_date: string | null;
  until_date: string | null;
}

interface MetaRecentItem {
  query: string;
  timestamp: string | null;
  count?: number;
}

interface ThreadsAccount {
  id: string;
  platform_username: string;
  avatar_url: string | null;
}

type SearchType = "TOP" | "RECENT";
type SearchMode = "KEYWORD" | "TAG";
type MediaTypeFilter = "ALL" | "TEXT" | "IMAGE" | "VIDEO";
type ActionKind = "reply" | "quote";

const MAX_RECENT = 10;
const LIMIT_OPTIONS = [25, 50, 100] as const;
const ACCOUNT_STORAGE_KEY = "threads-keyword:selected-account-id";

export function ThreadsKeywordSearchPanel() {
  const { t } = useTranslation("analytics");
  const [keyword, setKeyword] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("TOP");
  const [searchMode, setSearchMode] = useState<SearchMode>("KEYWORD");
  const [mediaType, setMediaType] = useState<MediaTypeFilter>("ALL");
  const [pageLimit, setPageLimit] = useState<number>(25);
  const [authorUsername, setAuthorUsername] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<ThreadsErrorState | null>(null);
  const [searched, setSearched] = useState(false);
  const [requestSource, setRequestSource] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [metaRecent, setMetaRecent] = useState<MetaRecentItem[]>([]);
  const [metaRecentLoading, setMetaRecentLoading] = useState(false);

  // Account picker
  const [accounts, setAccounts] = useState<ThreadsAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(ACCOUNT_STORAGE_KEY);
  });

  // Per-card composer state
  const [openComposer, setOpenComposer] = useState<{ postId: string; kind: ActionKind } | null>(null);
  const [composerText, setComposerText] = useState("");
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [repostingId, setRepostingId] = useState<string | null>(null);

  const loadRecent = async () => {
    const { data } = await supabase
      .from("threads_recent_searches")
      .select("id, query, search_type, since_date, until_date")
      .order("created_at", { ascending: false })
      .limit(MAX_RECENT);
    if (data) setRecent(data as RecentSearch[]);
  };

  const loadMetaRecent = async (accountId?: string | null) => {
    setMetaRecentLoading(true);
    try {
      const body: Record<string, unknown> = {};
      if (accountId) body.accountId = accountId;
      const { data } = await supabase.functions.invoke("threads-recently-searched", { body });
      if (data?.ok && Array.isArray(data.items)) {
        // Dedupe by normalized query, keep most recent timestamp + count occurrences
        const map = new Map<string, MetaRecentItem>();
        for (const raw of data.items as MetaRecentItem[]) {
          const key = (raw.query || "").trim().toLowerCase();
          if (!key) continue;
          const existing = map.get(key);
          const ts = raw.timestamp ? new Date(raw.timestamp).getTime() : 0;
          if (!existing) {
            map.set(key, { query: raw.query.trim(), timestamp: raw.timestamp, count: 1 });
          } else {
            const existingTs = existing.timestamp ? new Date(existing.timestamp).getTime() : 0;
            map.set(key, {
              query: existing.query,
              timestamp: ts > existingTs ? raw.timestamp : existing.timestamp,
              count: (existing.count || 1) + 1,
            });
          }
        }
        const deduped = Array.from(map.values())
          .sort((a, b) => {
            const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return bt - at;
          })
          .slice(0, MAX_RECENT);
        setMetaRecent(deduped);
      } else {
        setMetaRecent([]);
      }
    } catch {
      setMetaRecent([]);
    } finally {
      setMetaRecentLoading(false);
    }
  };

  useEffect(() => {
    loadRecent();
    loadMetaRecent(selectedAccountId);
  }, []);

  // Load connected Threads accounts for the picker.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("social_accounts")
        .select("id, platform_username, avatar_url")
        .eq("user_id", user.id)
        .eq("platform", "threads")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (data) {
        setAccounts(data as ThreadsAccount[]);
        // If the persisted id no longer matches a connected account, clear it
        if (selectedAccountId && !data.some((a: any) => a.id === selectedAccountId)) {
          setSelectedAccountId(null);
          try { sessionStorage.removeItem(ACCOUNT_STORAGE_KEY); } catch { /* ignore */ }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAccountChange = (val: string) => {
    setSelectedAccountId(val);
    try { sessionStorage.setItem(ACCOUNT_STORAGE_KEY, val); } catch { /* ignore */ }
    // Reset current results & refresh Meta recent for the new account
    setResults([]);
    setSearched(false);
    setHasMore(false);
    setNextCursor(null);
    setErrorState(null);
    loadMetaRecent(val);
  };

  const saveRecent = async (q: string, type: SearchType, sinceVal: string, untilVal: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const dup = recent.find(
        (r) =>
          r.query === q &&
          r.search_type === type &&
          (r.since_date || "") === sinceVal &&
          (r.until_date || "") === untilVal,
      );
      if (dup) return;

      await supabase.from("threads_recent_searches").insert({
        user_id: user.id,
        query: q,
        search_type: type,
        since_date: sinceVal || null,
        until_date: untilVal || null,
      });

      const { data: all } = await supabase
        .from("threads_recent_searches")
        .select("id")
        .order("created_at", { ascending: false });
      if (all && all.length > MAX_RECENT) {
        const toDelete = all.slice(MAX_RECENT).map((r) => r.id);
        await supabase.from("threads_recent_searches").delete().in("id", toDelete);
      }
      loadRecent();
    } catch (e) {
      console.warn("[recent searches] save failed", e);
    }
  };

  const removeRecent = async (id: string) => {
    await supabase.from("threads_recent_searches").delete().eq("id", id);
    loadRecent();
  };

  const runSearch = async (cursor: string | null, append: boolean) => {
    const q = keyword.trim();
    if (!q || q.length < 2) return;
    if (since && until && since > until) {
      toast.error(t("errors.sinceUntil", "'Since' must be on or before 'Until'"));
      return;
    }

    if (cursor) setIsLoadingMore(true);
    else setIsLoading(true);
    if (!append) {
      setErrorState(null);
      setResults([]);
      setSearched(false);
      setHasMore(false);
      setNextCursor(null);
    }

    try {
      const payload: Record<string, unknown> = {
        keyword: q,
        searchType,
        searchMode,
        mediaType,
        limit: pageLimit,
      };
      if (selectedAccountId) payload.accountId = selectedAccountId;
      if (authorUsername.trim()) payload.authorUsername = authorUsername.trim();
      if (since) payload.since = since;
      if (until) payload.until = until;
      if (cursor) payload.cursor = cursor;

      const { data, error: fnError } = await supabase.functions.invoke("threads-keyword-search", {
        body: payload,
      });

      let body: any = data;
      if (fnError && !data) {
        try {
          if (fnError.context && typeof fnError.context.json === "function") {
            body = await fnError.context.json();
          }
        } catch { /* ignore */ }
        if (!body) {
          setErrorState({ reason: "unknown", message: fnError.message || t("errors.unknown", "Unknown error") });
          return;
        }
      }

      if (body && body.ok === false) {
        setErrorState(mapThreadsReason(body, "keyword_search"));
        if (body.requestSource) setRequestSource(body.requestSource);
        return;
      }

      if (body?.error && body.ok !== true) {
        setErrorState({ reason: "unknown", message: body.error });
        return;
      }

      const newResults: KeywordResult[] = body.results || [];
      setResults((prev) => (append ? [...prev, ...newResults] : newResults));
      setHasMore(!!body.hasMore);
      setNextCursor(body.nextCursor || null);
      setRequestSource(body.requestSource || null);
      setSearched(true);

      if (!cursor) {
        await saveRecent(q, searchType, since, until);
        // Refresh Meta recent in case the API now includes this search
        loadMetaRecent(selectedAccountId);
      }
    } catch (err) {
      const msg = (err as Error).message;
      setErrorState({ reason: "unknown", message: msg });
      toast.error(msg);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  const handleSearch = () => runSearch(null, false);
  const handleLoadMore = () => {
    if (!nextCursor) return;
    runSearch(nextCursor, true);
  };

  const replayRecent = (r: RecentSearch) => {
    setKeyword(r.query);
    const nextType: SearchType = (r.search_type as SearchType) === "RECENT" ? "RECENT" : "TOP";
    setSearchType(nextType);
    setSince(r.since_date || "");
    setUntil(r.until_date || "");
    // Defer to next tick so state is applied before search
    setTimeout(() => runSearch(null, false), 0);
  };

  const replayMetaRecent = (q: string) => {
    setKeyword(q);
    setTimeout(() => runSearch(null, false), 0);
  };

  const openComposerFor = (postId: string, kind: ActionKind) => {
    setOpenComposer({ postId, kind });
    setComposerText("");
  };

  const cancelComposer = () => {
    setOpenComposer(null);
    setComposerText("");
  };

  const submitComposer = async () => {
    if (!openComposer) return;
    const text = composerText.trim();
    if (!text) {
      toast.error(openComposer.kind === "reply" ? t("errors.replyEmpty", "Reply cannot be empty") : t("errors.quoteEmpty", "Quote text cannot be empty"));
      return;
    }
    setIsSubmittingAction(true);
    try {
      const fnName = openComposer.kind === "reply" ? "threads-comment" : "threads-quote";
      const body =
        openComposer.kind === "reply"
          ? { thread_id: openComposer.postId, text }
          : { quote_post_id: openComposer.postId, text };

      const { data, error } = await supabase.functions.invoke(fnName, { body });
      if (error) throw new Error(error.message || t("errors.actionFailed", "Action failed"));
      if (data && data.ok === false) {
        const mapped = mapThreadsReason(data, "keyword_search");
        toast.error(mapped.message || t("errors.actionFailed", "Action failed"));
        return;
      }
      const permalink: string | undefined = data?.permalink;
      const successMsg = openComposer.kind === "reply" ? t("toast.replyPosted", "Reply posted on Threads") : t("toast.quotePosted", "Quote posted on Threads");
      if (permalink) {
        toast.success(successMsg, {
          action: { label: t("common:view", "View"), onClick: () => window.open(permalink, "_blank") },
        });
      } else {
        toast.success(successMsg);
      }
      cancelComposer();
    } catch (err) {
      toast.error((err as Error).message || t("errors.actionFailed", "Action failed"));
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleRepost = async (postId: string) => {
    setRepostingId(postId);
    try {
      const { data, error } = await supabase.functions.invoke("threads-repost", {
        body: { post_id: postId },
      });
      if (error) throw new Error(error.message || t("errors.repostFailed", "Repost failed"));
      if (data && data.ok === false) {
        const mapped = mapThreadsReason(data, "keyword_search");
        toast.error(mapped.message || t("errors.couldNotRepost", "Could not repost"));
        return;
      }
      toast.success(t("toast.reposted", "Reposted on Threads"));
    } catch (err) {
      toast.error((err as Error).message || t("errors.repostFailed", "Repost failed"));
    } finally {
      setRepostingId(null);
    }
  };

  const isTagMode = searchMode === "TAG";
  const InputIcon = isTagMode ? Hash : Search;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
            <Hash className="w-5 h-5 text-primary" />
            {t("keyword.title", "Threads Keyword Search")}
            {accounts.length > 1 && (
              <Select
                value={selectedAccountId ?? accounts[0]?.id ?? ""}
                onValueChange={handleAccountChange}
              >
                <SelectTrigger className="h-8 w-auto min-w-[200px] text-sm font-normal">
                  <SelectValue placeholder={t("ads.selectAccount", "Select account")} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <div className="flex items-center gap-2">
                        <Avatar className="w-5 h-5">
                          <AvatarImage src={acc.avatar_url || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {acc.platform_username?.[0]?.toUpperCase() || "?"}
                          </AvatarFallback>
                        </Avatar>
                        @{acc.platform_username}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("keyword.subtitle", "Search public Threads posts by keyword or topic tag for trend analysis")}
          </p>
        </div>
      </div>

      {/* Search input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <InputIcon className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={isTagMode ? t("keyword.placeholderTag", "Enter a topic tag (e.g. coffee)...") : t("keyword.placeholderKeyword", "Enter a keyword to search...")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="ps-9"
          />
        </div>
        <Button onClick={handleSearch} disabled={isLoading || keyword.trim().length < 2} className="gap-2">
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {t("actions.search", "Search")}
        </Button>
      </div>

      {/* Filters row 1: mode + sort + media type + limit + dates + author */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 flex flex-col items-center">
           <label className="text-xs text-muted-foreground text-center block">{t("filters.mode", "Mode")}</label>
          <div className="flex h-8 rounded-md border border-border overflow-hidden">
            {(["KEYWORD", "TAG"] as SearchMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSearchMode(m)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  searchMode === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted text-muted-foreground",
                )}
              >
                {m === "KEYWORD" ? t("keyword.keyword", "KEYWORD") : t("keyword.tag", "TAG")}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1 flex flex-col items-center">
           <label className="text-xs text-muted-foreground text-center block">{t("filters.sort", "Sort")}</label>
          <div className="flex h-8 rounded-md border border-border overflow-hidden">
            {(["TOP", "RECENT"] as SearchType[]).map((sortOpt) => (
              <button
                key={sortOpt}
                type="button"
                onClick={() => setSearchType(sortOpt)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  searchType === sortOpt
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted text-muted-foreground",
                )}
              >
                {sortOpt === "TOP" ? t("keyword.top", "TOP") : t("keyword.recent", "RECENT")}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1 flex flex-col items-center">
           <label className="text-xs text-muted-foreground text-center block">{t("filters.media", "Media")}</label>
          <div className="flex h-8 rounded-md border border-border overflow-hidden">
            {(["ALL", "TEXT", "IMAGE", "VIDEO"] as MediaTypeFilter[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMediaType(m)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  mediaType === m
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted text-muted-foreground",
                )}
              >
                {m === "ALL" ? t("keyword.all", "ALL")
                  : m === "TEXT" ? t("keyword.text", "TEXT")
                  : m === "IMAGE" ? t("keyword.image", "IMAGE")
                  : t("keyword.video", "VIDEO")}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1 flex flex-col items-center">
          <label className="text-xs text-muted-foreground text-center block">{t("filters.limit", "Limit")}</label>
          <Select value={String(pageLimit)} onValueChange={(v) => setPageLimit(Number(v))}>
            <SelectTrigger className="h-8 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 flex flex-col items-center">
          <label className="text-xs text-muted-foreground text-center block">{t("filters.since", "Since")}</label>
          <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="h-8 w-36" />
        </div>

        <div className="space-y-1 flex flex-col items-center">
          <label className="text-xs text-muted-foreground text-center block">{t("filters.until", "Until")}</label>
          <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="h-8 w-36" />
        </div>

        {(since || until) && (
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={() => { setSince(""); setUntil(""); }} className="h-8 text-xs">
              {t("actions.clearDates", "Clear dates")}
            </Button>
          </div>
        )}

        <div className="space-y-1 flex flex-col items-center">
          <label className="text-xs text-muted-foreground text-center block">{t("filters.authorUsername", "Author username")}</label>
          <div className="relative">
            <AtSign className="absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder={t("filters.optionalNoAt", "optional, no @")}
              value={authorUsername}
              onChange={(e) => setAuthorUsername(e.target.value)}
              className="h-8 ps-8 w-44"
            />
          </div>
        </div>
      </div>

      {/* Recent searches — Meta + Local */}
      {/* Recent searches — Meta + Local */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Meta recent searches card */}
        <div className="rounded-xl border border-border p-3 shadow-sm hover:shadow-md transition-shadow bg-card">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
                <HistoryIcon className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t("keyword.recentSearches", "Recent searches")}</span>
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-medium">{t("keyword.meta", "Meta")}</Badge>
            </div>
            {metaRecentLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          </div>
          {metaRecent.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {metaRecent.map((m, i) => (
                <button
                  key={`${m.query}-${i}`}
                  onClick={() => replayMetaRecent(m.query)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background hover:bg-accent hover:border-primary/40 text-xs px-2.5 py-1 transition-all hover:shadow-sm"
                >
                  <span className="font-medium">{m.query}</span>
                  {(m.count || 0) > 1 && (
                    <span className="text-[10px] text-primary font-semibold bg-primary/10 rounded-full px-1.5">×{m.count}</span>
                  )}
                  {m.timestamp && (
                    <span className="text-[10px] text-muted-foreground">
                      {format(new Date(m.timestamp), "MMM d")}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            !metaRecentLoading && (
              <p className="text-[11px] text-muted-foreground italic">{t("empty.noMetaSearches", "No recent searches from Meta (last 7 days).")}</p>
            )
          )}
        </div>

        {/* Local recent searches card */}
        <div className="rounded-xl border border-border p-3 shadow-sm hover:shadow-md transition-shadow bg-card">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
                <HistoryIcon className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t("keyword.recentSearches", "Recent searches")}</span>
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-medium">{t("keyword.local", "Local")}</Badge>
            </div>
          </div>
          {recent.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {recent.map((r) => (
                <div key={r.id} className="group inline-flex items-center gap-1 rounded-full border border-border bg-background hover:bg-accent hover:border-primary/40 text-xs ps-2.5 pe-1 py-1 transition-all hover:shadow-sm">
                  <button
                    onClick={() => replayRecent(r)}
                    className="flex items-center gap-1.5"
                  >
                    <span className="font-medium">{r.query}</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1 bg-primary/5 border-primary/20">{r.search_type === "RECENT" ? t("keyword.recent", "RECENT") : t("keyword.top", "TOP")}</Badge>
                    {(r.since_date || r.until_date) && (
                      <span className="text-[10px] text-muted-foreground">{r.since_date || "…"} → {r.until_date || "…"}</span>
                    )}
                  </button>
                  <button
                    onClick={() => removeRecent(r.id)}
                    className="opacity-0 group-hover:opacity-100 ms-0.5 p-0.5 rounded-full hover:bg-destructive/15 hover:text-destructive transition-all"
                    aria-label={t("common:remove", "Remove")}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">{t("empty.noLocalSearches", "No local searches yet.")}</p>
          )}
        </div>
      </div>

      {errorState && <ThreadsErrorCard state={errorState} />}

      {searched && !errorState && results.length === 0 && (
        <Card className="border-border bg-muted/40">
          <CardContent className="p-6 text-center space-y-2">
            <Search className="w-8 h-8 mx-auto text-muted-foreground" />
            <h4 className="font-medium">{t("empty.noPublicPosts", "No public posts found.")}</h4>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {t("empty.noPublicPostsHint", "Threads Keyword Search does not index all public content. Try different keywords, switch mode (Keyword ↔ Tag), change the media filter, or widen the date range.")}
            </p>
          </CardContent>
        </Card>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{t("keyword.resultsLoaded", "{{count}} results loaded", { count: results.length })}</h4>
          {results.map((post) => {
            const composerOpen = openComposer?.postId === post.id;
            return (
              <Card key={post.id} className="overflow-hidden">
                <CardContent className="p-4 space-y-3">
                  <div className="flex gap-3">
                    {post.mediaUrl && post.mediaType !== "TEXT_POST" && post.mediaType !== "TEXT" && (
                      <img
                        src={post.thumbnailUrl || post.mediaUrl}
                        alt=""
                        className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-medium">@{post.username}</span>
                        <Badge variant="secondary" className="text-xs">{post.mediaType}</Badge>
                        {post.isQuotePost && <Badge variant="outline" className="text-[10px]">{t("keyword.quote", "Quote")}</Badge>}
                        {post.isReply && <Badge variant="outline" className="text-[10px]">{t("keyword.reply", "Reply")}</Badge>}
                        {post.hasReplies && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">{t("keyword.hasReplies", "Has replies")}</Badge>
                        )}
                      </div>
                      <p className="text-sm line-clamp-2 text-muted-foreground">{post.text || t("discovery.noText", "(No text)")}</p>
                      <div className="flex items-center gap-3 mt-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          {post.timestamp ? format(new Date(post.timestamp), "MMM d, yyyy") : ""}
                        </span>
                        <div className="ms-auto flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => openComposerFor(post.id, "reply")}
                          >
                            <MessageSquare className="w-3 h-3" /> {t("actions.reply", "Reply")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => openComposerFor(post.id, "quote")}
                          >
                            <QuoteIcon className="w-3 h-3" /> {t("actions.quote", "Quote")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => handleRepost(post.id)}
                            disabled={repostingId === post.id}
                          >
                            {repostingId === post.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Repeat2 className="w-3 h-3" />
                            )}
                            {t("actions.repost", "Repost")}
                          </Button>
                          {post.permalink && (
                            <a
                              href={post.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline flex items-center gap-1 px-2"
                            >
                              <ExternalLink className="w-3 h-3" />{t("common:view", "View")}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {composerOpen && (
                    <div className="space-y-2 p-3 rounded-lg border bg-muted/30">
                      <Textarea
                        placeholder={openComposer?.kind === "reply" ? t("keyword.replyPlaceholder", "Write a reply…") : t("keyword.quotePlaceholder", "Add your take on this thread…")}
                        value={composerText}
                        onChange={(e) => setComposerText(e.target.value)}
                        maxLength={500}
                        rows={3}
                      />
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">{composerText.length}/500</p>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={cancelComposer}>{t("common:cancel", "Cancel")}</Button>
                          <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={submitComposer}
                            disabled={isSubmittingAction || !composerText.trim()}
                          >
                            {isSubmittingAction ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            {openComposer?.kind === "reply" ? t("actions.postReply", "Post reply") : t("actions.postQuote", "Post quote")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="gap-2"
              >
                {isLoadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                {t("actions.loadMore", "Load more")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
