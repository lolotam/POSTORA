import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { useProfileOAuth } from "@/hooks/useProfileOAuth";
import { useWhatsAppConnect, useWhatsAppReconnect } from "@/hooks/useWhatsAppConnect";
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

  const { data, isError, isFetching, refetch } = useAccountsNeedingReconnect();
  const accountsNeedingReauth = data?.accounts ?? [];
  // One of the two queries can fail on its own. The accounts that did load are still
  // shown, and the failed half is reported here so the owner knows the list is partial
  // and can ask for it again.
  const checkFailed = isError || data?.partialError != null;

  // A Meta-hosted WhatsApp account has no OAuth branch to fall back on, so it reconnects
  // through the WhatsApp reconnect flow instead.
  const reconnectWhatsApp = useWhatsAppReconnect();
  // A Meta account whose credential expired needs a NEW credential, which only the
  // Embedded Signup connect flow can issue.
  const connectWhatsApp = useWhatsAppConnect();

  // Filter out dismissed accounts
  const visibleAccounts = accountsNeedingReauth.filter(
    (account) => !dismissedAccounts.has(account.id)
  );

  if (visibleAccounts.length === 0 && !checkFailed) {
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
      {checkFailed && (
        <Alert variant="default" className="border-muted">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {t("reauth.checkFailed", "Some accounts could not be checked")}
          </AlertTitle>
          <AlertDescription className="mt-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-sm">
                {t(
                  "reauth.checkFailedDescription",
                  "The list of accounts that need a reconnection could not be loaded completely. Accounts already known to need one are still listed below."
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
                disabled={isFetching}
              >
                <RefreshCw className="w-3 h-3 me-1" />
                {t("reauth.retry", "Retry")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
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
                  ) : target.kind === "whatsapp_meta_connect" ? (
                    <Button
                      size="sm"
                      onClick={() => connectWhatsApp.mutate(target.mode)}
                      disabled={connectWhatsApp.isPending}
                    >
                      {connectWhatsApp.isPending ? (
                        <>
                          <RefreshCw className="w-3 h-3 me-1 motion-safe:animate-spin" />
                          {t("reauth.connecting", "Connecting...")}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-3 h-3 me-1" />
                          {t("reauth.reconnectWhatsapp", "Reconnect WhatsApp")}
                        </>
                      )}
                    </Button>
                  ) : target.kind === "whatsapp_meta" ? (
                    <Button
                      size="sm"
                      onClick={() => reconnectWhatsApp.mutate(account.id)}
                      disabled={reconnectWhatsApp.isPending}
                    >
                      {reconnectWhatsApp.isPending ? (
                        <>
                          <RefreshCw className="w-3 h-3 me-1 motion-safe:animate-spin" />
                          {t("reauth.connecting", "Connecting...")}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-3 h-3 me-1" />
                          {t("reauth.reconnectWhatsapp", "Reconnect WhatsApp")}
                        </>
                      )}
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
