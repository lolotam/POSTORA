import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { RefreshCw, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface WhatsAppQrScannerProps {
  socialAccountId: string;
  onComplete: () => void;
  /** Offered on a number mismatch: abandon this connection and onboard a new one. */
  onConnectAsNew?: () => void;
}

interface QrStatus {
  qr: string | null;
  state: string | null;
  expectedLast4: string | null;
}

function qrImageSource(qr: string): string {
  return qr.startsWith("data:image/") ? qr : `data:image/png;base64,${qr}`;
}

export function WhatsAppQrScanner({ socialAccountId, onComplete, onConnectAsNew }: WhatsAppQrScannerProps) {
  const { t } = useTranslation("whatsapp");
  const [status, setStatus] = useState<QrStatus>({ qr: null, state: null, expectedLast4: null });
  const [secondsLeft, setSecondsLeft] = useState(45);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completionReported = useRef(false);
  // Once a mismatch is seen, a later "open" (a settling session, a stray webhook) must
  // not report completion while the owner is being asked which phone this is.
  const mismatchSeen = useRef(false);

  const pollStatus = useCallback(async (refreshQr = false) => {
    const { data, error: invokeError } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
      body: { action: "get_qr_status", social_account_id: socialAccountId, refresh_qr: refreshQr },
    });
    if (invokeError || data?.error) throw new Error(invokeError?.message || data?.error || t("qr.statusFallback", "Unable to read QR status"));
    const nextStatus = { qr: data.qr || null, state: data.state || null, expectedLast4: data.expected_last4 || null };
    setStatus(nextStatus);
    setError(null);
    if (nextStatus.state === "number_mismatch") mismatchSeen.current = true;
    if (nextStatus.state === "open" && !mismatchSeen.current && !completionReported.current) {
      completionReported.current = true;
      window.setTimeout(onComplete, 1500);
    }
    if (refreshQr) setSecondsLeft(45);
  }, [onComplete, socialAccountId, t]);

  useEffect(() => {
    void pollStatus().catch((err: Error) => setError(err.message));
    const pollTimer = window.setInterval(() => {
      void pollStatus().catch((err: Error) => setError(err.message));
    }, 2000);
    const countdownTimer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(countdownTimer);
    };
  }, [pollStatus]);

  const refreshQr = async () => {
    setIsRefreshing(true);
    try {
      await pollStatus(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("qr.refreshFailedFallback", "Unable to refresh QR code");
      setError(message);
      toast({ title: t("qr.refreshFailed", "QR refresh failed"), description: message, variant: "destructive" });
    } finally {
      setIsRefreshing(false);
    }
  };

  // The owner chose to scan the right phone: restart the same connection's QR flow.
  const restartScan = async () => {
    setIsReconnecting(true);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "reconnect_qr", social_account_id: socialAccountId },
      });
      if (invokeError || data?.error) {
        throw new Error(invokeError?.message || data?.error || t("qr.refreshFailedFallback", "Unable to refresh QR code"));
      }
      mismatchSeen.current = false;
      setStatus({ qr: data.qr || null, state: data.state || null, expectedLast4: null });
      setSecondsLeft(45);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("qr.refreshFailedFallback", "Unable to refresh QR code");
      setError(message);
      toast({ title: t("qr.refreshFailed", "QR refresh failed"), description: message, variant: "destructive" });
    } finally {
      setIsReconnecting(false);
    }
  };

  if (status.state === "number_mismatch") {
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-4 p-6">
          <p className="text-sm font-medium text-destructive">
            {t("qr.mismatch", "You scanned a different phone. This connection belongs to the number ending {{last4}}.", { last4: status.expectedLast4 ?? "" })}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="gap-2" onClick={() => void restartScan()} disabled={isReconnecting}>
              {isReconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("qr.mismatchRescan", "Scan the right phone")}
            </Button>
            <Button variant="outline" onClick={() => onConnectAsNew?.()}>
              {t("qr.mismatchConnectNew", "Connect as a new account")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.state === "open") {
    return (
      <Card className="border-green-500/40">
        <CardContent className="flex items-center gap-3 p-6 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-6 w-6" />
          <div><p className="font-medium">{t("qr.connected", "WhatsApp connected")}</p><p className="text-sm">{t("qr.connectedHint", "Your Direct QR session is now active.")}</p></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("qr.scanTitle", "Scan the WhatsApp QR code")}</CardTitle>
        <CardDescription>{t("qr.scanHint", "Open WhatsApp on your phone, choose Linked devices, then scan this code.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex min-h-[512px] items-center justify-center rounded-md border bg-white p-3">
          {status.qr && secondsLeft > 0 ? (
            <img src={qrImageSource(status.qr)} alt={t("qr.alt", "WhatsApp connection QR code")} width={512} height={512} className="h-[512px] w-[512px] max-w-full" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              {secondsLeft === 0 ? t("qr.expired", "QR code expired") : t("qr.waitingCode", "Waiting for QR code")}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{status.state === "connecting" || !status.state ? t("qr.waitingScan", "Waiting for phone scan") : status.state}</span>
          <span>{t("qr.remaining", "{{count}}s remaining", { count: secondsLeft })}</span>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button variant="outline" className="w-full gap-2" onClick={() => void refreshQr()} disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          {t("qr.refresh", "Refresh QR code")}
        </Button>
      </CardContent>
    </Card>
  );
}
