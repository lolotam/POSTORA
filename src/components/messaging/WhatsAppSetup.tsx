import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  MessageSquare,
  Phone,
  Shield,
  Zap,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Smartphone,
  Cloud,
  ArrowRightLeft,
  Unplug,
  X,
  Check,
  RefreshCw,
  QrCode,
} from "lucide-react";
import type { MessagingAccount } from "@/hooks/useMessaging";
import {
  useWhatsAppConnect,
  useWhatsAppDisconnect,
  useWhatsAppRequestSync,
} from "@/hooks/useWhatsAppConnect";
import { useUserRole } from "@/hooks/useUserRole";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { WhatsAppAdminSetupGuide } from "./WhatsAppAdminSetupGuide";
import { useWhatsAppTpStatus } from "@/hooks/useWhatsAppTpStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Info, Clock } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { WhatsAppQrDisclaimerDialog } from "./WhatsAppQrDisclaimerDialog";
import { WhatsAppQrScanner } from "./WhatsAppQrScanner";
import { supabase } from "@/integrations/supabase/client";

interface WhatsAppSetupProps {
  connectedAccounts: MessagingAccount[];
  onConnectClick?: () => void;
}

export function WhatsAppSetup({ connectedAccounts }: WhatsAppSetupProps) {
  const whatsappAccounts = connectedAccounts.filter((a) => a.platform === "whatsapp");
  const hasConnected = whatsappAccounts.length > 0;
  const connect = useWhatsAppConnect();
  const disconnect = useWhatsAppDisconnect();
  const requestSync = useWhatsAppRequestSync();
  const { isAdmin } = useUserRole();
  const { flags } = useFeatureFlags();
  const queryClient = useQueryClient();
  const cloudApiEnabled = flags.waCloudApiEnabled;
  const evolutionQrEnabled = flags.waEvolutionQrEnabled;
  const { status: tpStatus, isLoading: tpLoading } = useWhatsAppTpStatus();

  const [pendingMode, setPendingMode] = useState<"cloud_api" | "coexistence" | null>(null);
  const [qrNameOpen, setQrNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const [qrDisclaimerOpen, setQrDisclaimerOpen] = useState(false);
  const [qrAccountId, setQrAccountId] = useState<string | null>(null);
  const [qrConnecting, setQrConnecting] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<MessagingAccount | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<MessagingAccount | null>(null);
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);

  // Mirrors the bridge's validation (trim, non-empty, <= 60) so an invalid name is
  // never sent for the server to substitute.
  const trimmedName = nameDraft.trim();
  const confirmConnectionName = () => {
    if (!trimmedName || trimmedName.length > 60) return;
    setConnectionName(trimmedName);
    setQrNameOpen(false);
    setQrDisclaimerOpen(true);
  };

  // Direct QR imports history from the Evolution session rather than from Meta, so it does
  // not share the coexistence sync hook. The sweep runs in the background on the server;
  // the inbox picks the conversations up on its next refetch.
  const syncPastChats = async (socialAccountId: string) => {
    setSyncingAccountId(socialAccountId);
    try {
      const { error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "sync_past_chats", social_account_id: socialAccountId },
      });
      if (error) throw error;
      toast({
        title: "Importing your conversations",
        description: "Past chats will appear in the inbox in a few seconds.",
      });
    } catch (error) {
      toast({
        title: "Could not import conversations",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncingAccountId(null);
    }
  };

  const handleConnect = (mode: "cloud_api" | "coexistence") => {
    if (tpStatus === "pending") {
      toast({
        title: "Tech Provider approval pending",
        description:
          "Meta hasn't approved this app for Embedded Signup yet. The popup may not load. We'll notify you once approval is complete.",
      });
    }
    setPendingMode(mode);
    connect.mutate(mode, {
      onSettled: () => setPendingMode(null),
    });
  };

  const handleConfirmSwitch = () => {
    if (!switchTarget) return;
    disconnect.mutate(switchTarget.id);
    setSwitchTarget(null);
  };

  const handleConfirmDisconnect = () => {
    if (!disconnectTarget) return;
    disconnect.mutate(disconnectTarget.id, {
      onSuccess: () => {
        toast({
          title: "WhatsApp disconnected",
          description: "WhatsApp disconnected from Postora.",
        });
      },
    });
    setDisconnectTarget(null);
  };

  const hideConnectButtons = tpStatus === "not_started";

  return (
    <div className="space-y-6">
      {/* Admin-only setup guide */}
      {isAdmin && <WhatsAppAdminSetupGuide />}

      {/* Tech Provider approval notice */}
      {!tpLoading && tpStatus !== "approved" && !hasConnected && (
        <Alert className="border-yellow-500/40 bg-yellow-500/5">
          <Clock className="h-4 w-4 text-yellow-600" />
          <AlertTitle className="text-sm">
            {tpStatus === "not_started"
              ? "WhatsApp connections coming soon"
              : "WhatsApp connections — approval in progress"}
          </AlertTitle>
          <AlertDescription className="text-xs text-muted-foreground">
            {tpStatus === "not_started"
              ? "We're preparing WhatsApp Business connections. This feature will be available once Meta completes our Tech Provider review."
              : "WhatsApp connections require Meta to approve our app as a Tech Provider. Approval is in progress (typically 5–15 business days). You can still try connecting, but the popup may not load until approval is complete."}
          </AlertDescription>
        </Alert>
      )}

      {/* Connection Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <MessageSquare className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <CardTitle className="text-lg">WhatsApp Business</CardTitle>
                <CardDescription>
                  Connect your WhatsApp Business account to send and receive messages
                </CardDescription>
              </div>
            </div>
            <Badge variant={hasConnected ? "default" : "secondary"}>
              {hasConnected ? "Connected" : "Not Connected"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {hasConnected ? (
            <div className="space-y-3">
              {whatsappAccounts.map((account) => {
                const mode = account.connection_mode || "cloud_api";
                const isCoexistence = mode === "coexistence";
                const isEvolutionQr = mode === "evolution_qr";
                return (
                  <div
                    key={account.id}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30"
                  >
                    <Phone className="w-4 h-4 text-green-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">
                          {account.platform_username || account.platform_user_id}
                        </p>
                        <Badge
                          variant="outline"
                          className={
                            isCoexistence
                              ? "border-green-600/40 text-green-700 dark:text-green-400 bg-green-500/10"
                              : isEvolutionQr
                                ? "border-purple-600/40 text-purple-700 dark:text-purple-400 bg-purple-500/10"
                                : "border-blue-600/40 text-blue-700 dark:text-blue-400 bg-blue-500/10"
                          }
                        >
                          {isCoexistence ? "Coexistence" : isEvolutionQr ? "Direct QR" : "Cloud API"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {isCoexistence
                          ? "Mobile app stays active. Chats sync to your phone."
                          : isEvolutionQr
                            ? "Self-hosted WhatsApp session connected by QR code."
                            : "Cloud API only. Mobile app for this number is disabled."}
                      </p>
                    </div>
                    {isCoexistence && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={requestSync.isPending}
                        onClick={() => requestSync.mutate(account.id)}
                        className="gap-1.5"
                      >
                        {requestSync.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Sync phone chats
                      </Button>
                    )}
                    {isEvolutionQr && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={syncingAccountId === account.id}
                        onClick={() => syncPastChats(account.id)}
                        className="gap-1.5"
                      >
                        {syncingAccountId === account.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Sync past chats
                      </Button>
                    )}
                    {!isCoexistence && cloudApiEnabled && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSwitchTarget(account)}
                        className="gap-1.5"
                      >
                        <ArrowRightLeft className="w-3.5 h-3.5" />
                        Switch to Coexistence
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDisconnectTarget(account)}
                      className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Unplug className="w-3.5 h-3.5" />
                      Disconnect
                    </Button>
                    <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Choose how you want to connect your WhatsApp Business number. You'll need a Meta
                Business Manager with a WhatsApp Business Account (WABA).
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {qrAccountId && (
        <WhatsAppQrScanner
          socialAccountId={qrAccountId}
          onComplete={() => {
            setQrAccountId(null);
            queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
            queryClient.invalidateQueries({ queryKey: ["messaging_accounts"] });
          }}
        />
      )}

      {/* Connection mode cards */}
      {!hasConnected && (!hideConnectButtons || evolutionQrEnabled) && (
        <div className={`grid gap-4 ${cloudApiEnabled && evolutionQrEnabled ? "md:grid-cols-3" : cloudApiEnabled || evolutionQrEnabled ? "md:grid-cols-2" : "md:grid-cols-1 max-w-2xl mx-auto"}`}>
          {/* Coexistence */}
          {!hideConnectButtons && <Card className="relative border-green-600/40">
            <Badge className="absolute -top-2 right-4 bg-green-600 hover:bg-green-600">
              Recommended
            </Badge>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-green-600" />
                <CardTitle className="text-base">Coexistence Mode</CardTitle>
              </div>
              <CardDescription>
                Keep using the WhatsApp Business mobile app while Postora handles messages too.
                Chats sync between both.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-1.5 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                  Receive & reply on your phone AND in Postora
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                  Chat history shared across both interfaces
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                  No need to delete the number from your phone
                </li>
              </ul>
              <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2.5 text-xs text-yellow-800 dark:text-yellow-300">
                <strong>Tip:</strong> In the Meta popup, make sure to fill in your{" "}
                <strong>WhatsApp Business account name</strong> — leaving it empty will cause the
                connection to fail.
              </div>
              <Button
                onClick={() => handleConnect("coexistence")}
                disabled={connect.isPending}
                className="w-full gap-2 bg-green-600 hover:bg-green-700"
              >
                {pendingMode === "coexistence" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Smartphone className="w-4 h-4" />
                )}
                Connect with Coexistence
              </Button>
              <p className="text-xs text-muted-foreground">
                Eligibility set by Meta — based on account tenure & messaging quality.
              </p>
            </CardContent>
          </Card>}

          {/* Cloud API */}
          {cloudApiEnabled && !hideConnectButtons && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Cloud className="w-5 h-5 text-blue-600" />
                  <CardTitle className="text-base">Cloud API Only</CardTitle>
                </div>
                <CardDescription>
                  Full automation, broadcasts, and template messages — but the WhatsApp mobile app
                  for this number will be disabled.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-sm">
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                    All Postora automation features
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                    Broadcasts & approved template messages
                  </li>
                  <li className="flex items-start gap-2">
                    <X className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                    Mobile WhatsApp app disabled for this number
                  </li>
                </ul>
                <Button
                  onClick={() => handleConnect("cloud_api")}
                  disabled={connect.isPending}
                  variant="outline"
                  className="w-full gap-2"
                >
                  {pendingMode === "cloud_api" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Cloud className="w-4 h-4" />
                  )}
                  Connect via Cloud API
                </Button>
                <p className="text-xs text-muted-foreground">
                  Best for businesses that don't need the mobile app.
                </p>
              </CardContent>
            </Card>
          )}

          {evolutionQrEnabled && (
            <Card className="border-purple-600/40">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <QrCode className="w-5 h-5 text-purple-600" />
                  <CardTitle className="text-base">Direct QR Mode</CardTitle>
                </div>
                <CardDescription>
                  Connect an existing WhatsApp number by scanning a QR code. Keep the session on your phone and Postora.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-sm">
                  <li className="flex items-start gap-2"><Check className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />Use your existing WhatsApp account</li>
                  <li className="flex items-start gap-2"><Check className="w-4 h-4 text-purple-600 mt-0.5 shrink-0" />Text and media replies in Postora</li>
                  <li className="flex items-start gap-2"><X className="w-4 h-4 text-destructive mt-0.5 shrink-0" />Templates and interactive catalog sends unavailable</li>
                </ul>
                <Button
                  onClick={() => {
                    setNameDraft("");
                    setQrNameOpen(true);
                  }}
                  disabled={qrConnecting}
                  variant="outline"
                  className="w-full gap-2 border-purple-600/40"
                >
                  {qrConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                  Connect with QR code
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Comparison table */}
      {!hasConnected && cloudApiEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compare connection modes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium">Feature</th>
                    <th className="text-center py-2 font-medium text-green-600">Coexistence</th>
                    <th className="text-center py-2 font-medium text-blue-600">Cloud API</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  <tr className="border-b">
                    <td className="py-2">Mobile app stays active</td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                    <td className="text-center"><X className="w-4 h-4 text-destructive inline" /></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">Receive & reply in Postora</td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">Broadcasts</td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">Template messages</td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2">Webhook automation</td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                    <td className="text-center"><Check className="w-4 h-4 text-green-600 inline" /></td>
                  </tr>
                  <tr>
                    <td className="py-2">Eligibility check by Meta</td>
                    <td className="text-center text-xs">Required</td>
                    <td className="text-center text-xs">Standard</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Feature Overview */}
      {!hasConnected && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-dashed">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-2">
                <MessageSquare className="w-8 h-8 text-green-600" />
                <h3 className="font-semibold text-sm">Business Messaging</h3>
                <p className="text-xs text-muted-foreground">
                  Send & receive messages, share media, and manage conversations
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-dashed">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-2">
                <Zap className="w-8 h-8 text-yellow-600" />
                <h3 className="font-semibold text-sm">Automation Ready</h3>
                <p className="text-xs text-muted-foreground">
                  Auto-replies, workflow triggers, and n8n integration
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-dashed">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-2">
                <Shield className="w-8 h-8 text-blue-600" />
                <h3 className="font-semibold text-sm">Template Messages</h3>
                <p className="text-xs text-muted-foreground">
                  Pre-approved templates for notifications, reminders & campaigns
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* The connection name is collected here, before create_and_get_qr fires — the QR
          scanner that mounts afterwards only polls status, and the webhook can activate
          the account before a name sent from there would land. */}
      <Dialog open={qrNameOpen} onOpenChange={setQrNameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Name this connection</DialogTitle>
            <DialogDescription>
              A label for this WhatsApp number in Postora, e.g. "Main line" or "Support".
              You can't change it after connecting.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={60}
            autoFocus
            aria-label="Connection name"
            placeholder="e.g. Main line"
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmedName && trimmedName.length <= 60) confirmConnectionName();
            }}
          />
          <p className="text-xs text-muted-foreground">{trimmedName.length}/60 characters</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQrNameOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={!trimmedName} onClick={confirmConnectionName}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WhatsAppQrDisclaimerDialog
        open={qrDisclaimerOpen}
        onOpenChange={setQrDisclaimerOpen}
        onProceed={async () => {
          setQrDisclaimerOpen(false);
          setQrConnecting(true);
          try {
            const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
              body: { action: "create_and_get_qr", risk_consent: true, connection_name: connectionName },
            });
            if (error || data?.error) throw new Error(error?.message || data?.error || "Unable to start QR connection");
            setQrAccountId(data.social_account_id);
          } catch (error) {
            toast({ title: "QR connection failed", description: error instanceof Error ? error.message : "Unable to start QR connection", variant: "destructive" });
          } finally {
            setQrConnecting(false);
          }
        }}
      />

      {/* Requirements Info */}
      {!hasConnected && (
        <Card className="bg-muted/30">
          <CardContent className="pt-6">
            <h3 className="font-semibold text-sm mb-3">Prerequisites</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                A Meta Business Manager with a verified WhatsApp Business Account (WABA)
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                A registered phone number for your WhatsApp Business
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                For <strong>Coexistence</strong>: the number must currently be active in the
                WhatsApp Business mobile app with good messaging quality
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                The <code className="text-xs bg-muted px-1 rounded">whatsapp_business_messaging</code> &{" "}
                <code className="text-xs bg-muted px-1 rounded">whatsapp_business_management</code> permissions
              </li>
            </ul>
            <a
              href="https://business.facebook.com/settings/whatsapp-business-accounts"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-3 text-xs text-primary hover:underline"
            >
              Open Meta Business Settings <ExternalLink className="w-3 h-3" />
            </a>
          </CardContent>
        </Card>
      )}

      {/* Switch to Coexistence dialog */}
      <AlertDialog open={!!switchTarget} onOpenChange={(o) => !o && setSwitchTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to Coexistence?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  Meta requires a fresh signup to switch modes. Here's what will happen:
                </p>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>This Cloud API connection will be disconnected.</li>
                  <li>Postora's webhook subscription will be removed from your WABA.</li>
                  <li>You'll then click <strong>Connect with Coexistence</strong> to re-onboard.</li>
                  <li>Your mobile WhatsApp Business app will become active again (eligibility permitting).</li>
                </ol>
                <p className="text-muted-foreground">
                  Your existing message history in Postora will not be deleted.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSwitch}>
              Disconnect & continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect WhatsApp dialog */}
      <AlertDialog open={!!disconnectTarget} onOpenChange={(o) => !o && setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  <strong>{disconnectTarget?.platform_username || disconnectTarget?.platform_user_id}</strong>{" "}
                  will stop syncing to Postora.
                </p>
                <p className="text-muted-foreground">
                  Your WhatsApp Business mobile app will continue to work normally. You can
                  reconnect anytime via Coexistence.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDisconnect}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
