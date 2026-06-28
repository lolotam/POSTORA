import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  getAuthenticatedFunctionHeaders,
  readFunctionError,
  PASSWORD_SIGN_IN_MESSAGE,
} from "@/lib/authenticatedFunction";
import { Lock, Eye, EyeOff, Loader2 } from "lucide-react";

interface PasswordSectionProps {
  userEmail: string | undefined;
}

type Step = "password" | "mfa" | "otp";

export function PasswordSection({ userEmail }: PasswordSectionProps) {
  const [step, setStep] = useState<Step>("password");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const { toast } = useToast();

  const reset = () => {
    setStep("password");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setMfaCode("");
    setOtpCode("");
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

  const startChange = async () => {
    if (!newPassword || !confirmPassword) {
      toast({ title: "Missing fields", description: "Please fill in all password fields.", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", description: "New password and confirmation must match.", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "Password too short", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }

    setIsBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userToken = sessionData.session?.access_token;
      if (!userToken) {
        throw new Error(PASSWORD_SIGN_IN_MESSAGE);
      }
      const result = await callChangePassword({ newPassword }, userToken);
      if ("success" in result) {
        toast({ title: "Password updated!", description: "Your password has been changed successfully." });
        reset();
        return;
      }
      if (result.code === "mfa_required") {
        setStep("mfa");
      } else if (result.code === "otp_required") {
        setStep("otp");
        const { data: sessionData } = await supabase.auth.getSession();
        const userToken = sessionData.session?.access_token;
        if (!userToken) {
          throw new Error(PASSWORD_SIGN_IN_MESSAGE);
        }
        const { error: sendError } = await supabase.functions.invoke("send-change-password-otp", {
          body: {},
          headers: {
            Authorization: `Bearer ${userToken}`,
          },
        });
        if (sendError) {
          const result = await readFunctionError(sendError);
          if (result.code === "mfa_required") {
            setStep("mfa");
          }
          toast({
            title: "Could not send verification email",
            description: result.error || "Try again in a moment.",
            variant: "destructive",
          });
        }
      } else {
        toast({ title: "Failed to change password", description: result.error || "Unknown error", variant: "destructive" });
      }
    } catch (err) {
      toast({
        title: "Failed to change password",
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const confirmMfa = async () => {
    if (!/^\d{6}$/.test(mfaCode.trim())) {
      toast({ title: "Invalid code", description: "Enter the 6-digit code from your authenticator app.", variant: "destructive" });
      return;
    }
    setIsBusy(true);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const verified = factors?.totp?.find((f) => f.status === "verified");
      if (!verified) throw new Error("No verified authenticator factor");

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: verified.id });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: verified.id,
        challengeId: challenge.id,
        code: mfaCode.trim(),
      });
      if (verifyError) throw verifyError;

      const { data: refreshedSession } = await supabase.auth.getSession();
      const aal2Token = refreshedSession.session?.access_token;
      if (!aal2Token) {
        throw new Error("Could not retrieve upgraded session token after MFA verification.");
      }

      const result = await callChangePassword({ newPassword }, aal2Token);
      if ("success" in result) {
        toast({ title: "Password updated!", description: "Your password has been changed successfully." });
        reset();
      } else {
        toast({ title: "Failed to change password", description: result.error || "Unknown error", variant: "destructive" });
      }
    } catch (err) {
      toast({
        title: "Verification failed",
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const confirmOtp = async () => {
    if (!/^\d{6}$/.test(otpCode.trim())) {
      toast({ title: "Invalid code", description: "Enter the 6-digit code from the email we sent.", variant: "destructive" });
      return;
    }
    setIsBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userToken = sessionData.session?.access_token;
      if (!userToken) {
        throw new Error(PASSWORD_SIGN_IN_MESSAGE);
      }
      const result = await callChangePassword({ newPassword, otp: otpCode.trim() }, userToken);
      if ("success" in result) {
        toast({ title: "Password updated!", description: "Your password has been changed successfully." });
        reset();
      } else {
        toast({ title: "Invalid code", description: result.error || "Could not verify code", variant: "destructive" });
      }
    } catch (err) {
      toast({
        title: "Failed to change password",
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSendPasswordReset = async () => {
    if (!userEmail) {
      toast({ title: "No email found", description: "Cannot send reset email without a valid email address.", variant: "destructive" });
      return;
    }

    try {
      const { error } = await supabase.functions.invoke("send-reset-otp", { body: { email: userEmail } });
      if (error) throw error;
      toast({ title: "Reset code sent", description: "If an account exists with this email, a reset code has been sent." });
    } catch (err) {
      toast({
        title: "Failed to send reset email",
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Lock className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">Change Password</h2>
          <p className="text-sm text-muted-foreground">
            Update your password to keep your account secure
          </p>
        </div>
      </div>

      {step === "password" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <div className="relative">
              <Input
                id="current-password"
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password (optional)"
                className="pr-10"
                autoComplete="current-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              >
                {showCurrentPassword ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <div className="relative">
              <Input
                id="new-password"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                className="pr-10"
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowNewPassword(!showNewPassword)}
              >
                {showNewPassword ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm New Password</Label>
            <div className="relative">
              <Input
                id="confirm-password"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                className="pr-10"
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              >
                {showConfirmPassword ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button onClick={startChange} disabled={isBusy}>
              {isBusy ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Password"
              )}
            </Button>
            <Button variant="outline" onClick={handleSendPasswordReset}>
              Send Reset Email
            </Button>
          </div>
        </div>
      )}

      {step === "mfa" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app to confirm this change.
          </p>
          <div className="space-y-2">
            <Label htmlFor="mfa-code">Authenticator code</Label>
            <Input
              id="mfa-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              autoComplete="one-time-code"
            />
          </div>
          <div className="flex gap-3">
            <Button onClick={confirmMfa} disabled={isBusy}>
              {isBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Confirm
            </Button>
            <Button variant="outline" onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}

      {step === "otp" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to your email. Enter it to confirm this change.
          </p>
          <div className="space-y-2">
            <Label htmlFor="otp-code">Email verification code</Label>
            <Input
              id="otp-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              autoComplete="one-time-code"
            />
          </div>
          <div className="flex gap-3">
            <Button onClick={confirmOtp} disabled={isBusy}>
              {isBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Confirm
            </Button>
            <Button variant="outline" onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
