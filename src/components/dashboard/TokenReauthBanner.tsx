import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { useProfileOAuth } from "@/hooks/useProfileOAuth";
import { InstagramConnectDialog, type InstagramFlow } from "@/components/profiles/InstagramConnectDialog";
import { useState } from "react";
import { Platform } from "@/lib/types";
import {
  useAccountsNeedingReconnect,
  type AccountNeedingReconnect,
} from "@/hooks/useAccountsNeedingReconnect";
import { reconnectTargetFor } from "@/lib/reconnectTarget";

export function TokenReauthBanner() {
  const { t } = useTranslation("dashboard");
  const [dismissedAccounts, setDismissedAccounts] = useState<Set<string>>(new Set());
  const {
    handleReconnectPlatform,
    connectingPlatform,
    instagramFlowRequest,
    selectInstagramFlow,
    clearInstagramFlowRequest,
  } = useProfileOAuth();

  const { data: accountsNeedingReauth = [] } = useAccountsNeedingReconnect();

  // Filter out dismissed accounts
  const visibleAccounts = accountsNeedingReauth.filter(
    (account) => !dismissedAccounts.has(account.id)
  );

  if (visibleAccounts.length === 0) {
    return null;
  }

  const handleReconnect = async (account: AccountNeedingReconnect) => {
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
      {visibleAccounts.map((account) => {
        // A WhatsApp account paired through Evolution is not an expired token: its
        // session is gone and only a new QR code brings it back, so it gets its own
        // headline and its own button.
        const target = reconnectTargetFor(account);
        const isDroppedSession = target.kind === "link";

        return (
          <Alert
            key={account.id}
            variant="destructive"
            className="border-destructive/50 bg-destructive/10"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              <PlatformIcon platform={account.platform as ExtendedPlatform} size="sm" />
              {isDroppedSession
                ? t("reauth.disconnected", "{{platform}} Disconnected", {
                    platform: getPlatformName(account.platform as ExtendedPlatform),
                  })
                : t("reauth.connectionExpired", "{{platform}} Connection Expired", {
                    platform: getPlatformName(account.platform as ExtendedPlatform),
                  })}
            </AlertTitle>
            <AlertDescription className="mt-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <p className="text-sm">
                    {account.platform_username
                      ? t("reauth.accountWithUsernameNeedsReconnect", "Your {{platform}} account (@{{username}}) needs to be reconnected.", {
                          platform: getPlatformName(account.platform as ExtendedPlatform),
                          username: account.platform_username,
                        })
                      : t("reauth.accountNeedsReconnect", "Your {{platform}} account needs to be reconnected.", {
                          platform: getPlatformName(account.platform as ExtendedPlatform),
                        })}
                  </p>
                  {account.last_refresh_error && (
                    <p className="text-xs text-muted-foreground mt-1 truncate max-w-[400px]">
                      {t("reauth.error", "Error: {{error}}", { error: account.last_refresh_error })}
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
                    <X className="w-3 h-3 me-1" />
                    {t("reauth.dismiss", "Dismiss")}
                  </Button>
                  {target.kind === "link" ? (
                    <Button asChild size="sm">
                      <Link to={target.path}>
                        <RefreshCw className="w-3 h-3 me-1" />
                        {t("reauth.reconnectWhatsapp", "Reconnect WhatsApp")}
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleReconnect(account)}
                      disabled={connectingPlatform === account.platform}
                    >
                      {connectingPlatform === account.platform ? (
                        <>
                          <RefreshCw className="w-3 h-3 me-1 animate-spin" />
                          {t("reauth.connecting", "Connecting...")}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-3 h-3 me-1" />
                          {t("reauth.reconnect", "Reconnect")}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
