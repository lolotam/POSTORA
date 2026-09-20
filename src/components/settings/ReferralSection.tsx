import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { ReferralLeaderboard } from "./ReferralLeaderboard";
import {
  Gift,
  Copy,
  Check,
  Users,
  Loader2,
  Share2,
  DollarSign,
} from "lucide-react";

interface Referral {
  id: string;
  referred_user_id: string | null;
  status: string;
  reward_amount: number;
  created_at: string;
  completed_at: string | null;
}

interface Profile {
  referral_code: string | null;
}

export function ReferralSection() {
  const { t } = useTranslation("accounts");
  const { user } = useAuth();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (user?.id) {
      fetchReferralData();
    }
  }, [user?.id]);

  const fetchReferralData = async () => {
    if (!user?.id) return;

    setIsLoading(true);
    try {
      // Fetch user's referral code from profile
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("referral_code")
        .eq("id", user.id)
        .single();

      if (profileError) throw profileError;
      
      setReferralCode((profile as Profile)?.referral_code || null);

      // Fetch referrals made by this user
      const { data: referralData, error: referralError } = await supabase
        .from("referrals")
        .select("*")
        .eq("referrer_id", user.id)
        .order("created_at", { ascending: false });

      if (referralError) throw referralError;
      setReferrals((referralData as Referral[]) || []);
    } catch (error) {
      console.error("Error fetching referral data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Use custom domain for referral links
  const getReferralLink = () => {
    if (!referralCode) return "";
    // Use postora.cloud domain for referral links
    return `https://postora.cloud/auth?ref=${referralCode}`;
  };

  const copyReferralLink = async () => {
    if (!referralCode) return;
    
    const referralLink = getReferralLink();
    
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      toast({
        title: t("referral.toast.copied", "Link copied!"),
        description: t("referral.toast.copiedDesc", "Share this link with your friends to earn rewards."),
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: t("referral.toast.copyFailed", "Failed to copy"),
        description: t("referral.toast.copyFailedDesc", "Please copy the link manually."),
        variant: "destructive",
      });
    }
  };

  const shareReferral = async () => {
    if (!referralCode) return;
    
    const referralLink = getReferralLink();
    const shareData = {
      title: t("referral.share.title", "Join me on Postora!"),
      text: t("referral.share.text", "Sign up with my referral link and we both get a discount on our subscription!"),
      url: referralLink,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User cancelled or share failed
      }
    } else {
      copyReferralLink();
    }
  };

  const completedReferrals = referrals.filter(r => r.status === "completed" || r.status === "rewarded");
  const pendingReferrals = referrals.filter(r => r.status === "pending");
  const totalEarned = referrals
    .filter(r => r.status === "rewarded")
    .reduce((sum, r) => sum + (r.reward_amount || 0), 0);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-muted-foreground">{t("referral.loading", "Loading referral data...")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Referral Stats */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
            <Gift className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <h2 className="font-semibold">{t("referral.header.title", "Referral Program")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("referral.header.subtitle", "Invite friends and earn rewards when they subscribe")}
            </p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid sm:grid-cols-3 gap-4 mb-6">
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <Users className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold">{completedReferrals.length}</p>
                  <p className="text-xs text-muted-foreground">{t("referral.stats.successful", "Successful Referrals")}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold">{pendingReferrals.length}</p>
                  <p className="text-xs text-muted-foreground">{t("referral.stats.pending", "Pending Invites")}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <DollarSign className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold">${totalEarned.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">{t("referral.stats.earned", "Total Earned")}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Referral Link */}
        <div className="space-y-3">
          <label className="text-sm font-medium">{t("referral.form.link", "Your Referral Link")}</label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={referralCode ? getReferralLink() : t("common:loading", "Loading...")}
              className="font-mono text-sm"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={copyReferralLink}
              disabled={!referralCode}
            >
              {copied ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </Button>
            <Button onClick={shareReferral} disabled={!referralCode} className="gap-2">
              <Share2 className="w-4 h-4" />
              {t("common:share", "Share")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("referral.form.hint", "When friends sign up and subscribe using your link, you both get $10 off your next bill!")}
          </p>
        </div>
      </div>

      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("referral.how.title", "How It Works")}</CardTitle>
          <CardDescription>
            {t("referral.how.subtitle", "Earn rewards for every friend who subscribes")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/30">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <span className="text-primary font-bold">1</span>
              </div>
              <h4 className="font-medium mb-1">{t("referral.how.step1Title", "Share Your Link")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("referral.how.step1Desc", "Copy and share your unique referral link with friends")}
              </p>
            </div>
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/30">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <span className="text-primary font-bold">2</span>
              </div>
              <h4 className="font-medium mb-1">{t("referral.how.step2Title", "Friends Subscribe")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("referral.how.step2Desc", "They sign up and get $10 off their first subscription")}
              </p>
            </div>
            <div className="flex flex-col items-center text-center p-4 rounded-lg bg-muted/30">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                <span className="text-primary font-bold">3</span>
              </div>
              <h4 className="font-medium mb-1">{t("referral.how.step3Title", "You Get Rewarded")}</h4>
              <p className="text-sm text-muted-foreground">
                {t("referral.how.step3Desc", "You earn $10 credit toward your next billing cycle")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Referrals */}
      {referrals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("referral.recent.title", "Recent Referrals")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {referrals.slice(0, 5).map((referral) => (
                <div
                  key={referral.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/30"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <Users className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {referral.status === "completed" || referral.status === "rewarded"
                          ? t("referral.recent.subscribed", "Friend subscribed!")
                          : t("referral.recent.inviteSent", "Invite sent")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(referral.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant={
                      referral.status === "rewarded"
                        ? "default"
                        : referral.status === "completed"
                        ? "secondary"
                        : "outline"
                    }
                    className={
                      referral.status === "rewarded"
                        ? "bg-green-500 hover:bg-green-600"
                        : ""
                    }
                  >
                    {referral.status === "rewarded"
                      ? `+$${referral.reward_amount}`
                      : referral.status === "completed"
                      ? t("referral.recent.pendingReward", "Pending reward")
                      : t("common:status.pending", "Pending")}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Leaderboard */}
      <ReferralLeaderboard />
    </div>
  );
}
