import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, ArrowLeft, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface OTPVerificationProps {
  email: string;
  onVerified: () => void;
  onBack: () => void;
  type?: "signup" | "email_change" | "recovery";
}

export function OTPVerification({ email, onVerified, onBack, type = "signup" }: OTPVerificationProps) {
  const [otp, setOtp] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cooldown timer
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldown]);

  const handleOtpChange = (value: string) => {
    // Only allow numbers and limit to 6 digits
    const cleanValue = value.replace(/\D/g, "").slice(0, 6);
    setOtp(cleanValue);
    setError("");

    // Auto-verify when 6 digits entered
    if (cleanValue.length === 6) {
      handleVerify(cleanValue);
    }
  };

  const handleVerify = async (code?: string) => {
    const verifyCode = code || otp;
    
    if (verifyCode.length !== 6) {
      setError("Please enter the 6-digit code");
      return;
    }

    setIsVerifying(true);
    setError("");

    try {
      // For recovery, we need to use a different approach - the token from email link
      const otpType = type === "signup" ? "signup" : "email_change";
      
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: verifyCode,
        type: otpType,
      });

      if (verifyError) {
        if (verifyError.message.includes("expired")) {
          setError("Code expired. Please request a new one.");
        } else if (verifyError.message.includes("invalid")) {
          setError("Invalid code. Please check and try again.");
        } else {
          setError(verifyError.message);
        }
      } else {
        toast({
          title: "Verified!",
          description: type === "signup" 
            ? "Your email has been verified. Welcome to Postora!" 
            : "Verification successful.",
        });
        onVerified();
      }
    } catch (err) {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    
    setIsResending(true);
    setError("");

    try {
      const resendType = type === "signup" ? "signup" : "email_change";
      
      const { error: resendError } = await supabase.auth.resend({
        type: resendType,
        email,
      });

      if (resendError) {
        toast({
          title: "Error",
          description: resendError.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Code sent!",
          description: "A new verification code has been sent to your email.",
        });
        setCooldown(60);
        setOtp("");
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to resend code. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsResending(false);
    }
  };

  const maskedEmail = email.replace(
    /(.{2})(.*)(@.*)/, 
    (_, start, middle, end) => start + "*".repeat(Math.min(middle.length, 4)) + end
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
          <Mail className="w-8 h-8 text-primary" />
        </div>
        <h2 className="text-2xl font-bold mb-2">Check your email</h2>
        <p className="text-muted-foreground">
          We sent a verification code to
        </p>
        <p className="font-medium text-foreground mt-1">{maskedEmail}</p>
      </div>

      {/* OTP Input */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="otp" className="sr-only">Verification Code</Label>
          <Input
            ref={inputRef}
            id="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Enter 6-digit code"
            value={otp}
            onChange={(e) => handleOtpChange(e.target.value)}
            disabled={isVerifying}
            className={`text-center text-2xl tracking-[0.5em] font-mono h-14 ${error ? "border-destructive" : ""}`}
            maxLength={6}
          />
          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}
        </div>

        <Button
          onClick={() => handleVerify()}
          variant="gradient"
          className="w-full"
          size="lg"
          disabled={isVerifying || otp.length !== 6}
        >
          {isVerifying ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin me-2" />
              Verifying...
            </>
          ) : (
            "Verify Email"
          )}
        </Button>
      </div>

      {/* Resend */}
      <div className="text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          Didn't receive the code?
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleResend}
          disabled={isResending || cooldown > 0}
          className="text-primary hover:text-primary/80"
        >
          {isResending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin me-2" />
              Sending...
            </>
          ) : cooldown > 0 ? (
            <>
              <RefreshCw className="w-4 h-4 me-2" />
              Resend in {cooldown}s
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 me-2" />
              Resend code
            </>
          )}
        </Button>
      </div>

      {/* Back link */}
      <div className="text-center">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 me-1" />
          Back to sign up
        </button>
      </div>
    </div>
  );
}
