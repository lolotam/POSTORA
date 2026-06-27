import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Loader2, Mail } from "lucide-react";
import { z } from "zod";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type ResetView = "email" | "verify" | "success";

export default function ResetPassword() {
  const [view, setView] = useState<ResetView>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const { toast } = useToast();

  const sendReset = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase.functions.invoke("send-reset-otp", {
        body: { email: email.trim().toLowerCase() },
      });
      if (error) throw error;
      // Generic response — backend always returns success even if account doesn't exist.
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

  const verifyAndReset = async () => {
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
      setView("success");
    } catch (err) {
      setErrors({ otp: err instanceof Error ? err.message : "Could not reset password" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrors({});
    if (!z.string().email().safeParse(email).success) {
      setErrors({ email: "Please enter a valid email address" });
      return;
    }
    await sendReset();
  };

  return (
    <div className="min-h-screen bg-background flex relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-0 w-96 h-96 bg-primary/10 rounded-full blur-[128px]" />
        <div className="absolute bottom-1/4 right-0 w-80 h-80 bg-accent/10 rounded-full blur-[128px]" />
      </div>

      <div className="hidden lg:flex flex-1 flex-col justify-between p-12 relative">
        <Link to="/auth" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to sign in
        </Link>

        <div className="max-w-md">
          <Logo size="lg" className="mb-8" />
          <h1 className="text-4xl font-bold mb-4">Reset your password</h1>
          <p className="text-muted-foreground text-lg">
            We'll email you a 6-digit code to confirm it's you.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">Secure password reset</p>
      </div>

      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative z-10">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 text-center">
            <Link to="/">
              <Logo size="lg" className="justify-center" />
            </Link>
          </div>

          <div className="bg-card/50 backdrop-blur-xl border border-border rounded-2xl p-8">
            {view === "email" && (
              <>
                <div className="text-center mb-8">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <Mail className="w-8 h-8 text-primary" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Forgot password?</h2>
                  <p className="text-muted-foreground">
                    Enter your email and we'll send a reset code
                  </p>
                </div>

                <form onSubmit={handleEmailSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email address</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                      disabled={isLoading}
                      className={errors.email ? "border-destructive" : ""}
                    />
                    {errors.email && (
                      <p className="text-xs text-destructive">{errors.email}</p>
                    )}
                  </div>

                  <Button type="submit" variant="gradient" className="w-full" size="lg" disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      "Send reset code"
                    )}
                  </Button>

                  <div className="text-center">
                    <Link to="/auth" className="text-sm text-primary hover:underline">
                      Back to sign in
                    </Link>
                  </div>
                </form>
              </>
            )}

            {view === "verify" && (
              <>
                <div className="text-center mb-6">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <Mail className="w-8 h-8 text-primary" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Check your email</h2>
                  <p className="text-muted-foreground text-sm">
                    If an account exists for <strong>{email}</strong>, a 6-digit code is on its way.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="otp">Reset code</Label>
                    <Input
                      id="otp"
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
                    <Label htmlFor="newPassword">New password</Label>
                    <Input
                      id="newPassword"
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
                      <Label htmlFor="mfaCode">Authenticator code</Label>
                      <Input
                        id="mfaCode"
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

                  <Button
                    variant="gradient"
                    className="w-full"
                    size="lg"
                    onClick={verifyAndReset}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      "Reset password"
                    )}
                  </Button>

                  <p className="text-center text-sm text-muted-foreground">
                    Didn't receive the email?{" "}
                    <button
                      onClick={sendReset}
                      className="text-primary hover:underline"
                      disabled={isLoading}
                    >
                      Resend code
                    </button>
                  </p>
                </div>
              </>
            )}

            {view === "success" && (
              <>
                <div className="text-center mb-8">
                  <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                    <Check className="w-8 h-8 text-green-500" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Password reset!</h2>
                  <p className="text-muted-foreground">
                    Your password has been updated successfully.
                  </p>
                </div>

                <Button
                  variant="gradient"
                  className="w-full"
                  size="lg"
                  onClick={() => navigate("/auth")}
                >
                  Sign in with new password
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
