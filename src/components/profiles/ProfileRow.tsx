import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { ExtendedPlatform, PlatformConfig, isPlatformType } from "@/lib/platformConstants";
import { isTokenExpired, isTokenExpiringSoon, formatTokenExpiry } from "@/lib/tokenUtils";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { TokenLifetimeInfo, ReconnectionFrequencyBadge } from "./TokenLifetimeInfo";
import { useToast } from "@/hooks/use-toast";
import { useCopyToClipboard } from "@/hooks/shared";
import { usePlatformAccess } from "@/components/profiles/ProfilesHeader";
import {
  useSocialAccountsByProfile,
  useToggleProfilePublic,
  SocialProfile,
  SocialAccountWithProfile,
} from "@/hooks/useSocialProfiles";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  X,
  Share2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  Clock,
  ClipboardCopy,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  Lock,
  CheckCircle,
  Crown,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";

// Component to fetch and display Pinterest Board ID
function PinterestBoardIdCell({
  account,
  onCopy
}: {
  account: SocialAccountWithProfile;
  onCopy: (id: string, e: React.MouseEvent) => void;
}) {
  const { data: boards, isLoading } = useQuery({
    queryKey: ['pinterest-boards', account.id],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('pinterest-boards', {
        body: { user_id: account.user_id }
      });
      if (error) throw error;
      return data?.boards || [];
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    enabled: account.platform === 'pinterest',
  });

  if (isLoading) {
    return <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />;
  }

  if (!boards || boards.length === 0) {
    return <span className="text-xs text-muted-foreground">No boards</span>;
  }

  // Show the first board ID (users can have multiple boards)
  const firstBoard = boards[0];
  const boardId = firstBoard?.id || '';
  const boardName = firstBoard?.name || 'Unknown';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <code className="text-xs bg-primary/10 px-2 py-1 rounded font-mono text-primary">
              {boardId.length > 16 ? boardId.slice(0, 16) + "..." : boardId}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={(e) => onCopy(boardId, e)}
              title="Copy Board ID (use this in n8n)"
            >
              <ClipboardCopy className="w-3 h-3" />
            </Button>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="text-xs space-y-1">
            <p><strong>Board:</strong> {boardName}</p>
            <p><strong>ID:</strong> {boardId}</p>
            <p className="text-green-500 font-medium">✓ Use this Board ID in n8n</p>
            {boards.length > 1 && (
              <p className="text-muted-foreground">+{boards.length - 1} more boards available</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface ProfileRowProps {
  profile: SocialProfile;
  allPlatforms: PlatformConfig[];
  onConnectPlatform: (profileId: string, platform: Platform) => void;
  onDeleteProfile: () => void;
  onDisconnectAccount: (account: SocialAccountWithProfile) => void;
  onReconnectAccount: (profileId: string, platform: Platform, socialAccountId: string) => void;
  onRenameProfile: (profileId: string, newName: string) => void;
  connectingProfile: string | null;
  connectingPlatform: Platform | null;
}

export function ProfileRow({
  profile,
  allPlatforms,
  onConnectPlatform,
  onDeleteProfile,
  onDisconnectAccount,
  onReconnectAccount,
  onRenameProfile,
  connectingProfile,
  connectingPlatform,
}: ProfileRowProps) {
  const navigate = useNavigate();
  const { data: accounts = [], isLoading } = useSocialAccountsByProfile(profile.id);
  const togglePublicMutation = useToggleProfilePublic();
  const { toast } = useToast();
  const { copied, copy } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(profile.name);
  const { hasPlatformAccess, isTikTokRestricted } = usePlatformAccess();
  const { flags } = useFeatureFlags();

  const getAccountForPlatform = (platform: ExtendedPlatform): SocialAccountWithProfile | undefined => {
    return accounts.find((acc) => acc.platform === platform);
  };

  // Check if Pinterest account has write access (Standard Access)
  const getPinterestAccessLevel = (account: SocialAccountWithProfile): 'standard' | 'trial' | 'unknown' => {
    if (account.platform !== 'pinterest') return 'unknown';
    // Check account_metadata for access level info
    const metadata = account.account_metadata as { has_write_access?: boolean; access_level?: string } | null;
    if (metadata?.has_write_access === true || metadata?.access_level === 'standard') {
      return 'standard';
    }
    if (metadata?.has_write_access === false || metadata?.access_level === 'trial') {
      return 'trial';
    }
    return 'unknown';
  };

  const handleCopyAccountId = async (accountId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await copy(accountId);
    toast({
      title: "Copied!",
      description: "Account ID copied to clipboard.",
    });
  };

  const shareUrl = profile.share_token
    ? `${window.location.origin}/p/${profile.share_token}`
    : null;

  const handleTogglePublic = async () => {
    try {
      await togglePublicMutation.mutateAsync({
        profileId: profile.id,
        isPublic: !profile.is_public,
      });
      toast({
        title: profile.is_public ? "Profile is now private" : "Profile is now public",
        description: profile.is_public
          ? "Your profile is no longer publicly accessible."
          : "Anyone with the link can now view your connected accounts.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update profile visibility.",
        variant: "destructive",
      });
    }
  };

  const handleCopyLink = async () => {
    if (shareUrl) {
      await copy(shareUrl);
      toast({
        title: "Link copied!",
        description: "Share link has been copied to clipboard.",
      });
    }
  };

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => accounts.length > 0 && setIsExpanded(!isExpanded)}
      >
        {/* Profile Column */}
        <TableCell>
          <div className="flex items-center gap-2">
            {accounts.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(!isExpanded);
                }}
                className="p-0.5 hover:bg-muted rounded"
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
              </button>
            )}
            {isEditing ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-7 w-32 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRenameProfile(profile.id, editName);
                      setIsEditing(false);
                    } else if (e.key === "Escape") {
                      setEditName(profile.name);
                      setIsEditing(false);
                    }
                  }}
                  onBlur={() => {
                    if (editName !== profile.name && editName.trim()) {
                      onRenameProfile(profile.id, editName);
                    }
                    setIsEditing(false);
                  }}
                />
              </div>
            ) : (
              <span
                className="font-medium cursor-text hover:text-primary transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
                title="Click to rename"
              >
                {profile.name}
              </span>
            )}
            {/* Account count badge */}
            {!isLoading && accounts.length > 0 && (
              <Badge variant="secondary" className="h-5 text-xs">
                {accounts.length}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteProfile();
              }}
              className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </TableCell>

        {/* Status Column */}
        <TableCell>
          <div className="flex items-center gap-1.5">
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : accounts.length > 0 ? (
              <>
                {(() => {
                  const hasNeedsReauth = accounts.some((acc) => acc.needs_reauth);
                  const hasExpired = accounts.some((acc) => isTokenExpired(acc.token_expires_at));
                  const hasExpiringSoon = accounts.some((acc) => isTokenExpiringSoon(acc.token_expires_at));

                  if (hasNeedsReauth) {
                    return (
                      <div className="flex items-center gap-1.5 text-destructive font-medium animate-pulse">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="text-xs">Action Required</span>
                      </div>
                    );
                  }
                  if (hasExpired) {
                    return (
                      <div className="flex items-center gap-1.5 text-destructive">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="text-xs font-medium">Expired</span>
                      </div>
                    );
                  }
                  if (hasExpiringSoon) {
                    return (
                      <div className="flex items-center gap-1.5 text-amber-500">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="text-xs font-medium">Expiring</span>
                      </div>
                    );
                  }
                  return <div className="w-2 h-2 rounded-full bg-green-500" />;
                })()}
                {accounts.map((account) => {
                  const expired = isTokenExpired(account.token_expires_at);
                  const expiringSoon = isTokenExpiringSoon(account.token_expires_at);
                  const needsReauth = account.needs_reauth;

                  return (
                    <div
                      key={account.id}
                      className={`relative ${expired || needsReauth ? "opacity-50" : ""}`}
                      title={
                        needsReauth
                          ? "Re-authentication required"
                          : expired
                            ? "Token expired - reconnect required"
                            : expiringSoon
                              ? "Token expiring soon"
                              : "Connected"
                      }
                    >
                      <PlatformIcon platform={account.platform} size="sm" />
                      {(expired || needsReauth) && (
                        <div className="absolute -top-1 -end-1 w-2 h-2 rounded-full bg-destructive" />
                      )}
                      {!expired && !needsReauth && expiringSoon && (
                        <div className="absolute -top-1 -end-1 w-2 h-2 rounded-full bg-amber-500" />
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No accounts</span>
            )}
          </div>
        </TableCell>

        {/* Social Accounts Column */}
        <TableCell>
          <div className="flex flex-wrap gap-2">
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              allPlatforms.map((config) => {
                const account = getAccountForPlatform(config.platform);
                const isConnected = !!account;
                const isConnecting =
                  connectingProfile === profile.id && connectingPlatform === config.platform;
                const hasAccess = hasPlatformAccess(config.platform);
                const isTikTokBlocked = isTikTokRestricted(config.platform);
                // For TikTok with free users, allow click to redirect to pricing
                const isDisabled = (!config.available && !isConnected) || isConnecting || (!hasAccess && !isConnected && !isTikTokBlocked);

                // Use optional chaining for needs_reauth as it might be undefined on some old records
                const needsReauth = account?.needs_reauth;

                return (
                  <TooltipProvider key={config.platform}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isConnected && account) {
                              // If needs reauth, clicking should reconnect instead of disconnecting
                              if (needsReauth) {
                                onReconnectAccount(profile.id, config.platform, account.id);
                              } else {
                                onDisconnectAccount(account);
                              }
                            } else if (isTikTokBlocked) {
                              // Redirect free users to pricing when clicking TikTok
                              navigate("/pricing");
                            } else if (config.available && hasAccess) {
                              if (isPlatformType(config.platform)) {
                                onConnectPlatform(profile.id, config.platform);
                              }
                            }
                          }}
                          disabled={isDisabled}
                          className={`
                            inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                            transition-colors border relative
                            ${isConnected
                              ? needsReauth
                                ? "bg-destructive/10 border-destructive/30 text-destructive hover:bg-destructive/20"
                                : "bg-primary/10 border-primary/30 text-primary hover:bg-primary/20"
                              : isTikTokBlocked
                                ? "bg-amber-500/10 border-amber-500/30 text-amber-600 hover:bg-amber-500/20 cursor-pointer"
                                : hasAccess && config.available
                                  ? "bg-secondary border-border text-muted-foreground hover:bg-secondary/80"
                                  : "bg-secondary/50 border-border/50 text-muted-foreground/50 cursor-not-allowed"
                            }
                          `}
                        >
                          {isConnecting ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : isConnected && account?.avatar_url ? (
                            <Avatar className="w-4 h-4">
                              <AvatarImage src={account.avatar_url} alt={account.platform_username || ""} />
                              <AvatarFallback className="text-[8px]">
                                <PlatformIcon platform={config.platform as Platform} size="sm" />
                              </AvatarFallback>
                            </Avatar>
                          ) : (
                            <PlatformIcon platform={config.platform as Platform} size="sm" />
                          )}
                          {isConnected && account?.platform_username
                            ? account.platform_username.length > 12
                              ? account.platform_username.slice(0, 12) + "..."
                              : account.platform_username
                            : config.name}
                          {isConnected && account?.platform === "instagram" && (
                            (() => {
                              const meta = account.account_metadata as Record<string, unknown> | null;
                              const isBusinessLogin = account.ig_auth_type === "business_login" || meta?.token_type === "long_lived";
                              return isBusinessLogin ? (
                                <Badge variant="secondary" className="ms-1 h-4 text-[9px] px-1 bg-green-500/10 text-green-600 border-green-500/30">Direct</Badge>
                              ) : (
                                <Badge variant="secondary" className="ms-1 h-4 text-[9px] px-1 bg-blue-500/10 text-blue-600 border-blue-500/30">via FB</Badge>
                              );
                            })()
                          )}
                          {isConnected ? (
                            needsReauth ? (
                              <RefreshCw className="w-3 h-3 ms-0.5" />
                            ) : (
                              <X className="w-3 h-3 ms-0.5 text-destructive" />
                            )
                          ) : isTikTokBlocked ? (
                            <Crown className="w-3 h-3 ms-0.5 text-amber-500" />
                          ) : hasAccess && config.available ? (
                            <CheckCircle className="w-3 h-3 ms-0.5 text-green-500" />
                          ) : !hasAccess ? (
                            <Lock className="w-3 h-3 ms-0.5 text-amber-500" />
                          ) : null}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isConnected ? (
                          needsReauth ? (
                            <span>Action Required: Click to Reconnect {config.name}</span>
                          ) : (
                            <span>Click to disconnect {config.name}</span>
                          )
                        ) : isTikTokBlocked ? (
                          <span className="flex items-center gap-1">
                            <Crown className="w-3 h-3 text-amber-500" />
                            Click to upgrade to Pro for TikTok
                          </span>
                        ) : !hasAccess ? (
                          <span className="flex items-center gap-1">
                            <Crown className="w-3 h-3 text-amber-500" />
                            Upgrade to Pro to connect {config.name}
                          </span>
                        ) : !config.available ? (
                          <span>{config.name} is currently unavailable</span>
                        ) : (
                          <span>Connect {config.name}</span>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })
            )}
          </div>
        </TableCell>

        {/* Whitelabel Column */}
        <TableCell className="text-end">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              if (profile.is_public && shareUrl) {
                handleCopyLink();
              } else {
                handleTogglePublic();
              }
            }}
            className="gap-1.5"
          >
            <Share2 className="w-3.5 h-3.5" />
            Share
          </Button>
        </TableCell>
      </TableRow>

      {/* Expandable Account Details Row */}
      {isExpanded && accounts.length > 0 && (
        <TableRow className="bg-muted/30">
          <TableCell colSpan={4} className="p-0">
            <div className="px-6 py-4">
              <div className="rounded-lg border bg-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-[100px]">Platform</TableHead>
                      <TableHead className="w-[180px]">Account Name</TableHead>
                      <TableHead className={accounts.some(a => a.platform === 'pinterest') ? "w-[180px]" : "w-[280px]"}>User ID</TableHead>
                      {accounts.some(a => a.platform === 'pinterest') && <TableHead className="w-[180px]">Board ID</TableHead>}
                      {flags.tokenExpires && <TableHead className="w-[120px]">Token Expires</TableHead>}
                      {flags.tokenLifetime && <TableHead className="w-[140px]">Token Lifetime</TableHead>}
                      <TableHead className="w-[100px]">Status</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((account) => {
                      const expired = isTokenExpired(account.token_expires_at);
                      const expiringSoon = isTokenExpiringSoon(account.token_expires_at);
                      const needsReauth = account.needs_reauth;
                      const isReconnecting =
                        connectingProfile === profile.id && connectingPlatform === account.platform;

                      return (
                        <TableRow key={account.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <PlatformIcon platform={account.platform} size="sm" />
                              <span className="capitalize text-sm">{account.platform}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {account.avatar_url && (
                                <Avatar className="w-5 h-5">
                                  <AvatarImage
                                    src={account.avatar_url}
                                    alt={account.platform_username || ""}
                                  />
                                  <AvatarFallback className="text-[8px]">
                                    <PlatformIcon platform={account.platform} size="xs" />
                                  </AvatarFallback>
                                </Avatar>
                              )}
                              <span className="text-sm font-medium">
                                {account.platform_username || "Unknown"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                {account.platform_user_id}
                              </code>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={(e) => handleCopyAccountId(account.platform_user_id, e)}
                                title="Copy User ID"
                              >
                                <ClipboardCopy className="w-3 h-3" />
                              </Button>
                            </div>
                          </TableCell>
                          {accounts.some(a => a.platform === 'pinterest') && (
                            <TableCell>
                              {account.platform === 'pinterest' ? (
                                <PinterestBoardIdCell account={account} onCopy={handleCopyAccountId} />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                          {flags.tokenExpires && (
                          <TableCell>
                            <div
                              className={`flex items-center gap-1.5 text-xs ${needsReauth
                                  ? "text-destructive font-bold"
                                  : expired
                                    ? "text-destructive"
                                    : expiringSoon
                                      ? "text-amber-500"
                                      : "text-muted-foreground"
                                }`}
                            >
                              {(expired || expiringSoon || needsReauth) && <AlertTriangle className="w-3 h-3" />}
                              {needsReauth
                                ? "Re-auth required"
                                : formatTokenExpiry(account.token_expires_at)
                              }
                            </div>
                          </TableCell>
                          )}
                          {flags.tokenLifetime && (
                          <TableCell>
                            <div className="flex items-center gap-1.5">
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
                                  variant={expired ? "destructive" : expiringSoon ? "secondary" : "default"}
                                  className={`text-xs ${!expired && !expiringSoon ? "bg-green-500/10 text-green-500 border-green-500/30" : ""
                                    }`}
                                >
                                  {expired ? "Expired" : expiringSoon ? "Expiring" : "Active"}
                                </Badge>
                              )}
                              {/* Pinterest access level indicator */}
                              {account.platform === 'pinterest' && getPinterestAccessLevel(account) !== 'unknown' && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex">
                                        {getPinterestAccessLevel(account) === 'trial' ? (
                                          <Badge variant="outline" className="text-xs gap-1 bg-amber-500/10 text-amber-600 border-amber-500/30 cursor-help">
                                            <ShieldAlert className="w-3 h-3" />
                                            Trial
                                          </Badge>
                                        ) : (
                                          <Badge variant="outline" className="text-xs gap-1 bg-blue-500/10 text-blue-600 border-blue-500/30 cursor-help">
                                            <ShieldCheck className="w-3 h-3" />
                                            Standard
                                          </Badge>
                                        )}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {getPinterestAccessLevel(account) === 'trial' ? (
                                        <p className="max-w-xs text-xs">
                                          Trial Access - Read-only. Upgrade to Standard Access in the Pinterest Developer Console to create pins.
                                        </p>
                                      ) : (
                                        <p className="max-w-xs text-xs">
                                          Standard Access - Full write permissions. You can create and manage pins.
                                        </p>
                                      )}
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onReconnectAccount(profile.id, account.platform, account.id);
                                  }}
                                  disabled={isReconnecting}
                                >
                                  {isReconnecting ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-3 h-3" />
                                  )}
                                  Reconnect
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDisconnectAccount(account);
                                }}
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
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
