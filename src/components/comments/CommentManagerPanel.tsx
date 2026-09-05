import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { CommentList } from "@/components/comments/CommentList";
import { CommentFilters } from "@/components/comments/CommentFilters";
import { getPlatformName } from "@/components/PlatformIcon";
import { useComments } from "@/hooks/useCommentInbox";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { youtubeCommentCapability } from "@/lib/youtubeCommentCapability";
import { RefreshCw, Loader2, Facebook, Camera, Youtube, AlertTriangle } from "lucide-react";

type CommentManagerPlatform = "facebook" | "instagram" | "youtube";

interface CommentManagerPanelProps {
  platform: CommentManagerPlatform;
}

const EMPTY_COPY: Record<CommentManagerPlatform, { Icon: typeof Facebook; label: string; hint: string }> = {
  facebook: { Icon: Facebook, label: "No Facebook pages connected", hint: "Connect a Facebook page to manage comments." },
  instagram: { Icon: Camera, label: "No Instagram accounts connected", hint: "Connect an Instagram account to manage comments." },
  youtube: { Icon: Youtube, label: "No YouTube channels connected", hint: "Connect a YouTube channel to manage comments." },
};

export function CommentManagerPanel({ platform }: CommentManagerPanelProps) {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [hiddenFilter, setHiddenFilter] = useState("all");
  const [sentimentFilter, setSentimentFilter] = useState("all");

  const { data: socialAccounts = [] } = useSocialAccounts();

  const platformAccounts = useMemo(
    () => socialAccounts.filter((a) => a.platform === platform && a.is_active),
    [socialAccounts, platform]
  );

  const activeAccountId = selectedAccountId && platformAccounts.some((a) => a.id === selectedAccountId)
    ? selectedAccountId
    : platformAccounts[0]?.id || null;

  const activeAccount = platformAccounts.find((a) => a.id === activeAccountId);
  const pageId = platform === "facebook" ? activeAccount?.platform_user_id : undefined;
  const igUserId = platform === "instagram" ? activeAccount?.platform_user_id : undefined;
  // A native channel connected before force-ssl was requested would 403 on every read, so the
  // query is not started at all; the banner below says what fixes it.
  const needsReconnect = platform === "youtube"
    && !!activeAccount
    && youtubeCommentCapability(activeAccount) === "reconnect_required";

  const {
    data: comments = [],
    isLoading: commentsLoading,
    error: commentsError,
    refetch,
    isFetching,
  } = useComments({
    platform,
    socialAccountId: activeAccountId,
    pageId,
    igUserId,
    enabled: !needsReconnect,
  });

  const { Icon: EmptyIcon, label: emptyLabel, hint: emptyHint } = EMPTY_COPY[platform];
  const igPermissionError = platform === "instagram"
    && commentsError instanceof Error
    && /MISSING_SCOPE|TOKEN_EXPIRED|permission|instagram_business_manage_comments|instagram_manage_comments/i.test(commentsError.message);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          {platformAccounts.length > 0 && (
            <Select
              value={activeAccountId || ""}
              onValueChange={setSelectedAccountId}
            >
              <SelectTrigger className="w-[220px] h-9">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {platformAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={a.avatar_url || ""} />
                        <AvatarFallback>
                          <EmptyIcon className="w-3 h-3" />
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{a.platform_username || a.platform_user_id}</span>
                      {a.auth_provider === "composio" && (
                        <Badge variant="outline" className="ms-1 text-[10px]">Composio</Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <CommentFilters
            sentimentFilter={sentimentFilter}
            onSentimentChange={setSentimentFilter}
            hiddenFilter={hiddenFilter}
            onHiddenChange={setHiddenFilter}
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Refresh
        </Button>
      </div>

      {igPermissionError && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">Instagram comments need updated access</p>
            <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
              Reconnect Instagram and approve comment management permissions so we can load comments and replies.
            </p>
          </div>
          <Button asChild size="sm" variant="outline" className="border-amber-500/50">
            <Link to="/profiles">Reconnect</Link>
          </Button>
        </div>
      )}

      {needsReconnect && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">This channel needs reconnecting</p>
            <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
              Reconnect this channel on Profiles to enable comments — YouTube now asks for comment access when you connect.
            </p>
          </div>
          <Button asChild size="sm" variant="outline" className="border-amber-500/50">
            <Link to="/profiles">Reconnect</Link>
          </Button>
        </div>
      )}

      {platformAccounts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <EmptyIcon className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="font-medium">{emptyLabel}</p>
          <p className="text-sm mt-1">{emptyHint}</p>
        </div>
      ) : commentsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : commentsError ? (
        <div className="text-center py-12 text-muted-foreground">
          <Camera className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="font-medium">Couldn&apos;t load {getPlatformName(platform)} comments</p>
          <p className="text-sm mt-1">{commentsError instanceof Error ? commentsError.message : "The platform did not return comments for this account."}</p>
        </div>
      ) : (
        <CommentList
          comments={comments}
          socialAccountId={activeAccountId!}
          hiddenFilter={hiddenFilter}
        />
      )}
    </div>
  );
}