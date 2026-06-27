import { useState } from "react";
import { ArrowLeft, Key, Loader2, Mail } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface PasswordResetOptionsProps {
  onBack: () => void;
  onSuccess?: () => void;
}

type ResetView = "email-input" | "verify" | "done";

export function PasswordResetOptions({ onBack, onSuccess }: PasswordResetOptionsProps) {
  const [view, setView] = useState<ResetView>("email-input");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const send = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase.functions.invoke("send-reset-otp", {
        body: { email: email.trim().toLowerCase() },
      });
      if (error) throw error;
      setView("verify");
    } catch {
      toast({
        title: "Error",
        description: "Failed to send reset code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    if (!email || !z.string().email().safeParse(email).success) {
      setErrors({ email: "Please enter a valid email address" });
      return;
    }
    await send();
  };

  const verify = async () => {
    setErrors({});
    if (!/^\d{6}$/.test(otp.trim())) {
      setErrors({ otp: "Enter the 6-digit code from your email" });
      return;
    }
    if (newPassword.length < 8) {
      setErrors({ newPassword: "Password must be at least 8 characters" });
      return;
    }
    if (needsMfa && !/^\d{6}$/.test(mfaCode.trim())) {
      setErrors({ mfaCode: "Enter the 6-digit code from your authenticator app" });
      return;
    }
    setIsLoading(true);
    try {
      const body: Record<string, string> = {
        email: email.trim().toLowerCase(),
        otp: otp.trim(),
        newPassword,
      };
      if (needsMfa) body.mfaCode = mfaCode.trim();
      const { data, error } = await supabase.functions.invoke<{
        success?: boolean;
        error?: string;
        code?: string;
      }>("verify-reset-otp", { body });

      if (error) {
        const ctx = (error as { context?: { response?: Response } }).context;
        const payload = ctx?.response ? await ctx.response.json().catch(() => null) : null;
        if (payload?.code === "mfa_required") {
          setNeedsMfa(true);
          setErrors({ mfaCode: "Enter your authenticator code" });
          return;
        }
        setErrors({ otp: payload?.error ?? error.message });
        return;
      }
      if (data?.code === "mfa_required") {
        setNeedsMfa(true);
        setErrors({ mfaCode: "Enter your authenticator code" });
        return;
      }
      if (!data?.success) {
        setErrors({ otp: data?.error ?? "Could not reset password" });
        return;
      }
      setView("done");
      onSuccess?.();
    } catch (err) {
      setErrors({ otp: err instanceof Error ? err.message : "Could not reset password" });
    } finally {
      setIsLoading(false);
    }
  };

  if (view === "email-input") {
    return (
      <form onSubmit={handleSubmitEmail} className="space-y-5">
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
            <Key className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Reset your password</h2>
          <p className="text-muted-foreground">
            Enter your email and we'll send a reset code
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reset-email">Email</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              id="reset-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={isLoading}
              className={`pl-10 ${errors.email ? "border-destructive" : ""}`}
            />
          </div>
          {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
        </div>

        <Button type="submit" variant="gradient" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Sending...
            </>
          ) : (
            "Send reset code"
          )}
        </Button>

        <div className="text-center">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to sign in
          </button>
        </div>
      </form>
    );
  }

  if (view === "verify") {
    return (
      <div className="space-y-5">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
            <Mail className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Check your email</h2>
          <p className="text-muted-foreground text-sm">
            If an account exists for <strong>{email}</strong>, a 6-digit code is on its way.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reset-otp">Reset code</Label>
          <Input
            id="reset-otp"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            autoComplete="one-time-code"
            className={errors.otp ? "border-destructive" : ""}
          />
          {errors.otp && <p className="text-xs text-destructive">{errors.otp}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="reset-newpw">New password</Label>
          <Input
            id="reset-newpw"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            className={errors.newPassword ? "border-destructive" : ""}
          />
          {errors.newPassword && (
            <p className="text-xs text-destructive">{errors.newPassword}</p>
          )}
        </div>

        {needsMfa && (
          <div className="space-y-2">
            <Label htmlFor="reset-mfa">Authenticator code</Label>
            <Input
              id="reset-mfa"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              autoComplete="one-time-code"
              className={errors.mfaCode ? "border-destructive" : ""}
            />
            {errors.mfaCode && (
              <p className="text-xs text-destructive">{errors.mfaCode}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Two-factor authentication is enabled on this account.
            </p>
          </div>
        )}

        <Button onClick={verify} variant="gradient" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Verifying...
            </>
          ) : (
            "Reset password"
          )}
        </Button>

        <div className="text-center">
          <button
            type="button"
            onClick={send}
            disabled={isLoading}
            className="text-sm text-primary hover:underline"
          >
            Resend code
          </button>
        </div>
        <div className="text-center">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-center">
      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 flex items-center justify-center">
        <Mail className="w-8 h-8 text-green-500" />
      </div>
      <h2 className="text-2xl font-bold">Password reset</h2>
      <p className="text-muted-foreground text-sm">
        Your password has been updated. Sign in with the new password to continue.
      </p>
      <Button onClick={onBack} variant="outline" className="w-full">
        Back to sign in
      </Button>
    </div>
  );
}
