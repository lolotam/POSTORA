import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  getAuthenticatedFunctionHeaders,
  readFunctionError,
  PASSWORD_SIGN_IN_MESSAGE,
} from "@/lib/authenticatedFunction";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Key,
  Shield,
  Copy,
  RefreshCw,
  Loader2,
  Check,
  Eye,
  EyeOff,
  Smartphone,
  QrCode,
  Download,
} from "lucide-react";
import { z } from "zod";
import * as QRCode from "qrcode";

interface MfaFactor {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
  created_at: string;
}

export function SecuritySection() {
  const { toast } = useToast();
  const { profile, user } = useAuth();

  // Password management
  type PwStep = "password" | "mfa" | "otp";
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [pwStep, setPwStep] = useState<PwStep>("password");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [pwMfaCode, setPwMfaCode] = useState("");
  const [pwOtpCode, setPwOtpCode] = useState("");
  const [pwOtpSending, setPwOtpSending] = useState(false);
  const [isGoogleUser, setIsGoogleUser] = useState(false);

  // 2FA management
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [isLoadingMfa, setIsLoadingMfa] = useState(true);
  const [isEnrollingMfa, setIsEnrollingMfa] = useState(false);
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null);
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaUri, setMfaUri] = useState<string | null>(null);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [showMfaDialog, setShowMfaDialog] = useState(false);
  const [isUnenrolling, setIsUnenrolling] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [uriCopied, setUriCopied] = useState(false);

  // Backup codes state
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [showBackupCodesDialog, setShowBackupCodesDialog] = useState(false);
  const [hasBackupCodes, setHasBackupCodes] = useState(false);
  const [isGeneratingBackupCodes, setIsGeneratingBackupCodes] = useState(false);
  const [backupCodesCopied, setBackupCodesCopied] = useState(false);

  const checkExistingBackupCodes = useCallback(async () => {
    if (!user) return;

    const {
      data: statusResponse,
      error: statusError,
    } = await supabase.functions.invoke<{ unusedCount?: number }>(
      "manage-backup-codes",
      { body: { action: "status" } },
    );

    setHasBackupCodes(!statusError && (statusResponse?.unusedCount ?? 0) > 0);
  }, [user]);

  // Check if user signed up with Google (no password)
  useEffect(() => {
    const checkAuthProvider = async () => {
      if (user) {
        const { data } = await supabase.auth.getSession();
        const provider = data.session?.user?.app_metadata?.provider;
        setIsGoogleUser(provider === "google");
      }
    };
    checkAuthProvider();
  }, [user]);

  // Load MFA factors on mount
  useEffect(() => {
    loadMfaFactors();
  }, []);

  // Check for existing backup codes on mount
  useEffect(() => {
    void checkExistingBackupCodes();
  }, [checkExistingBackupCodes]);

  const loadMfaFactors = async () => {
    setIsLoadingMfa(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      setMfaFactors(data?.totp || []);
    } catch (error) {
      console.error("Failed to load MFA factors:", error);
    } finally {
      setIsLoadingMfa(false);
    }
  };

  // Password validation schema
  const passwordSchema = z.string().min(8, "Password must be at least 8 characters");

  const resetPwState = () => {
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setPwStep("password");
    setPwMfaCode("");
    setPwOtpCode("");
  };

  const callChangePassword = async (body: { newPassword: string; otp?: string }, explicitToken?: string) => {
    const headers = explicitToken
      ? { Authorization: `Bearer ${explicitToken}` }
      : await getAuthenticatedFunctionHeaders();

    const { data, error } = await supabase.functions.invoke<{
      success?: boolean;
      error?: string;
      code?: string;
    }>("change-password", {
      body,
      headers,
    });
    if (error) {
      const result = await readFunctionError(error);
      if (result.code) return result;
      throw new Error(result.error);
    }
    if (data?.code) return { code: data.code, error: data.error ?? "" };
    if (!data?.success) throw new Error(data?.error ?? "Failed to update password");
    return { success: true as const };
  };

  const handleStartPasswordChange = async () => {
    setPasswordError("");
    const validation = passwordSchema.safeParse(newPassword);
    if (!validation.success) {
      setPasswordError(validation.error.errors[0].message);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }

    setIsChangingPassword(true);
    try {
      // First attempt — if MFA is enrolled the edge function returns
      // mfa_required; if not, otp_required.
      const { data: sessionData } = await supabase.auth.getSession();
      const userToken = sessionData.session?.access_token;
      if (!userToken) {
        throw new Error(PASSWORD_SIGN_IN_MESSAGE);
      }
      const result = await callChangePassword({ newPassword }, userToken);
      if ("success" in result) {
        toast({
          title: isGoogleUser ? "Password created!" : "Password changed!",
          description: isGoogleUser
            ? "You can now sign in with email and password."
            : "Your password has been updated successfully.",
        });
        setPasswordDialogOpen(false);
        resetPwState();
        return;
      }
      if (result.code === "mfa_required") {
        setPwStep("mfa");
      } else if (result.code === "otp_required") {
        // Issue an OTP straight away so the user just enters the code.
        setPwStep("otp");
        setPwOtpSending(true);
        const { data: sessionData } = await supabase.auth.getSession();
        const userToken = sessionData.session?.access_token;
        if (!userToken) {
          throw new Error(PASSWORD_SIGN_IN_MESSAGE);
        }
        const { error: sendError } = await supabase.functions.invoke(
          "send-change-password-otp",
          {
            body: {},
            headers: {
              Authorization: `Bearer ${userToken}`,
            },
          },
        );
        if (sendError) {
          const result = await readFunctionError(sendError);
          if (result.code === "mfa_required") {
            setPwStep("mfa");
          }
          setPasswordError(result.error || "Could not send verification email. Try again shortly.");
        }
        setPwOtpSending(false);
      } else {
        setPasswordError(result.error || "Unable to start password change");
      }
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleConfirmWithMfa = async () => {
    setPasswordError("");
    if (!/^\d{6}$/.test(pwMfaCode.trim())) {
      setPasswordError("Enter the 6-digit code from your authenticator app");
      return;
    }
    setIsChangingPassword(true);
    try {
      // Upgrade the current session to AAL2.
      const verified = mfaFactors.find((f) => f.status === "verified");
      if (!verified) throw new Error("No verified authenticator factor");
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: verified.id,
      });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: verified.id,
        challengeId: challenge.id,
        code: pwMfaCode.trim(),
      });
      if (verifyError) throw verifyError;

      const { data: refreshedSession } = await supabase.auth.getSession();
      const aal2Token = refreshedSession.session?.access_token;
      if (!aal2Token) {
        throw new Error("Could not retrieve upgraded session token after MFA verification.");
      }

      const result = await callChangePassword({ newPassword }, aal2Token);
      if ("success" in result) {
        toast({ title: "Password changed!", description: "Your password has been updated." });
        setPasswordDialogOpen(false);
        resetPwState();
      } else {
        setPasswordError(result.error || "Failed to update password");
      }
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleConfirmWithOtp = async () => {
    setPasswordError("");
    if (!/^\d{6}$/.test(pwOtpCode.trim())) {
      setPasswordError("Enter the 6-digit code from the email we just sent");
      return;
    }
    setIsChangingPassword(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userToken = sessionData.session?.access_token;
      if (!userToken) {
        throw new Error(PASSWORD_SIGN_IN_MESSAGE);
      }
      const result = await callChangePassword({ newPassword, otp: pwOtpCode.trim() }, userToken);
      if ("success" in result) {
        toast({
          title: isGoogleUser ? "Password created!" : "Password changed!",
          description: isGoogleUser
            ? "You can now sign in with email and password."
            : "Your password has been updated successfully.",
        });
        setPasswordDialogOpen(false);
        resetPwState();
      } else {
        setPasswordError(result.error || "Invalid verification code");
      }
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleStartMfaEnrollment = async () => {
    setIsEnrollingMfa(true);
    try {
      const { data: existingFactors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;

      const verified = existingFactors?.totp?.find((f) => f.status === "verified");
      if (verified) {
        toast({
          title: "2FA already enabled",
          description: "Two-factor authentication is already active on your account.",
        });
        return;
      }

      // Try to clean up any unverified factors
      if (existingFactors?.totp) {
        for (const factor of existingFactors.totp) {
          if (factor.status !== "verified") {
            const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
            if (unenrollError) {
              console.warn("Could not unenroll existing factor:", unenrollError.message);
            }
          }
        }
      }

      const suffixBytes = new Uint8Array(2);
      crypto.getRandomValues(suffixBytes);
      const suffix = Array.from(suffixBytes, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("").toUpperCase();
      const friendlyName = `Authenticator App (${suffix})`;

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName,
      });

      if (error) throw error;

      setMfaFactorId(data.id);
      setMfaSecret(data.totp.secret);
      setMfaUri(data.totp.uri);

      const userEmail = profile?.email || user?.email || "user";
      const simplifiedUri = `otpauth://totp/Postora:${encodeURIComponent(userEmail)}?secret=${data.totp.secret}&issuer=Postora`;

      try {
        const qrDataUrl = await QRCode.toDataURL(simplifiedUri, {
          width: 400,
          margin: 4,
          errorCorrectionLevel: "M",
          color: { dark: "#000000", light: "#ffffff" },
        });
        setMfaQrCode(qrDataUrl);
      } catch {
        setMfaQrCode(data.totp.qr_code);
      }

      setShowMfaDialog(true);
    } catch (error) {
      console.error("MFA enrollment error:", error);
      toast({
        title: "Failed to start 2FA setup",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsEnrollingMfa(false);
    }
  };

  const handleVerifyMfa = async () => {
    if (!mfaFactorId || !verifyCode.trim()) return;

    setIsVerifying(true);
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      });

      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: challengeData.id,
        code: verifyCode.trim(),
      });

      if (verifyError) throw verifyError;

      toast({
        title: "2FA enabled!",
        description: "Two-factor authentication is now active on your account.",
      });

      setShowMfaDialog(false);
      resetMfaState();
      await loadMfaFactors();
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

  const handleUnenrollMfa = async (factorId: string) => {
    setIsUnenrolling(factorId);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });

      if (error) throw error;

      toast({
        title: "2FA disabled",
        description: "Two-factor authentication has been removed from your account.",
      });

      await loadMfaFactors();
    } catch (error) {
      console.error("MFA unenroll error:", error);
      toast({
        title: "Failed to disable 2FA",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsUnenrolling(null);
    }
  };

  const resetMfaState = () => {
    setMfaQrCode(null);
    setMfaSecret(null);
    setMfaUri(null);
    setMfaFactorId(null);
    setVerifyCode("");
    setSecretCopied(false);
    setUriCopied(false);
  };

  const handleCopySecret = async () => {
    if (!mfaSecret) return;
    try {
      await navigator.clipboard.writeText(mfaSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
      toast({
        title: "Secret key copied",
        description: "Paste it into your authenticator app.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Please copy the secret manually.",
        variant: "destructive",
      });
    }
  };

  const handleCopySetupUri = async () => {
    if (!mfaUri) return;
    try {
      await navigator.clipboard.writeText(mfaUri);
      setUriCopied(true);
      setTimeout(() => setUriCopied(false), 2000);
      toast({
        title: "Setup URI copied",
        description: "Paste it into an authenticator app that supports URI import.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadQr = async () => {
    if (!mfaUri) return;
    try {
      const highResQr = await QRCode.toDataURL(mfaUri, {
        width: 1024,
        margin: 6,
        errorCorrectionLevel: "H",
        color: { dark: "#000000", light: "#ffffff" },
      });

      const link = document.createElement("a");
      link.download = "postora-2fa-qr.png";
      link.href = highResQr;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast({
        title: "QR Code downloaded",
        description: "Open the image on another device to scan it easily.",
      });
    } catch {
      toast({
        title: "Download failed",
        description: "Could not download QR code.",
        variant: "destructive",
      });
    }
  };

  // Backup codes functions
  // Cryptographically secure backup code generator.
  // Charset length is 32 (a power of two), so masking each random byte with 0x1F
  // maps uniformly to an index with zero modulo bias.
  const generateBackupCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const length = 8;
    const randomBytes = new Uint8Array(length);
    crypto.getRandomValues(randomBytes);
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(randomBytes[i] & 0x1f);
    }
    return code;
  };

  const handleGenerateBackupCodes = async () => {
    if (!user) return;
    setIsGeneratingBackupCodes(true);
    setBackupCodes([]);
    setBackupCodesCopied(false);

    try {
      const uniqueCodes = new Set<string>();
      while (uniqueCodes.size < 10) {
        uniqueCodes.add(generateBackupCode());
      }
      const codes = Array.from(uniqueCodes);

      const { data: storeResponse, error: storeError } = await supabase.functions.invoke<{
        success?: boolean;
        count?: number;
      }>("manage-backup-codes", {
        body: { action: "store", codes },
      });

      if (storeError || !storeResponse?.success || storeResponse.count !== 10) {
        throw new Error("Backup code persistence failed");
      }

      setBackupCodes(codes);
      setHasBackupCodes(true);
      setShowBackupCodesDialog(true);

      toast({
        title: "Backup codes generated",
        description: "Save these codes in a safe place. They won't be shown again.",
      });
    } catch {
      await checkExistingBackupCodes();
      toast({
        title: "Failed to generate backup codes",
        description: "Could not securely save backup codes. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingBackupCodes(false);
    }
  };

  const handleCopyBackupCodes = async () => {
    const codesText = backupCodes.join('\n');
    try {
      await navigator.clipboard.writeText(codesText);
      setBackupCodesCopied(true);
      setTimeout(() => setBackupCodesCopied(false), 2000);
      toast({
        title: "Backup codes copied",
        description: "Store them in a secure location.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Please copy the codes manually.",
        variant: "destructive",
      });
    }
  };

  const handleDownloadBackupCodes = () => {
    const codesText = `Postora 2FA Backup Codes\n${"=".repeat(30)}\n\nGenerated: ${new Date().toLocaleString()}\n\nSave these codes in a secure location.\nEach code can only be used once.\n\n${backupCodes.map((code, i) => `${i + 1}. ${code}`).join('\n')}\n\nIf you lose access to your authenticator app,\nuse one of these codes to sign in.`;

    const blob = new Blob([codesText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'postora-backup-codes.txt';
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast({
      title: "Backup codes downloaded",
      description: "Store the file in a secure location.",
    });
  };

  const handleBackupCodesDialogOpenChange = (open: boolean) => {
    setShowBackupCodesDialog(open);
    if (!open) {
      setBackupCodes([]);
      setBackupCodesCopied(false);
    }
  };

  return (
    <>
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Security</h2>
            <p className="text-sm text-muted-foreground">
              Manage your account security
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Password Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">
                  {isGoogleUser ? "Create Password" : "Change Password"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {isGoogleUser
                    ? "Add a password to sign in with email"
                    : "Update your account password"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPasswordDialogOpen(true)}
              >
                <Key className="w-4 h-4 mr-2" />
                {isGoogleUser ? "Create" : "Change"}
              </Button>
            </div>
          </div>

          <Separator />

          {/* 2FA Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Two-Factor Authentication (2FA)</p>
                <p className="text-xs text-muted-foreground">
                  Secure your account with an authenticator app
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMfaFactors}
                  disabled={isLoadingMfa}
                >
                  <RefreshCw className={`w-4 h-4 ${isLoadingMfa ? 'animate-spin' : ''}`} />
                </Button>
                <Button onClick={handleStartMfaEnrollment} disabled={isEnrollingMfa} size="sm">
                  {isEnrollingMfa ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Setting up...
                    </>
                  ) : mfaFactors.some(f => f.status === 'verified') ? (
                    <>
                      <Smartphone className="w-4 h-4 mr-2" />
                      Add authenticator
                    </>
                  ) : (
                    <>
                      <Smartphone className="w-4 h-4 mr-2" />
                      Enable 2FA
                    </>
                  )}
                </Button>
              </div>
            </div>

            {isLoadingMfa ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : mfaFactors.length > 0 ? (
              <div className="space-y-3">
                {mfaFactors.some(f => f.status === 'verified') && (
                  <div className="flex items-center gap-2 text-sm text-emerald-500">
                    <Check className="w-4 h-4" />
                    <span>Two-factor authentication is enabled</span>
                  </div>
                )}

                {mfaFactors.map((factor) => (
                  <div
                    key={factor.id}
                    className={`flex items-center justify-between p-4 rounded-lg border ${factor.status === 'verified'
                      ? 'bg-secondary/50 border-border'
                      : 'bg-amber-500/5 border-amber-500/20'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Smartphone className="w-5 h-5 text-muted-foreground" />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">
                            {factor.friendly_name || "Authenticator App"}
                          </p>
                          {factor.status === 'verified' ? (
                            <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                              Verified
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">
                              Unverified
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Added {new Date(factor.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleUnenrollMfa(factor.id)}
                      disabled={isUnenrolling === factor.id}
                    >
                      {isUnenrolling === factor.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        "Remove"
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">
                No authenticator apps connected. Enable 2FA to add an extra layer of security.
              </p>
            )}
          </div>

          <Separator />

          {/* Backup Codes Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Backup Codes</p>
                <p className="text-xs text-muted-foreground">
                  Use these codes if you lose access to your authenticator
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateBackupCodes}
                disabled={isGeneratingBackupCodes}
              >
                {isGeneratingBackupCodes ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : hasBackupCodes ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Regenerate
                  </>
                ) : (
                  <>
                    <Key className="w-4 h-4 mr-2" />
                    Generate Codes
                  </>
                )}
              </Button>
            </div>
            {hasBackupCodes && (
              <p className="text-xs text-emerald-500">
                ✓ Backup codes have been generated
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Password Dialog */}
      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) resetPwState();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pwStep === "password"
                ? isGoogleUser
                  ? "Create Password"
                  : "Change Password"
                : pwStep === "mfa"
                ? "Confirm with your authenticator"
                : "Confirm with email code"}
            </DialogTitle>
            <DialogDescription>
              {pwStep === "password"
                ? isGoogleUser
                  ? "Create a password to sign in with your email address."
                  : "Enter a new password for your account."
                : pwStep === "mfa"
                ? "Enter the 6-digit code from your authenticator app to confirm this change."
                : pwOtpSending
                ? "Sending a verification code to your email…"
                : "Enter the 6-digit code we just emailed to confirm this change."}
            </DialogDescription>
          </DialogHeader>

          {pwStep === "password" && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    className="pr-10"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                />
              </div>

              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
            </div>
          )}

          {pwStep === "mfa" && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="pwMfaCode">Authenticator code</Label>
                <Input
                  id="pwMfaCode"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={pwMfaCode}
                  onChange={(e) => setPwMfaCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
              </div>
              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
            </div>
          )}

          {pwStep === "otp" && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="pwOtpCode">Email verification code</Label>
                <Input
                  id="pwOtpCode"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={pwOtpCode}
                  onChange={(e) => setPwOtpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  disabled={pwOtpSending}
                />
              </div>
              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPasswordDialogOpen(false);
                resetPwState();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={
                pwStep === "password"
                  ? handleStartPasswordChange
                  : pwStep === "mfa"
                  ? handleConfirmWithMfa
                  : handleConfirmWithOtp
              }
              disabled={isChangingPassword || pwOtpSending}
            >
              {isChangingPassword ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : pwStep === "password" ? (
                isGoogleUser ? "Create Password" : "Continue"
              ) : (
                "Confirm"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* 2FA Setup Dialog */}
      <Dialog
        open={showMfaDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowMfaDialog(false);
            resetMfaState();
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="w-5 h-5 text-primary" />
              Set Up Two-Factor Authentication
            </DialogTitle>
            <DialogDescription>
              Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 pt-4">
            {mfaQrCode && (
              <div className="flex flex-col items-center gap-3">
                <div className="p-8 bg-white rounded-2xl shadow-lg border border-gray-200">
                  <img
                    src={mfaQrCode}
                    alt="2FA QR Code"
                    width={300}
                    height={300}
                    className="w-[300px] h-[300px] object-contain"
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center max-w-[300px]">
                  Point your authenticator app camera at this QR code
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadQr}
                  className="gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download QR (1024px PNG)
                </Button>
              </div>
            )}

            {mfaSecret && (
              <div className="space-y-3">
                <Label className="text-xs text-muted-foreground">
                  Can't scan? Enter this code manually:
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 p-3 bg-secondary rounded-lg font-mono text-sm text-center break-all select-all">
                    {mfaSecret}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopySecret}
                    className="shrink-0"
                    aria-label="Copy secret key"
                  >
                    {secretCopied ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>

                {mfaUri && (
                  <div className="flex items-center justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCopySetupUri}
                    >
                      {uriCopied ? (
                        <>
                          <Check className="w-4 h-4 mr-2 text-emerald-500" />
                          Copied URI
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4 mr-2" />
                          Copy setup URI
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="verifyCode">Enter verification code</Label>
              <Input
                id="verifyCode"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="text-center text-2xl tracking-widest font-mono"
              />
              <p className="text-xs text-muted-foreground text-center">
                Enter the 6-digit code from your authenticator app
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setShowMfaDialog(false);
                  resetMfaState();
                }}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleVerifyMfa}
                disabled={isVerifying || verifyCode.length !== 6}
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
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

      {/* Backup Codes Dialog */}
      <Dialog
        open={showBackupCodesDialog}
        onOpenChange={handleBackupCodesDialogOpenChange}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              Your Backup Codes
            </DialogTitle>
            <DialogDescription>
              Save these codes in a secure location. Each code can only be used once.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4">
              <p className="text-sm text-amber-600 font-medium">
                ⚠️ These codes will only be shown once
              </p>
              <p className="text-xs text-amber-600/80 mt-1">
                Copy or download them now. If you lose these codes and your authenticator, you'll need to contact support.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 p-4 bg-secondary/50 rounded-lg font-mono text-sm">
              {backupCodes.map((code, index) => (
                <div key={index} className="flex items-center gap-2 py-1">
                  <span className="text-muted-foreground text-xs w-4">{index + 1}.</span>
                  <span className="select-all">{code}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleCopyBackupCodes}
              >
                {backupCodesCopied ? (
                  <>
                    <Check className="w-4 h-4 mr-2 text-emerald-500" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 mr-2" />
                    Copy All
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleDownloadBackupCodes}
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => handleBackupCodesDialogOpenChange(false)}>
              I've saved my codes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
