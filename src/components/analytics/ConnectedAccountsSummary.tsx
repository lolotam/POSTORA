import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";

interface Account {
  id: string;
  platform: string;
  platform_username: string | null;
}

interface ConnectedAccountsSummaryProps {
  accounts: Account[];
  getPostCountForPlatform: (platform: string) => number;
}

export function ConnectedAccountsSummary({
  accounts,
  getPostCountForPlatform,
}: ConnectedAccountsSummaryProps) {
  const { t } = useTranslation("analytics");

  return (
    <Card className="p-6 bg-card/50 border-border">
      <h3 className="font-semibold mb-4">{t("profile.connectedAccounts", "Connected Accounts")}</h3>
      <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {accounts.map((account) => (
          <div
            key={account.id}
            className="flex items-center gap-3 p-4 rounded-xl bg-secondary/50 border border-border"
          >
            <div className="w-10 h-10 rounded-lg bg-background flex items-center justify-center">
              <PlatformIcon platform={account.platform as Platform} size="sm" />
            </div>
            <div>
              <p className="font-medium text-sm">
                {account.platform_username || getPlatformName(account.platform as Platform)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("posts.countPosts", "{{count}} posts", { count: getPostCountForPlatform(account.platform) })}
              </p>
            </div>
          </div>
        ))}
        {accounts.length === 0 && (
          <p className="text-muted-foreground text-sm col-span-full">
            {t("posts.noConnected", "No connected accounts yet")}
          </p>
        )}
      </div>
    </Card>
  );
}
