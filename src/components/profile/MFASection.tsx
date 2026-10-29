import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { DisableMfaDialog, useDisableMfa } from "@/features/mfa";
import {
  Shield,
  Smartphone,
  QrCode,
  X,
  Loader2,
  Check,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface MfaFactor {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
  created_at: string;
}

export function MFASection() {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadFactors();
  }, []);

  const loadFactors = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      setFactors(data?.totp || []);
    } catch (error) {
      console.error("Failed to load MFA factors:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartEnrollment = async () => {
    setIsEnrolling(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Authenticator App",
      });

      if (error) throw error;

      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setShowDialog(true);
    } catch (error) {
      console.error("MFA enrollment error:", error);
      toast({
        title: "Failed to start 2FA setup",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleVerify = async () => {
    if (!factorId || !verifyCode.trim()) return;

    setIsVerifying(true);
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });

      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code: verifyCode.trim(),
      });

      if (verifyError) throw verifyError;

      toast({
        title: "2FA enabled!",
        description: "Two-factor authentication is now active on your account.",
      });

      setShowDialog(false);
      resetState();
      await loadFactors();
    } catch (error) {
      console.error("MFA verification error:", error);
      toast({
        title: "Verification failed",
        description: error instanceof Error ? error.message : "Invalid code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const disableMfa = useDisableMfa({
    onDisabled: async () => {
      toast({
        title: "2FA disabled",
        description: "Two-factor authentication has been removed from your account.",
      });
      await loadFactors();
    },
    onError: (message) => {
      console.error("MFA unenroll error:", message);
      toast({
        title: "Failed to disable 2FA",
        description: message || "An error occurred",
        variant: "destructive",
      });
    },
  });

  // Supabase removes a verified factor only from an AAL2 session; the hook asks for a code when needed.
  const handleUnenroll = (id: string) => disableMfa.requestDisable(id);

  const resetState = () => {
    setQrCode(null);
    setSecret(null);
    setFactorId(null);
    setVerifyCode("");
  };

  const verifiedFactors = factors.filter((f) => f.status === "verified");
  const hasVerifiedFactor = verifiedFactors.length > 0;

  return (
    <>
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Two-Factor Authentication</h2>
            <p className="text-sm text-muted-foreground">
              Add an extra layer of security to your account
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        ) : hasVerifiedFactor ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-emerald-500">
              <Check className="w-5 h-5" />
              <span className="font-medium">2FA is enabled</span>
            </div>
            {verifiedFactors.map((factor) => (
              <div
                key={factor.id}
                className="flex items-center justify-between p-3 rounded-lg bg-secondary/50"
              >
                <div className="flex items-center gap-3">
                  <Smartphone className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{factor.friendly_name || "Authenticator App"}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(factor.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleUnenroll(factor.id)}
                  disabled={disableMfa.busyFactorId === factor.id}
                  className="text-destructive hover:text-destructive"
                >
                  {disableMfa.busyFactorId === factor.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <X className="w-4 h-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Protect your account by requiring a verification code from your phone in addition to your password.
            </p>
            <Button onClick={handleStartEnrollment} disabled={isEnrolling}>
              {isEnrolling ? (
                <>
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  Setting up...
                </>
              ) : (
                <>
                  <QrCode className="w-4 h-4 me-2" />
                  Set up 2FA
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {/* MFA Setup Dialog */}
      <Dialog open={showDialog} onOpenChange={(open) => {
        if (!open) {
          resetState();
        }
        setShowDialog(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set up Two-Factor Authentication</DialogTitle>
            <DialogDescription>
              Scan this QR code with your authenticator app, then enter the verification code.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 pt-4">
            {qrCode && (
              <div className="flex flex-col items-center gap-4">
                <div className="p-4 bg-white rounded-lg">
                  <img src={qrCode} alt="2FA QR Code" className="w-48 h-48" />
                </div>
                {secret && (
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">
                      Or enter this code manually:
                    </p>
                    <code className="text-sm font-mono bg-secondary px-2 py-1 rounded">
                      {secret}
                    </code>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Verification Code</label>
              <Input
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="Enter 6-digit code"
                className="text-center text-lg tracking-widest"
                maxLength={6}
              />
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setShowDialog(false);
                  resetState();
                }}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleVerify}
                disabled={isVerifying || verifyCode.length !== 6}
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify & Enable"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <DisableMfaDialog
        open={disableMfa.pendingFactorId !== null}
        submitting={disableMfa.submitting}
        codeError={disableMfa.codeError}
        onSubmit={(code) => { void disableMfa.submitCode(code, "Invalid code. Please try again."); }}
        onCancel={disableMfa.cancel}
      />
    </>
  );
}
