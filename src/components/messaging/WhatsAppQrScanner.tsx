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

const QR_LIFETIME_MS = 45_000;

function secondsUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function qrImageSource(qr: string): string {
  return qr.startsWith("data:image/") ? qr : `data:image/png;base64,${qr}`;
}

export function WhatsAppQrScanner({ socialAccountId, onComplete, onConnectAsNew }: WhatsAppQrScannerProps) {
  const { t } = useTranslation("whatsapp");
  const [status, setStatus] = useState<QrStatus>({ qr: null, state: null, expectedLast4: null });
  // The code's lifetime is a wall-clock deadline, not a count of timer ticks: browsers
  // throttle intervals in background tabs, and a tick count would keep an expired code
  // on screen without renewing it.
  const qrDeadline = useRef(Date.now() + QR_LIFETIME_MS);
  const [secondsLeft, setSecondsLeft] = useState(QR_LIFETIME_MS / 1000);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completionReported = useRef(false);
  // Once a mismatch is seen, a later "open" (a settling session, a stray webhook) must
  // not report completion or show the success card while the owner is being asked
  // which phone this connection belongs to.
  const mismatchSeen = useRef(false);
  // Bumped by restartScan: a poll answer issued before the restart belongs to the
  // abandoned attempt and must not overwrite the fresh QR with a stale state.
  const pollGeneration = useRef(0);
  // True while the reconnect_qr request is in flight: the poll interval pauses so no
  // new status poll starts behind it.
  const reconnectInFlight = useRef(false);
  // True while a refresh_qr request is in flight, manual or automatic: a second renewal
  // waits for it, and the poll interval pauses so an older stored code cannot land last.
  const renewalInFlight = useRef(false);
  const completionTimer = useRef<number | null>(null);
  // The parent passes a new onComplete on every render; reading it through a ref keeps
  // the poll effect (and the pending completion timer) from restarting on each one.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const restartQrClock = useCallback(() => {
    qrDeadline.current = Date.now() + QR_LIFETIME_MS;
    setSecondsLeft(QR_LIFETIME_MS / 1000);
  }, []);

  const pollStatus = useCallback(async (refreshQr = false) => {
    const generation = pollGeneration.current;
    const { data, error: invokeError } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
      body: { action: "get_qr_status", social_account_id: socialAccountId, refresh_qr: refreshQr },
    });
    if (invokeError || data?.error) throw new Error(invokeError?.message || data?.error || t("qr.statusFallback", "Unable to read QR status"));
    if (generation !== pollGeneration.current) return;
    setStatus((prev) => ({
      qr: data.qr || null,
      state: data.state || null,
      // A mismatch's last4 survives later polls so the card keeps saying which phone is the right one.
      expectedLast4: data.expected_last4 || prev.expectedLast4,
    }));
    setError(null);
    if (data.state === "number_mismatch") mismatchSeen.current = true;
    if (data.state === "open" && !mismatchSeen.current && !completionReported.current) {
      completionReported.current = true;
      completionTimer.current = window.setTimeout(() => onCompleteRef.current(), 1500);
    }
    if (refreshQr) restartQrClock();
  }, [restartQrClock, socialAccountId, t]);

  useEffect(() => {
    void pollStatus().catch((err: Error) => setError(err.message));
    const pollTimer = window.setInterval(() => {
      if (reconnectInFlight.current || renewalInFlight.current) return;
      void pollStatus().catch((err: Error) => setError(err.message));
    }, 2000);
    const countdownTimer = window.setInterval(() => setSecondsLeft(secondsUntil(qrDeadline.current)), 1000);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(countdownTimer);
    };
  }, [pollStatus]);

  // Closing the popup unmounts the scanner: a completion still pending, or a poll answer
  // still in flight, belongs to that closed popup and must not close a newer one.
  useEffect(() => () => {
    if (completionTimer.current !== null) window.clearTimeout(completionTimer.current);
    pollGeneration.current += 1;
  }, []);

  const refreshQr = async () => {
    if (renewalInFlight.current) return;
    renewalInFlight.current = true;
    // A status poll issued before this renewal may still carry the expired stored code;
    // moving the generation on discards its answer.
    pollGeneration.current += 1;
    setIsRefreshing(true);
    try {
      await pollStatus(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("qr.refreshFailedFallback", "Unable to refresh QR code");
      setError(message);
      toast({ platform: "whatsapp", title: t("qr.refreshFailed", "QR refresh failed"), description: message, variant: "destructive" });
    } finally {
      renewalInFlight.current = false;
      setIsRefreshing(false);
    }
  };

  // An unscanned code is replaced when it expires, so the popup always shows a code the
  // phone can still accept. It fires once per expiry: a failed refresh leaves the
  // countdown at zero and waits for the owner's manual retry instead of looping.
  const awaitingScan = status.state === null || status.state === "connecting";
  const expired = secondsLeft === 0;
  // refreshQr is recreated every render; reading it through a ref keeps the effect keyed on
  // the expiry edge alone. refreshQr guards itself against overlapping a manual renewal.
  const refreshQrRef = useRef(refreshQr);
  refreshQrRef.current = refreshQr;
  useEffect(() => {
    if (expired && awaitingScan && !reconnectInFlight.current) void refreshQrRef.current();
  }, [expired, awaitingScan]);

  // The owner chose to scan the right phone: restart the same connection's QR flow.
  const restartScan = async () => {
    setIsReconnecting(true);
    // Invalidate everything already in flight before the new attempt starts.
    pollGeneration.current += 1;
    try {
      // One last status refresh before the reconnect takes over polling; the interval
      // is paused for the duration, and the generation bump in the finally block
      // discards this answer if it lands after the reconnect completed.
      void pollStatus().catch((err: Error) => setError(err.message));
      reconnectInFlight.current = true;
      const { data, error: invokeError } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "reconnect_qr", social_account_id: socialAccountId },
      });
      if (invokeError || data?.error) {
        throw new Error(invokeError?.message || data?.error || t("qr.refreshFailedFallback", "Unable to refresh QR code"));
      }
      mismatchSeen.current = false;
      setStatus({ qr: data.qr || null, state: data.state || null, expectedLast4: null });
      restartQrClock();
      // The reconnect response is authoritative: a status answer issued before it
      // completed belongs to the abandoned attempt and must not overwrite the fresh
      // QR with a stale state. On failure there is no fresh QR, so the racing refresh
      // is left to land and describe the current state.
      pollGeneration.current += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : t("qr.refreshFailedFallback", "Unable to refresh QR code");
      setError(message);
      toast({ platform: "whatsapp", title: t("qr.refreshFailed", "QR refresh failed"), description: message, variant: "destructive" });
    } finally {
      reconnectInFlight.current = false;
      setIsReconnecting(false);
    }
  };

  // After a mismatch, a settling "open" must not flip the card back to success: the
  // owner still has not answered which phone this connection belongs to.
  const showMismatch = status.state === "number_mismatch" || (status.state === "open" && mismatchSeen.current);

  if (showMismatch) {
    return (
      <Card className="border-0 shadow-none">
        <CardContent className="space-y-4 p-0">
          <p className="text-sm font-medium text-destructive">
            {t("qr.mismatch", "You scanned a different phone. This connection belongs to the number ending {{last4}}.", { last4: status.expectedLast4 ?? "" })}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="gap-2" onClick={() => void restartScan()} disabled={isReconnecting}>
              {isReconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t("qr.mismatchRescan", "Scan the right phone")}
            </Button>
            {onConnectAsNew && (
              <Button variant="outline" onClick={() => onConnectAsNew()}>
                {t("qr.mismatchConnectNew", "Connect as a new account")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status.state === "open") {
    return (
      <Card className="border-0 shadow-none">
        <CardContent className="flex items-center gap-3 p-0 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-6 w-6" />
          <div><p className="font-medium">{t("qr.connected", "WhatsApp connected")}</p><p className="text-sm">{t("qr.connectedHint", "Your Direct QR session is now active.")}</p></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="px-0 pt-0">
        <CardTitle>{t("qr.scanTitle", "Scan the WhatsApp QR code")}</CardTitle>
        <CardDescription>{t("qr.scanHint", "Open WhatsApp on your phone, choose Linked devices, then scan this code.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-0 pb-0">
        <div className="mx-auto flex aspect-square w-full max-w-[400px] items-center justify-center rounded-md border bg-white p-3">
          {status.qr && secondsLeft > 0 ? (
            <img src={qrImageSource(status.qr)} alt={t("qr.alt", "WhatsApp connection QR code")} width={400} height={400} className="h-full w-full" />
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
