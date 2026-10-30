import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Camera, AtSign, Facebook, Video, RotateCcw, Trash2, Eye, Search, History } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { CompetitorSourceBadge } from "@/features/competitor-tracking";
import { resolveBrandProfileSource } from "@/types/brand-intelligence";
import type { BrandProfile, BrandPost, BrandScrapeSession } from "@/types/brand-intelligence";

interface ScrapeHistoryProps {
  onReuse: (profile: BrandProfile, posts: BrandPost[]) => void;
}

const platformIcons: Record<string, React.ReactNode> = {
  instagram: <Camera className="w-4 h-4 text-primary" />,
  threads: <AtSign className="w-4 h-4" />,
  facebook: <Facebook className="w-4 h-4 text-primary" />,
  tiktok: <Video className="w-4 h-4" />,
};

export function ScrapeHistory({ onReuse }: ScrapeHistoryProps) {
  const { t } = useTranslation("analytics");
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["scrape-history", platformFilter, searchQuery],
    queryFn: async () => {
      let query = supabase
        .from("brand_scrape_sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (platformFilter !== "all") {
        query = query.eq("platform", platformFilter);
      }
      if (searchQuery.trim()) {
        query = query.ilike("username", `%${searchQuery.trim()}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as BrandScrapeSession[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("brand_scrape_sessions")
        .delete()
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scrape-history"] });
      setSelected(new Set());
      toast.success(t("toast.sessionsDeleted", "Sessions deleted"));
    },
    onError: () => toast.error(t("errors.deleteSessionsFailed", "Failed to delete sessions")),
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!sessions) return;
    if (selected.size === sessions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map((s) => s.id)));
    }
  };

  const handleReuse = (session: BrandScrapeSession) => {
    if (!session.profile_data || !session.posts_data) {
      toast.error(t("errors.sessionNoData", "This session has no stored data to reuse"));
      return;
    }

    /**
     * The reused profile carries the source of the session.
     *
     * The source the session recorded wins; the source the stored
     * profile carries is the fallback; and a session with neither is
     * "unknown". The card the owner gets therefore says exactly what
     * the history row says (T8-01).
     */
    const sessionSource = resolveBrandProfileSource(session.source);
    const profileSource =
      sessionSource !== "unknown"
        ? sessionSource
        : resolveBrandProfileSource(session.profile_data.source);

    onReuse({ ...session.profile_data, source: profileSource }, session.posts_data);
    toast.success(t("toast.loadedHistory", "Loaded {{username}} data from history", { username: session.username }));
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <History className="w-5 h-5" />
            {t("history.title", "Scraping History")}
          </CardTitle>
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteMutation.mutate(Array.from(selected))}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="w-4 h-4 me-1" />
              {t("history.deleteCount", "Delete {{count}}", { count: selected.size })}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute start-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("form.searchUsername", "Search username...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-8 h-9 text-sm"
            />
          </div>
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="w-[140px] h-9 text-xs">
              <SelectValue placeholder={t("history.platform", "Platform")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("history.allPlatforms", "All Platforms")}</SelectItem>
              <SelectItem value="instagram">{t("brand.instagram", "Instagram")}</SelectItem>
              <SelectItem value="threads">{t("brand.threads", "Threads")}</SelectItem>
              <SelectItem value="facebook">{t("brand.facebook", "Facebook")}</SelectItem>
              <SelectItem value="tiktok">{t("brand.tiktok", "TikTok")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-12 w-full animate-pulse rounded-md bg-muted" />)}
          </div>
        ) : !sessions?.length ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            {t("history.empty", "No scraping history yet. Search for a brand to get started.")}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selected.size === sessions.length && sessions.length > 0}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead className="w-10">{t("history.platform", "Platform")}</TableHead>
                  <TableHead>{t("history.username", "Username")}</TableHead>
                  <TableHead>{t("history.source", "Source")}</TableHead>
                  <TableHead className="text-center">{t("history.posts", "Posts")}</TableHead>
                  <TableHead>{t("history.strategy", "Strategy")}</TableHead>
                  <TableHead>{t("history.date", "Date")}</TableHead>
                  <TableHead className="text-end">{t("history.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(session.id)}
                        onCheckedChange={() => toggleSelect(session.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {platformIcons[session.platform] || null}
                        <span className="text-xs capitalize">{session.platform}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">@{session.username}</TableCell>
                    <TableCell>
                      {/*
                        The source of the observation, when the session
                        recorded one. It is NOT read out of the strategy:
                        a cached session is not an official observation
                        just because a cache entry looks official
                        (T8-01).
                      */}
                      <CompetitorSourceBadge source={resolveBrandProfileSource(session.source)} />
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="text-xs">
                        {session.total_posts_fetched || 0}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <Badge
                          variant={session.strategy_used === "official" ? "default" : "outline"}
                          className={`text-xs ${session.strategy_used === "official" ? "bg-emerald-600 hover:bg-emerald-700" : session.strategy_used === "apify" ? "border-orange-400 text-orange-600" : ""}`}
                        >
                          {session.strategy_used === "official" ? t("history.metaApi", "Meta API") : session.strategy_used === "apify" ? t("history.apify", "Apify") : session.strategy_used || t("common:unknown", "unknown")}
                        </Badge>
                        {session.api_endpoint && (
                          <p className="text-[10px] text-muted-foreground truncate max-w-[140px]" title={session.api_endpoint}>
                            {session.strategy_used === "apify" ? (
                              <span className="inline-flex items-center gap-0.5">
                                <span className="font-medium text-orange-500">{t("history.actor", "Actor:")}</span>{" "}
                                {session.api_endpoint.replace("~", "/")}
                              </span>
                            ) : (
                              session.api_endpoint
                            )}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {session.created_at ? format(new Date(session.created_at), "MMM d, yyyy HH:mm") : "—"}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1"
                          onClick={() => handleReuse(session)}
                          disabled={!session.posts_data}
                        >
                          <RotateCcw className="w-3 h-3" /> {t("actions.reuse", "Reuse")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => deleteMutation.mutate([session.id])}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
