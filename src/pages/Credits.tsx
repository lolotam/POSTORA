import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useCredits } from "@/hooks/useCredits";
import { useUserRole } from "@/hooks/useUserRole";
import { supabase } from "@/integrations/supabase/client";
import { 
  Sparkles, 
  Zap, 
  ImagePlus, 
  Hash, 
  Loader2, 
  CreditCard,
  TrendingUp,
  History,
  Crown,
  Shield,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";

const CREDIT_PACKS = [
  {
    id: "credits_50",
    credits: 50,
    price: 4.99,
    pricePerCredit: 0.10,
    popular: false,
  },
  {
    id: "credits_100",
    credits: 100,
    price: 8.99,
    pricePerCredit: 0.09,
    popular: true,
  },
  {
    id: "credits_200",
    credits: 200,
    price: 15.99,
    pricePerCredit: 0.08,
    popular: false,
  },
];

export default function Credits() {
  const { t } = useTranslation("billing");
  const [loadingPackId, setLoadingPackId] = useState<string | null>(null);
  const { user } = useAuth();
  const { balance, transactions, isLoading } = useCredits();
  const { isAdmin } = useUserRole();
  const { toast } = useToast();
  const navigate = useNavigate();

  const packNames: Record<string, string> = {
    credits_50: t("credits.packs.credits50", "50 Credits"),
    credits_100: t("credits.packs.credits100", "100 Credits"),
    credits_200: t("credits.packs.credits200", "200 Credits"),
  };
  const packSavings: Record<string, string> = {
    credits_100: t("credits.packs.save10", "Save 10%"),
    credits_200: t("credits.packs.save20", "Save 20%"),
  };

  const handlePurchase = async (packId: string) => {
    if (!user) {
      navigate("/auth");
      return;
    }

    setLoadingPackId(packId);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        throw new Error(t("credits.errors.pleaseLogIn", "Please log in to purchase credits"));
      }

      const response = await supabase.functions.invoke("create-payment", {
        body: {
          product_type: packId,
          quantity: 1,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || t("credits.errors.createSession", "Failed to create payment session"));
      }

      const { url } = response.data;

      if (url) {
        window.open(url, "_blank");
      } else {
        throw new Error(t("credits.errors.noCheckoutUrl", "No checkout URL returned"));
      }
    } catch (error) {
      console.error("Purchase error:", error);
      toast({
        title: t("credits.toast.purchaseFailed", "Purchase failed"),
        description: error instanceof Error ? error.message : t("credits.toast.startCheckoutFailed", "Failed to start checkout"),
        variant: "destructive",
      });
    } finally {
      setLoadingPackId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <Badge variant="secondary" className="gap-2">
            <Zap className="w-3 h-3" />
            {t("credits.header.badge", "AI Credits")}
          </Badge>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            {t("credits.header.title", "Power Up Your Content")}
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            {t("credits.header.subtitle", "Purchase AI credits for caption generation, hashtag suggestions, and image creation. Credits never expire!")}
          </p>
        </div>

        {/* Current Balance */}
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${isAdmin ? 'bg-green-500/10' : 'bg-primary/10'}`}>
                  {isAdmin ? <Shield className="w-8 h-8 text-green-500" /> : <Zap className="w-8 h-8 text-primary" />}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t("credits.balance.label", "Your Balance")}</p>
                  <p className="text-4xl font-bold">
                    {isAdmin ? "∞" : (isLoading ? "..." : balance.toLocaleString())}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {isAdmin ? t("credits.balance.unlimitedAccess", "Unlimited Access") : t("credits.balance.aiCredits", "AI Credits")}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-6 text-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("credits.costs.captions", "Captions")}</p>
                    <p className="text-sm font-medium">{isAdmin ? t("credits.costs.unlimited", "Unlimited") : t("credits.costs.oneCredit", "1 credit")}</p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                    <Hash className="w-5 h-5 text-green-500" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("credits.costs.hashtags", "Hashtags")}</p>
                    <p className="text-sm font-medium">{isAdmin ? t("credits.costs.unlimited", "Unlimited") : t("credits.costs.oneCredit", "1 credit")}</p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <ImagePlus className="w-5 h-5 text-purple-500" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("credits.costs.images", "Images")}</p>
                    <p className="text-sm font-medium">{isAdmin ? t("credits.costs.unlimited", "Unlimited") : t("credits.costs.twoCredits", "2 credits")}</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Admin Notice or Credit Packs */}
        {isAdmin ? (
          <Card className="border-green-500/20 bg-gradient-to-br from-green-500/5 to-transparent">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-green-500/10 flex items-center justify-center">
                  <Shield className="w-7 h-7 text-green-500" />
                </div>
                <div>
                  <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white mb-2">
                    <Crown className="w-3 h-3 mr-1" />
                    {t("credits.admin.badge", "Admin")}
                  </Badge>
                  <p className="text-sm text-muted-foreground">
                    {t("credits.admin.desc", "As an admin, you have unlimited access to all AI features. No credit purchases required.")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div>
            <h2 className="text-xl font-semibold mb-4">{t("credits.packs.choose", "Choose a Credit Pack")}</h2>
            <div className="grid md:grid-cols-3 gap-6">
              {CREDIT_PACKS.map((pack) => (
                <Card 
                  key={pack.id} 
                  className={`relative ${pack.popular ? "border-primary shadow-lg shadow-primary/10" : ""}`}
                >
                  {pack.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
                      {t("credits.packs.bestValue", "Best Value")}
                    </Badge>
                  )}
                  {packSavings[pack.id] && (
                    <Badge 
                      variant="secondary" 
                      className="absolute -top-3 right-4 bg-green-500/10 text-green-600 border-green-500/30"
                    >
                      {packSavings[pack.id]}
                    </Badge>
                  )}
                  <CardHeader className="text-center pb-4">
                    <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                      <Zap className="w-7 h-7 text-primary" />
                    </div>
                    <CardTitle className="text-xl">{packNames[pack.id]}</CardTitle>
                    <CardDescription>
                      <span className="text-2xl font-bold text-foreground">${pack.price}</span>
                    </CardDescription>
                    <p className="text-xs text-muted-foreground">
                      {t("credits.packs.perCredit", "${{price}} per credit", { price: pack.pricePerCredit.toFixed(2) })}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <Button
                      className="w-full gap-2"
                      variant={pack.popular ? "default" : "outline"}
                      onClick={() => handlePurchase(pack.id)}
                      disabled={loadingPackId === pack.id}
                    >
                      {loadingPackId === pack.id ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t("credits.actions.processing", "Processing...")}
                        </>
                      ) : (
                        <>
                          <CreditCard className="w-4 h-4" />
                          {t("credits.actions.buyNow", "Buy Now")}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Recent Transactions */}
        {transactions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {t("credits.transactions.title", "Recent Transactions")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {transactions.slice(0, 10).map((tx) => (
                  <div 
                    key={tx.id} 
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        tx.amount > 0 
                          ? "bg-green-500/10" 
                          : "bg-orange-500/10"
                      }`}>
                        {tx.amount > 0 ? (
                          <TrendingUp className="w-4 h-4 text-green-500" />
                        ) : (
                          <Sparkles className="w-4 h-4 text-orange-500" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {tx.transaction_type === "purchase" && t("credits.transactions.purchased", "Purchased credits")}
                          {tx.transaction_type === "usage" && (tx.description || t("credits.transactions.used", "Used credits"))}
                          {tx.transaction_type === "bonus" && t("credits.transactions.bonus", "Bonus credits")}
                          {tx.transaction_type === "refund" && t("credits.transactions.refund", "Refund")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(tx.created_at), "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      </div>
                    </div>
                    <span className={`font-semibold ${
                      tx.amount > 0 ? "text-green-500" : "text-muted-foreground"
                    }`}>
                      {tx.amount > 0 ? "+" : ""}{tx.amount}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* FAQ */}
        <Card>
          <CardHeader>
            <CardTitle>{t("credits.faq.title", "Frequently Asked Questions")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="font-medium">{t("credits.faq.expireQ", "Do credits expire?")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("credits.faq.expireA", "No! Your credits never expire and can be used anytime.")}
              </p>
            </div>
            <div>
              <h4 className="font-medium">{t("credits.faq.refundQ", "Can I get a refund?")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("credits.faq.refundA", "Due to the digital nature of credits, we cannot offer refunds once purchased.")}
              </p>
            </div>
            <div>
              <h4 className="font-medium">{t("credits.faq.runOutQ", "What happens when I run out?")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("credits.faq.runOutA", "You'll still have access to your subscription's included AI features. Credits are for additional usage beyond your plan limits.")}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
