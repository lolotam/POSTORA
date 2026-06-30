import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { isTokenExpired, formatTokenExpiry } from "@/lib/tokenUtils";
import { TokenLifetimeInfo, ReconnectionFrequencyBadge } from "./TokenLifetimeInfo";
import { SocialAccountWithProfile } from "@/hooks/useSocialProfiles";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/shared";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  Plus,
  ClipboardCopy,
  Trash2,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { GradientRingCard, Icon3D } from "@/components/fx";
import { platformVariant } from "./platformVariant";
import { Plug } from "lucide-react";

function PinterestBoardIdCell({
  account,
  onCopy,
}: {
  account: SocialAccountWithProfile;
  onCopy: (id: string, e: React.MouseEvent) => void;
}) {
  const { data: boards, isLoading } = useQuery({
    queryKey: ["pinterest-boards", account.id],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("pinterest-boards", {
        body: { user_id: account.user_id },
      });
      if (error) throw error;
      return data?.boards || [];
    },
    staleTime: 5 * 60 * 1000,
    enabled: account.platform === "pinterest",
  });

  if (isLoading) return <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />;
  if (!boards || boards.length === 0) return <span className="text-xs text-muted-foreground">No boards</span>;

  const firstBoard = boards[0];
  const boardId = firstBoard?.id || "";
  const boardName = firstBoard?.name || "Unknown";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <code className="text-xs bg-primary/10 px-2 py-1 rounded font-mono text-primary">
              {boardId.length > 16 ? boardId.slice(0, 16) + "..." : boardId}
            </code>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => onCopy(boardId, e)}>
              <ClipboardCopy className="w-3 h-3" />
            </Button>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="text-xs space-y-1">
            <p><strong>Board:</strong> {boardName}</p>
            <p><strong>ID:</strong> {boardId}</p>
            {boards.length > 1 && <p className="text-muted-foreground">+{boards.length - 1} more boards</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface PlatformAccountsTabProps {
  platform: Platform;
  accounts: SocialAccountWithProfile[];
  onConnect: () => void;
  onDisconnect: (account: SocialAccountWithProfile) => void;
  onReconnect: (platform: Platform, socialAccountId: string) => void;
  isConnecting: boolean;
}

export function PlatformAccountsTab({
  platform,
  accounts,
  onConnect,
  onDisconnect,
  onReconnect,
  isConnecting,
}: PlatformAccountsTabProps) {
  const { toast } = useToast();
  const { copy } = useCopyToClipboard();
  const { flags } = useFeatureFlags();
  const [isRefreshingYouTube, setIsRefreshingYouTube] = React.useState(false);

  const handleCopy = async (text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await copy(text);
    toast({ title: "Copied!", description: "Copied to clipboard." });
  };

  const handleYouTubeRefreshToken = async () => {
    if (accounts.length === 0) return;
    setIsRefreshingYouTube(true);
    try {
      const youtubeAccountIds = accounts.map(a => a.id);
      const { data, error } = await supabase.functions.invoke("refresh-tokens", {
        body: { accountIds: youtubeAccountIds, force: true, platforms: ["youtube"] },
      });
      if (error) throw error;
      const refreshed = data?.refreshed || 0;
      toast({
        title: refreshed > 0 ? "YouTube token refreshed" : "No refresh needed",
        description: refreshed > 0
          ? `Successfully refreshed ${refreshed} YouTube token(s).`
          : "Tokens are still valid or could not be refreshed.",
      });
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof Error ? err.message : "Could not refresh YouTube tokens.",
        variant: "destructive",
      });
    } finally {
      setIsRefreshingYouTube(false);
    }
  };

  const getPinterestAccessLevel = (account: SocialAccountWithProfile): "standard" | "trial" | "unknown" => {
    if (account.platform !== "pinterest") return "unknown";
    const metadata = account.account_metadata as { has_write_access?: boolean; access_level?: string } | null;
    if (metadata?.has_write_access === true || metadata?.access_level === "standard") return "standard";
    if (metadata?.has_write_access === false || metadata?.access_level === "trial") return "trial";
    return "unknown";
  };

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <GradientRingCard variant={platformVariant(platform)}>
          <div className="flex flex-col items-center text-center py-8">
            <Icon3D icon={Plug} variant={platformVariant(platform)} size="lg" />
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/70 px-3 py-1 text-xs">
              <PlatformIcon platform={platform} size="xs" />
              <span className="font-medium">{getPlatformName(platform)}</span>
            </div>
            <p className="mt-3 text-muted-foreground max-w-sm">
              No {getPlatformName(platform)} accounts connected yet. Connect one to start publishing.
            </p>
            <Button onClick={onConnect} disabled={isConnecting} className="mt-5 gap-2">
              {isConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Connect {getPlatformName(platform)} Account
            </Button>
          </div>
        </GradientRingCard>
      ) : (
        <>
          <GradientRingCard
            variant={platformVariant(platform)}
            padded={false}
            innerClassName="overflow-hidden"
          >
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-[50px]">#</TableHead>
                  <TableHead className="w-[180px]">Account Name</TableHead>
                  <TableHead className={platform === "pinterest" ? "w-[180px]" : "w-[280px]"}>User ID</TableHead>
                   {platform === "pinterest" && <TableHead className="w-[180px]">Board ID</TableHead>}
                   {flags.tokenExpires && <TableHead className="w-[120px]">Token Expires</TableHead>}
                   {flags.tokenLifetime && <TableHead className="w-[140px]">Token Lifetime</TableHead>}
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account, index) => {
                  const expired = isTokenExpired(account.token_expires_at);
                  const needsReauth = account.needs_reauth;

                  return (
                    <TableRow
                      key={account.id}
                      className="animate-fade-in"
                      style={{ animationDelay: `${index * 40}ms` }}
                    >
                      <TableCell className="text-muted-foreground font-mono text-sm">{index + 1}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {account.avatar_url && (
                            <Avatar className="w-5 h-5">
                              <AvatarImage src={account.avatar_url} alt={account.platform_username || ""} />
                              <AvatarFallback className="text-[8px]">
                                <PlatformIcon platform={account.platform} size="xs" />
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <span className="text-sm font-medium">{account.platform_username || "Unknown"}</span>
                          {account.platform === "instagram" && (() => {
                            const meta = account.account_metadata as Record<string, unknown> | null;
                            const isBusinessLogin = account.ig_auth_type === "business_login" || meta?.token_type === "long_lived";
                            return isBusinessLogin ? (
                              <Badge variant="secondary" className="h-4 text-[9px] px-1 bg-green-500/10 text-green-600 border-green-500/30">Direct</Badge>
                            ) : (
                              <Badge variant="secondary" className="h-4 text-[9px] px-1 bg-blue-500/10 text-blue-600 border-blue-500/30">via FB</Badge>
                            );
                          })()}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                            {platform === "pinterest" && account.platform_user_id.length > 18
                              ? account.platform_user_id.slice(0, 18) + "..."
                              : account.platform_user_id}
                          </code>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => handleCopy(account.platform_user_id, e)}>
                            <ClipboardCopy className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                      {platform === "pinterest" && (
                        <TableCell>
                          <PinterestBoardIdCell account={account} onCopy={handleCopy} />
                        </TableCell>
                      )}
                      {flags.tokenExpires && (
                      <TableCell>
                      <div className={`flex items-center gap-1.5 text-xs ${needsReauth ? "text-destructive font-bold" : expired ? "text-destructive" : "text-muted-foreground"}`}>
                          {(expired || needsReauth) && <AlertTriangle className="w-3 h-3" />}
                          {needsReauth ? "Re-auth required" : formatTokenExpiry(account.token_expires_at)}
                        </div>
                      </TableCell>
                      )}
                      {flags.tokenLifetime && (
                      <TableCell>
                         <div className="flex items-center gap-1.5 flex-nowrap">
                          <TokenLifetimeInfo platform={account.platform} compact />
                          <ReconnectionFrequencyBadge platform={account.platform} />
                        </div>
                      </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {needsReauth ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="destructive" className="text-xs gap-1 cursor-help">
                                    <AlertTriangle className="w-3 h-3" />
                                    Action Required
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{account.last_refresh_error || "Connection lost. Please reconnect."}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <Badge
                              variant={expired ? "destructive" : "default"}
                              className={`text-xs ${!expired ? "bg-green-500/10 text-green-500 border-green-500/30" : ""}`}
                            >
                              {expired ? "Expired" : "Active"}
                            </Badge>
                          )}
                          {account.platform === "pinterest" && getPinterestAccessLevel(account) !== "unknown" && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    {getPinterestAccessLevel(account) === "trial" ? (
                                      <Badge variant="outline" className="text-xs gap-1 bg-amber-500/10 text-amber-600 border-amber-500/30 cursor-help">
                                        <ShieldAlert className="w-3 h-3" />Trial
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-xs gap-1 bg-blue-500/10 text-blue-600 border-blue-500/30 cursor-help">
                                        <ShieldCheck className="w-3 h-3" />Standard
                                      </Badge>
                                    )}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {getPinterestAccessLevel(account) === "trial"
                                    ? "Trial Access - Read-only. Upgrade in Pinterest Developer Console."
                                    : "Standard Access - Full write permissions."}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {(expired || needsReauth) && (
                            <Button
                              variant={needsReauth ? "default" : "outline"}
                              size="sm"
                              className={`h-7 text-xs gap-1 ${needsReauth ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground" : ""}`}
                              onClick={() => onReconnect(account.platform, account.id)}
                            >
                              <RefreshCw className="w-3 h-3" />
                              Reconnect
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => onDisconnect(account)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </GradientRingCard>
          <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card/60 backdrop-blur-md p-3">
            <Button onClick={onConnect} disabled={isConnecting} variant="outline" className="gap-2">
              {isConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Connect Another {getPlatformName(platform)} Account
            </Button>
            {platform === "youtube" && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={isRefreshingYouTube}
                onClick={handleYouTubeRefreshToken}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingYouTube ? "animate-spin" : ""}`} />
                Refresh Token
              </Button>
            )}
          </div>
          {platform === "threads" && typeof window !== "undefined" && window.location.protocol !== "https:" && (
            <p className="text-xs text-muted-foreground">
              Threads OAuth requires HTTPS. Use the preview or published URL to connect.
            </p>
          )}
        </>
      )}
    </div>
  );
}
