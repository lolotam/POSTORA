import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useSubscription } from "@/hooks/useSubscription";
import { useUserRole } from "@/hooks/useUserRole";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import {
  Crown,
  Sparkles,
  CreditCard,
  Calendar,
  Receipt,
  ExternalLink,
  Loader2,
  AlertTriangle,
  Check,
  ArrowRight,
  RefreshCw,
  Info,
  X,
} from "lucide-react";
import { BillingHistorySection } from "./BillingHistorySection";
import { QuotaIndicators } from "@/components/profiles/QuotaIndicators";

export function SubscriptionSection() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { subscription, isSubscribed, planName, isLoading, refetch, stripeAuthError } = useSubscription();
  const { isAdmin } = useUserRole();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isManaging, setIsManaging] = useState(false);
  const [showAuthBanner, setShowAuthBanner] = useState(false);

  // Show auth error banner if Stripe verification failed
  useEffect(() => {
    if (stripeAuthError) {
      setShowAuthBanner(true);
    }
  }, [stripeAuthError]);

  const handleRefreshSession = async () => {
    try {
      await supabase.auth.refreshSession();
      refetch();
      toast({
        title: "Session refreshed",
        description: "Checking subscription status...",
      });
    } catch (error) {
      toast({
        title: "Refresh failed",
        description: "Please try logging out and back in.",
        variant: "destructive",
      });
    }
  };

  const handleCancelSubscription = async () => {
    if (!subscription?.stripe_subscription_id) {
      toast({
        title: "Cannot cancel",
        description: "No active subscription found.",
        variant: "destructive",
      });
      return;
    }

    setIsCancelling(true);

    try {
      const { data, error } = await supabase.functions.invoke("stripe-manage-subscription", {
        body: {
          action: "cancel",
          subscription_id: subscription.stripe_subscription_id,
        },
      });

      if (error) throw error;

      toast({
        title: "Subscription cancelled",
        description: "Your subscription will end at the current billing period.",
      });

      refetch();
    } catch (error) {
      console.error("Cancel error:", error);
      toast({
        title: "Failed to cancel",
        description: error instanceof Error ? error.message : "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsCancelling(false);
    }
  };

  const handleManageBilling = async () => {
    if (!subscription?.stripe_customer_id) {
      toast({
        title: "Cannot open billing",
        description: "No billing information found.",
        variant: "destructive",
      });
      return;
    }

    setIsManaging(true);

    try {
      const { data, error } = await supabase.functions.invoke("stripe-manage-subscription", {
        body: {
          action: "portal",
          customer_id: subscription.stripe_customer_id,
        },
      });

      if (error) throw error;

      if (data?.url) {
        window.open(data.url, "_blank");
      }
    } catch (error) {
      console.error("Billing portal error:", error);
      toast({
        title: "Failed to open billing",
        description: error instanceof Error ? error.message : "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsManaging(false);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-muted-foreground">Loading subscription...</span>
        </div>
      </div>
    );
  }

  if (isAdmin) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card/50 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Crown className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <h2 className="font-semibold">Subscription</h2>
              <p className="text-sm text-muted-foreground">Manage your subscription and billing</p>
            </div>
          </div>
          <div className="flex items-center gap-3 mb-4">
            <Badge className="bg-gradient-to-r from-amber-500 to-orange-500 text-white">
              Admin
            </Badge>
            <span className="text-sm text-muted-foreground">
              Full access to all features — billing checkout is hidden for admin accounts.
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/pricing")} className="gap-2">
              <Sparkles className="w-4 h-4" />
              Preview pricing page
            </Button>
          </div>
        </div>

        {/* Admin plan management shortcut */}
        <div className="rounded-xl border border-border bg-card/50 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold">Plan Management</h2>
              <p className="text-sm text-muted-foreground">
                Create, edit, and reorder subscription plans available to users.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate("/admin/plans")} className="gap-2">
              <ArrowRight className="w-4 h-4" />
              Manage subscription plans
            </Button>
            <Button variant="outline" onClick={() => navigate("/admin/coupons")} className="gap-2">
              <Receipt className="w-4 h-4" />
              Manage coupons
            </Button>
            <Button variant="ghost" onClick={() => navigate("/admin/subscriptions")} className="gap-2">
              View customer subscriptions
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Auth Error Banner */}
      {showAuthBanner && stripeAuthError && (
        <Alert className="border-amber-500/50 bg-amber-500/10">
          <Info className="h-4 w-4 text-amber-500" />
          <AlertDescription className="flex items-center justify-between">
            <span className="text-sm">
              <span className="font-medium">Session verification issue:</span> We couldn't verify your subscription with Stripe. 
              This is usually a temporary login/session issue, not a billing problem. Your subscription data is shown from our records.
            </span>
            <div className="flex items-center gap-2 ml-4 shrink-0">
              <Button size="sm" variant="outline" onClick={handleRefreshSession} className="gap-1">
                <RefreshCw className="w-3 h-3" />
                Refresh
              </Button>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setShowAuthBanner(false)}>
                <X className="w-3 h-3" />
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Current Plan Card */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <Crown className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h2 className="font-semibold">Current Plan</h2>
            <p className="text-sm text-muted-foreground">
              Manage your subscription and billing
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Plan Status */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge
                variant={isSubscribed ? "default" : "secondary"}
                className={isSubscribed ? "bg-gradient-to-r from-amber-500 to-orange-500 text-white" : ""}
              >
                {planName}
              </Badge>
              {subscription?.cancel_at_period_end && (
                <Badge variant="outline" className="text-amber-600 border-amber-500/30">
                  Cancelling
                </Badge>
              )}
              {isSubscribed && !subscription?.cancel_at_period_end && (
                <span className="text-sm text-muted-foreground">
                  Premium features enabled
                </span>
              )}
              {!isSubscribed && (
                <span className="text-sm text-muted-foreground">
                  Limited features • Upgrade for more
                </span>
              )}
            </div>

            {!isSubscribed && (
              <Button onClick={() => navigate("/pricing")} className="gap-2">
                <Sparkles className="w-4 h-4" />
                Upgrade to Pro
              </Button>
            )}
          </div>

          {/* Subscription Details */}
          {isSubscribed && subscription && (
            <div className="grid sm:grid-cols-2 gap-4 pt-4 border-t border-border">
              <div className="flex items-center gap-3">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">
                    {subscription.cancel_at_period_end ? "Ends on" : "Renews on"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {subscription.current_period_end
                      ? format(new Date(subscription.current_period_end), "MMMM d, yyyy")
                      : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <CreditCard className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Billing</p>
                  <p className="text-sm text-muted-foreground">
                    ${subscription.plan?.price_monthly?.toFixed(2) || "0.00"}/month
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Plan Features */}
          {isSubscribed && subscription?.plan?.features && (
            <div className="pt-4 border-t border-border">
              <p className="text-sm font-medium mb-3">What's included:</p>
              <div className="grid sm:grid-cols-2 gap-2">
                {subscription.plan.features.slice(0, 6).map((feature, index) => (
                  <div key={index} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Usage Limits */}
      <QuotaIndicators />

      {/* Billing Actions */}
      {isSubscribed && subscription && (
        <div className="rounded-xl border border-border bg-card/50 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold">Billing & Invoices</h2>
              <p className="text-sm text-muted-foreground">
                Manage payment methods and view invoices
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={handleManageBilling}
              disabled={isManaging}
              className="gap-2"
            >
              {isManaging ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ExternalLink className="w-4 h-4" />
              )}
              Manage Billing
            </Button>

            <Button variant="outline" onClick={() => navigate("/pricing")} className="gap-2">
              <ArrowRight className="w-4 h-4" />
              Change Plan
            </Button>

            {!subscription.cancel_at_period_end && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-destructive hover:text-destructive gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Cancel Subscription
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your subscription will remain active until{" "}
                      {subscription.current_period_end
                        ? format(new Date(subscription.current_period_end), "MMMM d, yyyy")
                        : "the end of your billing period"}
                      . After that, you'll lose access to premium features.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep Subscription</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleCancelSubscription}
                      disabled={isCancelling}
                      className="bg-destructive hover:bg-destructive/90"
                    >
                      {isCancelling ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Cancelling...
                        </>
                      ) : (
                        "Yes, Cancel"
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      )}

      {/* Billing History */}
      {isSubscribed && <BillingHistorySection />}

      {/* Upgrade CTA for Free Users */}
      {!isSubscribed && (
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              Unlock Premium Features
            </CardTitle>
            <CardDescription>
              Get more profiles, higher posting limits, AI tools, and priority support.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/pricing")} className="gap-2">
              View Plans
              <ArrowRight className="w-4 h-4" />
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
