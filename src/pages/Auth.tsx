import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { CookieConsent } from "@/components/CookieConsent";
import { OTPVerification, PasswordResetOptions } from "@/components/auth";
import { Eye, EyeOff, ArrowLeft, Loader2, Mail, Shield } from "lucide-react";
import { z } from "zod";

const authSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  fullName: z.string().optional(),
});

type AuthView = "login" | "signup" | "forgot-password" | "reset-password" | "mfa-verify" | "otp-verify";

export default function Auth() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<AuthView>(
    searchParams.get("mode") === "signup" ? "signup" : "login"
  );
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirmPassword?: string; mfaCode?: string }>({});
  const [linkExpired, setLinkExpired] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { signUp, signIn, signInWithGoogle, user, isLoading: authLoading } = useAuth();

  // Add noindex meta tag for auth pages
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex, nofollow");
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Store referral code if present
  useEffect(() => {
    const refCode = searchParams.get("ref");
    if (refCode) {
      localStorage.setItem("referral_code", refCode);
    }
  }, [searchParams]);

  useEffect(() => {
    const mode = searchParams.get("mode");
    const errorCode = searchParams.get("error_code");
    const error = searchParams.get("error");
    
    // Check if the reset link has expired
    if (errorCode === "otp_expired" || error === "access_denied") {
      setLinkExpired(true);
      setView("forgot-password");
      toast({
        title: "Link expired",
        description: "Your password reset link has expired. Please request a new one.",
        variant: "destructive",
      });
    } else if (mode === "signup") {
      setView("signup");
    } else if (mode === "forgot-password") {
      setView("forgot-password");
    } else if (mode === "reset-password") {
      setView("reset-password");
    } else {
      setView("login");
    }
  }, [searchParams, toast]);

  // Redirect if already logged in (except for reset-password)
  useEffect(() => {
    if (user && view !== "reset-password") {
      // Check for pending OAuth consent redirect
      const oauthRedirect = sessionStorage.getItem("oauth_redirect_after_login");
      if (oauthRedirect) {
        sessionStorage.removeItem("oauth_redirect_after_login");
        window.location.href = oauthRedirect;
        return;
      }

      // If there's a pending OAuth flow, redirect to /profiles instead of dashboard
      const pendingIg = searchParams.get("code") && searchParams.get("state");
      const pendingFb = localStorage.getItem("fb_oauth_profile_id");
      if (pendingIg || pendingFb) {
        navigate("/profiles" + window.location.search, { replace: true });
      } else {
        setIsRedirecting(true);
        // Check if user has a subscription — if not, send to pricing
        const checkSubscription = async () => {
          try {
            const { data: sub } = await supabase
              .from("user_subscriptions")
              .select("id")
              .eq("user_id", user.id)
              .eq("status", "active")
              .maybeSingle();

            if (sub) {
              navigate("/dashboard", { replace: true });
            } else {
              navigate("/pricing", { replace: true });
            }
          } catch {
            navigate("/dashboard", { replace: true });
          } finally {
            setIsRedirecting(false);
          }
        };
        checkSubscription();
      }
    }
  }, [user, navigate, view, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    // Validate input
    const result = authSchema.safeParse({ email, password, fullName });
    if (!result.success) {
      const fieldErrors: { email?: string; password?: string } = {};
      result.error.errors.forEach((err) => {
        if (err.path[0] === "email") fieldErrors.email = err.message;
        if (err.path[0] === "password") fieldErrors.password = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      if (view === "signup") {
        const { error } = await signUp(email, password, fullName);
        if (error) {
          // Parse specific error messages for better UX
          const errorMessage = error.message?.toLowerCase() || "";
          
          if (errorMessage.includes("already registered") || errorMessage.includes("user already registered")) {
            toast({
              title: "Account exists",
              description: "This email is already registered. Please sign in instead.",
              variant: "destructive",
            });
          } else if (errorMessage.includes("password") && errorMessage.includes("weak")) {
            toast({
              title: "Weak password",
              description: "Please use a stronger password with at least 6 characters, including letters and numbers.",
              variant: "destructive",
            });
          } else if (errorMessage.includes("invalid") && errorMessage.includes("email")) {
            toast({
              title: "Invalid email",
              description: "Please enter a valid email address.",
              variant: "destructive",
            });
          } else if (errorMessage.includes("rate limit") || errorMessage.includes("too many")) {
            toast({
              title: "Too many attempts",
              description: "Please wait a few minutes before trying again.",
              variant: "destructive",
            });
          } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
            toast({
              title: "Connection error",
              description: "Unable to connect to the server. Please check your internet connection.",
              variant: "destructive",
            });
          } else if (errorMessage.includes("signup") && errorMessage.includes("disabled")) {
            toast({
              title: "Sign up unavailable",
              description: "New account registration is currently disabled. Please try again later.",
              variant: "destructive",
            });
          } else {
            // Fallback with the actual error message for debugging
            toast({
              title: "Sign up failed",
              description: error.message || "An unexpected error occurred. Please try again.",
              variant: "destructive",
            });
            console.error("Sign up error:", error);
          }
        } else {
          toast({
            title: "Account created!",
            description: "Please choose your plan to get started.",
          });
          navigate("/pricing");
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        
        if (error) {
          toast({
            title: "Sign in failed",
            description: error.message,
            variant: "destructive",
          });
        } else {
          // Check if MFA is required
          const { data: factorsData } = await supabase.auth.mfa.listFactors();
          const verifiedFactors = factorsData?.totp?.filter(f => f.status === "verified") || [];
          
          if (verifiedFactors.length > 0) {
            // User has MFA enabled, show verification step
            setMfaFactorId(verifiedFactors[0].id);
            setView("mfa-verify");
          } else {
            toast({
              title: "Welcome back!",
              description: "Redirecting to dashboard...",
            });
            navigate("/dashboard");
          }
        }
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (!mfaCode || mfaCode.length !== 6) {
      setErrors({ mfaCode: "Please enter the 6-digit code from your authenticator app" });
      return;
    }

    if (!mfaFactorId) {
      toast({
        title: "Error",
        description: "MFA session expired. Please sign in again.",
        variant: "destructive",
      });
      setView("login");
      return;
    }

    setIsLoading(true);

    try {
      // Create a challenge for the factor
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      });

      if (challengeError) throw challengeError;

      // Verify the code
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: challengeData.id,
        code: mfaCode.trim(),
      });

      if (verifyError) throw verifyError;

      toast({
        title: "Welcome back!",
        description: "Redirecting to dashboard...",
      });
      navigate("/dashboard");
    } catch (error) {
      toast({
        title: "Verification failed",
        description: error instanceof Error ? error.message : "Invalid code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (!email || !z.string().email().safeParse(email).success) {
      setErrors({ email: "Please enter a valid email address" });
      return;
    }

    setIsLoading(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth?mode=reset-password`,
      });

      if (error) {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Check your email",
          description: "We've sent you a password reset link. Please check your inbox.",
        });
        setView("login");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    // Validate password
    if (!password || password.length < 6) {
      setErrors({ password: "Password must be at least 6 characters" });
      return;
    }

    if (password !== confirmPassword) {
      setErrors({ confirmPassword: "Passwords do not match" });
      return;
    }

    setIsLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: password,
      });

      if (error) {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Password updated!",
          description: "Your password has been reset successfully. You can now sign in.",
        });
        setView("login");
        setPassword("");
        setConfirmPassword("");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      const { error } = await signInWithGoogle();
      if (error) {
        toast({
          title: "Google sign in failed",
          description: error.message,
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Something went wrong with Google sign in.",
        variant: "destructive",
      });
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const isSignUp = view === "signup";
  const isForgotPassword = view === "forgot-password";
  const isResetPassword = view === "reset-password";
  const isMfaVerify = view === "mfa-verify";

  return (
    <div className="min-h-screen bg-background flex relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-0 w-96 h-96 bg-primary/10 rounded-full blur-[128px]" />
        <div className="absolute bottom-1/4 right-0 w-80 h-80 bg-accent/10 rounded-full blur-[128px]" />
      </div>

      {/* Left Panel - Branding */}
      <div className="hidden lg:flex flex-1 flex-col justify-between p-12 relative">
        <Link to="/" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>

        <div className="max-w-md">
          <Logo size="lg" className="mb-8" />
          <h1 className="text-4xl font-bold mb-4">
            Manage all your social media in one place.
          </h1>
          <p className="text-muted-foreground text-lg">
            Connect your accounts, create stunning content, and reach your audience everywhere—effortlessly.
          </p>
        </div>

        <p className="text-sm text-muted-foreground">
          Trusted by 10,000+ content creators worldwide
        </p>
      </div>

      {/* Right Panel - Form */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative z-10">
        <div className="w-full max-w-md">
          {/* Mobile Logo */}
          <div className="lg:hidden mb-8 text-center">
            <Link to="/">
              <Logo size="lg" className="justify-center" />
            </Link>
          </div>

          <div className="bg-card/50 backdrop-blur-xl border border-border rounded-2xl p-8">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold mb-2">
                {isMfaVerify
                  ? "Two-factor authentication"
                  : isResetPassword
                    ? "Set new password"
                    : isForgotPassword
                      ? "Reset your password"
                      : isSignUp
                        ? "Create your account"
                        : "Welcome back"}
              </h2>
              <p className="text-muted-foreground">
                {isMfaVerify
                  ? "Enter the code from your authenticator app"
                  : isResetPassword
                    ? "Enter your new password below"
                    : isForgotPassword
                      ? "Enter your email to receive a reset link"
                      : isSignUp
                        ? "Start your social media journey today"
                        : "Sign in to continue to Postora"}
              </p>
            </div>

            {isMfaVerify ? (
              <form onSubmit={handleMfaVerify} className="space-y-5">
                <div className="flex justify-center mb-4">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                    <Shield className="w-8 h-8 text-primary" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mfaCode">Verification Code</Label>
                  <Input
                    id="mfaCode"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="Enter 6-digit code"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    required
                    disabled={isLoading}
                    className={`text-center text-lg tracking-widest ${errors.mfaCode ? "border-destructive" : ""}`}
                    maxLength={6}
                  />
                  {errors.mfaCode && (
                    <p className="text-xs text-destructive">{errors.mfaCode}</p>
                  )}
                </div>

                <Button
                  type="submit"
                  variant="gradient"
                  className="w-full"
                  size="lg"
                  disabled={isLoading || mfaCode.length !== 6}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & Sign In"
                  )}
                </Button>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setView("login");
                      setMfaCode("");
                      setMfaFactorId(null);
                    }}
                    className="text-sm text-primary hover:underline"
                  >
                    Back to sign in
                  </button>
                </div>
              </form>
            ) : isResetPassword ? (
              <form onSubmit={handleResetPassword} className="space-y-5">
                {/* Check if user has a valid session for password reset */}
                {!user ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/30 text-center">
                      <p className="text-sm text-destructive font-medium">Session expired</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Your password reset link has expired or is invalid.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="gradient"
                      className="w-full"
                      size="lg"
                      onClick={() => setView("forgot-password")}
                    >
                      Request New Reset Link
                    </Button>
                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setView("login")}
                        className="text-sm text-primary hover:underline"
                      >
                        Back to sign in
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="password">New Password</Label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          disabled={isLoading}
                          className={`pr-10 ${errors.password ? "border-destructive" : ""}`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      {errors.password && (
                        <p className="text-xs text-destructive">{errors.password}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">Confirm Password</Label>
                      <Input
                        id="confirmPassword"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        disabled={isLoading}
                        className={errors.confirmPassword ? "border-destructive" : ""}
                      />
                      {errors.confirmPassword && (
                        <p className="text-xs text-destructive">{errors.confirmPassword}</p>
                      )}
                    </div>

                    <Button
                      type="submit"
                      variant="gradient"
                      className="w-full"
                      size="lg"
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save New Password"
                      )}
                    </Button>

                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setView("login")}
                        className="text-sm text-primary hover:underline"
                      >
                        Back to sign in
                      </button>
                    </div>
                  </>
                )}
              </form>
            ) : isForgotPassword ? (
              <PasswordResetOptions
                onBack={() => setView("login")}
                onSuccess={() => setView("login")}
              />
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-5">
                  {isSignUp && (
                    <div className="space-y-2">
                      <Label htmlFor="fullName">Full Name</Label>
                      <Input
                        id="fullName"
                        type="text"
                        placeholder="John Doe"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        disabled={isLoading}
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      disabled={isLoading}
                      className={errors.email ? "border-destructive" : ""}
                    />
                    {errors.email && (
                      <p className="text-xs text-destructive">{errors.email}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password">Password</Label>
                      {!isSignUp && (
                        <Link
                          to="/reset-password"
                          className="text-xs text-primary hover:underline"
                        >
                          Forgot password?
                        </Link>
                      )}
                    </div>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        disabled={isLoading}
                        className={`pr-10 ${errors.password ? "border-destructive" : ""}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    {errors.password && (
                      <p className="text-xs text-destructive">{errors.password}</p>
                    )}
                  </div>

                  <Button
                    type="submit"
                    variant="gradient"
                    className="w-full"
                    size="lg"
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {isSignUp ? "Creating account..." : "Signing in..."}
                      </>
                    ) : isSignUp ? (
                      "Create Account"
                    ) : (
                      "Sign In"
                    )}
                  </Button>
                </form>

                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border"></div>
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card/50 px-2 text-muted-foreground">Or continue with</span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  size="lg"
                  onClick={handleGoogleSignIn}
                  disabled={isGoogleLoading || isLoading}
                >
                  {isGoogleLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                      <path
                        fill="currentColor"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="currentColor"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                  )}
                  Continue with Google
                </Button>

                <div className="mt-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
                    <Link
                      to={isSignUp ? "/auth" : "/auth?mode=signup"}
                      className="text-primary hover:underline font-medium"
                    >
                      {isSignUp ? "Sign in" : "Sign up"}
                    </Link>
                  </p>
                </div>
              </>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground mt-6">
            By continuing, you agree to our{" "}
            <Link to="/terms" className="text-primary hover:underline">Terms of Service</Link>
            {" "}and{" "}
            <Link to="/privacy" className="text-primary hover:underline">Privacy Policy</Link>.
          </p>
        </div>
      </div>

      {/* Cookie Consent Banner */}
      <CookieConsent />
    </div>
  );
}

