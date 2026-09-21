import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Sparkles, ArrowRight, Loader2, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCredits } from "@/hooks/useCredits";
import { useToast } from "@/hooks/use-toast";

type PaymentErrorKey = "no_session" | "verify_failed";

export default function PaymentSuccess() {
  const { t } = useTranslation("billing");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { refetch } = useCredits();
  const [isVerifying, setIsVerifying] = useState(true);
  const [verificationResult, setVerificationResult] = useState<{
    success: boolean;
    credits_added?: number;
    new_balance?: number;
    error?: string;
    errorKey?: PaymentErrorKey;
  } | null>(null);

  const sessionId = searchParams.get("session_id");
  const productType = searchParams.get("product");
  const creditsParam = searchParams.get("credits");

  useEffect(() => {
    const verifyPayment = async () => {
      if (!sessionId) {
        setIsVerifying(false);
        setVerificationResult({ success: false, errorKey: "no_session" });
        return;
      }

      try {
        const response = await supabase.functions.invoke("verify-payment", {
          body: { session_id: sessionId },
        });

        if (response.error) {
          throw new Error(response.error.message);
        }

        setVerificationResult(response.data);
        
        if (response.data.success) {
          refetch(); // Refresh credit balance
          toast({
            title: t("payment.toast.success", "Payment successful!"),
            description: t("payment.toast.creditsAdded", "{{count}} credits have been added to your account.", { count: response.data.credits_added }),
          });
        }
      } catch (error) {
        console.error("Verification error:", error);
        setVerificationResult({ 
          success: false, 
          error: error instanceof Error ? error.message : undefined,
          errorKey: error instanceof Error ? undefined : "verify_failed",
        });
      } finally {
        setIsVerifying(false);
      }
    };

    verifyPayment();
    // t is omitted so a language switch does not re-invoke payment verification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refetch, toast]);

  const processingDescription =
    verificationResult?.errorKey === "no_session"
      ? t("payment.errors.noSession", "No session ID provided")
      : verificationResult?.errorKey === "verify_failed"
        ? t("payment.errors.verifyFailed", "Failed to verify payment")
        : verificationResult?.error || t("payment.processing.desc", "Your payment is still being processed. Please check back in a moment.");

  if (isVerifying) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
          <Loader2 className="w-12 h-12 animate-spin text-primary" />
          <p className="text-lg text-muted-foreground">{t("payment.verifying", "Verifying your payment...")}</p>
        </div>
      </DashboardLayout>
    );
  }

  if (!verificationResult?.success) {
    return (
      <DashboardLayout>
        <div className="max-w-lg mx-auto py-12">
          <Card className="text-center">
            <CardHeader>
              <div className="w-20 h-20 rounded-full bg-orange-500/10 flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-10 h-10 text-orange-500" />
              </div>
              <CardTitle className="text-2xl">{t("payment.processing.title", "Payment Processing")}</CardTitle>
              <CardDescription>
                {processingDescription}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={() => window.location.reload()} variant="outline" className="gap-2">
                <Loader2 className="w-4 h-4" />
                {t("payment.actions.checkAgain", "Check Again")}
              </Button>
              <Button onClick={() => navigate("/credits")} variant="ghost">
                {t("payment.actions.backToCredits", "Back to Credits")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-lg mx-auto py-12">
        <Card className="text-center">
          <CardHeader>
            <div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
              <Check className="w-10 h-10 text-green-500" />
            </div>
            <CardTitle className="text-2xl">{t("payment.success.title", "Payment Successful!")}</CardTitle>
            <CardDescription>
              {t("payment.success.desc", "Your AI credits have been added to your account.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-6 rounded-xl bg-primary/5 border border-primary/20">
              <div className="flex items-center justify-center gap-3 text-primary mb-2">
                <Zap className="w-6 h-6" />
                <span className="text-3xl font-bold">
                  +{verificationResult.credits_added || creditsParam}
                </span>
                <span className="text-lg">{t("payment.success.credits", "Credits")}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("payment.success.newBalance", "New balance: {{count}} credits", { count: verificationResult.new_balance })}
              </p>
            </div>

            <div className="p-4 rounded-lg bg-secondary/50">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="w-4 h-4" />
                <span>{t("payment.success.useThem", "Use them for captions, hashtags, and image generation")}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button onClick={() => navigate("/post")} className="gap-2">
                <ArrowRight className="w-4 h-4" />
                {t("payment.actions.createPost", "Create a Post")}
              </Button>
              <Button variant="outline" onClick={() => navigate("/credits")}>
                {t("payment.actions.viewBalance", "View Credit Balance")}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("payment.success.emailSent", "A confirmation email has been sent to your registered email address.")}
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
