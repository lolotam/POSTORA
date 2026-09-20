import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { Trophy, Medal, Award, TrendingUp } from "lucide-react";

interface LeaderboardEntry {
  referrer_id: string;
  total_referrals: number;
  total_earned: number;
  rank: number;
}

export function ReferralLeaderboard() {
  const { t } = useTranslation("accounts");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const fetchLeaderboard = async () => {
    setIsLoading(true);
    try {
      // Fetch top referrers from referrals table
      const { data, error } = await supabase
        .from("referrals")
        .select("referrer_id, status, reward_amount")
        .in("status", ["completed", "rewarded"]);

      if (error) throw error;

      // Aggregate by referrer
      const aggregated = (data || []).reduce((acc, ref) => {
        const existing = acc.find((e) => e.referrer_id === ref.referrer_id);
        if (existing) {
          existing.total_referrals += 1;
          existing.total_earned += ref.reward_amount || 0;
        } else {
          acc.push({
            referrer_id: ref.referrer_id,
            total_referrals: 1,
            total_earned: ref.reward_amount || 0,
            rank: 0,
          });
        }
        return acc;
      }, [] as LeaderboardEntry[]);

      // Sort by total referrals and assign ranks
      const sorted = aggregated
        .sort((a, b) => b.total_referrals - a.total_referrals)
        .slice(0, 10)
        .map((entry, index) => ({ ...entry, rank: index + 1 }));

      setLeaderboard(sorted);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="w-5 h-5 text-yellow-500" />;
      case 2:
        return <Medal className="w-5 h-5 text-gray-400" />;
      case 3:
        return <Award className="w-5 h-5 text-amber-600" />;
      default:
        return (
          <span className="w-5 h-5 flex items-center justify-center text-sm font-bold text-muted-foreground">
            {rank}
          </span>
        );
    }
  };

  const getRankBadgeClass = (rank: number) => {
    switch (rank) {
      case 1:
        return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
      case 2:
        return "bg-gray-400/10 text-gray-400 border-gray-400/20";
      case 3:
        return "bg-amber-600/10 text-amber-600 border-amber-600/20";
      default:
        return "";
    }
  };

  const getInitials = (id: string) => {
    return id.substring(0, 2).toUpperCase();
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            {t("leaderboard.title", "Top Referrers")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="w-8 h-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            {t("leaderboard.title", "Top Referrers")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Trophy className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{t("leaderboard.empty", "No referrals yet. Be the first!")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingUp className="w-5 h-5" />
          {t("leaderboard.title", "Top Referrers")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {leaderboard.map((entry) => (
            <div
              key={entry.referrer_id}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                entry.rank <= 3 ? "bg-muted/50" : "hover:bg-muted/30"
              }`}
            >
              <div className="w-8 h-8 flex items-center justify-center">
                {getRankIcon(entry.rank)}
              </div>
              <Avatar className="w-10 h-10">
                <AvatarFallback className={getRankBadgeClass(entry.rank)}>
                  {getInitials(entry.referrer_id)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  {t("leaderboard.referrer", "Referrer #{{rank}}", { rank: entry.rank })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {entry.total_referrals === 1
                    ? t("leaderboard.successfulOne", "{{count}} successful referral", { count: entry.total_referrals })
                    : t("leaderboard.successfulMany", "{{count}} successful referrals", { count: entry.total_referrals })}
                </p>
              </div>
              <Badge variant="secondary" className="shrink-0">
                {t("leaderboard.earned", "${{amount}} earned", { amount: entry.total_earned.toFixed(0) })}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
