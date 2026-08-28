import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { useProfileOAuth } from "@/hooks/useProfileOAuth";
import { InstagramConnectDialog, type InstagramFlow } from "@/components/profiles/InstagramConnectDialog";
import { useState } from "react";
import { Platform } from "@/lib/types";

interface AccountNeedingReauth {
  id: string;
  platform: string;
  platform_username: string | null;
  needs_reauth: boolean;
  last_refresh_error: string | null;
  social_profile_id: string | null;
}

export function TokenReauthBanner() {
  const { user } = useAuth();
  const [dismissedAccounts, setDismissedAccounts] = useState<Set<string>>(new Set());
  const {
    handleReconnectPlatform,
    connectingPlatform,
    instagramFlowRequest,
    selectInstagramFlow,
    clearInstagramFlowRequest,
  } = useProfileOAuth();

  const { data: accountsNeedingReauth = [] } = useQuery({
    queryKey: ["accounts-needing-reauth", user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform, platform_username, needs_reauth, last_refresh_error, social_profile_id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("needs_reauth", true);

      if (error) throw error;
      return (data || []) as AccountNeedingReauth[];
    },
    enabled: !!user,
    refetchInterval: 60000, // Check every minute
  });

  // Filter out dismissed accounts
  const visibleAccounts = accountsNeedingReauth.filter(
    (account) => !dismissedAccounts.has(account.id)
  );

  if (visibleAccounts.length === 0) {
    return null;
  }

  const handleReconnect = async (account: AccountNeedingReauth) => {
    // Reconnect mode: backend updates the existing social_accounts row in
    // place using account.id, then redirects with `?reconnected=1` so the
    // banner clears immediately via query invalidation.
    await handleReconnectPlatform(
      account.social_profile_id || "",
      account.platform as Platform,
      account.id,
    );
  };

  const handleDismiss = (accountId: string) => {
    setDismissedAccounts((prev) => new Set([...prev, accountId]));
  };

  return (
    <div className="space-y-3">
      {/* Instagram reconnects ask which login method to use before any redirect. */}
      <InstagramConnectDialog
        open={!!instagramFlowRequest}
        onOpenChange={(open) => { if (!open) clearInstagramFlowRequest(); }}
        disabled={connectingPlatform === "instagram"}
        onSelect={(flow: InstagramFlow) => selectInstagramFlow(flow)}
      />
      {visibleAccounts.map((account) => (
        <Alert
          key={account.id}
          variant="destructive"
          className="border-destructive/50 bg-destructive/10"
        >
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="flex items-center gap-2">
            <PlatformIcon platform={account.platform as ExtendedPlatform} size="sm" />
            {getPlatformName(account.platform as ExtendedPlatform)} Connection Expired
          </AlertTitle>
          <AlertDescription className="mt-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm">
                  Your {getPlatformName(account.platform as ExtendedPlatform)} account
                  {account.platform_username && (
                    <span className="font-medium"> (@{account.platform_username})</span>
                  )}{" "}
                  needs to be reconnected.
                </p>
                {account.last_refresh_error && (
                  <p className="text-xs text-muted-foreground mt-1 truncate max-w-[400px]">
                    Error: {account.last_refresh_error}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDismiss(account.id)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3 mr-1" />
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleReconnect(account)}
                  disabled={connectingPlatform === account.platform}
                >
                  {connectingPlatform === account.platform ? (
                    <>
                      <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Reconnect
                    </>
                  )}
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
