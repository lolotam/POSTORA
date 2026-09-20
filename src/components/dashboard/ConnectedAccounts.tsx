import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Reveal, GradientRingCard } from "@/components/fx";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { Plus, ArrowUpRight, Loader2 } from "lucide-react";

interface Account {
  id: string;
  platform: ExtendedPlatform;
  platform_username: string | null;
  platform_user_id: string;
}

interface ConnectedAccountsProps {
  accounts: Account[];
  isLoading?: boolean;
}

export function ConnectedAccounts({ accounts, isLoading }: ConnectedAccountsProps) {
  const { t } = useTranslation("dashboard");

  return (
    <Reveal delay={240}>
    <GradientRingCard variant="violet" innerClassName="p-0 overflow-hidden" hoverLift={false}>
      <div className="p-5 border-b border-border/60 flex items-center justify-between">
        <h2 className="font-semibold">{t("accounts.title", "Connected Accounts")}</h2>
        <Link to="/profiles">
          <Button variant="ghost" size="sm">
            {t("accounts.manage", "Manage")}
            <ArrowUpRight className="w-4 h-4 ml-1" />
          </Button>
        </Link>
      </div>
      <div className="p-5 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground mb-3">{t("accounts.noAccounts", "No connected accounts yet")}</p>
          </div>
        ) : (
          accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50"
            >
              <div className="w-10 h-10 rounded-lg bg-background flex items-center justify-center">
                <PlatformIcon platform={account.platform} size="md" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {getPlatformName(account.platform)}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {account.platform_username || account.platform_user_id}
                </p>
              </div>
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
            </div>
          ))
        )}

        <Link to="/profiles" className="block">
          <Button variant="outline" className="w-full mt-2">
            <Plus className="w-4 h-4 mr-2" />
            {t("accounts.connectMore", "Connect More")}
          </Button>
        </Link>
      </div>
    </GradientRingCard>
    </Reveal>
  );
}
