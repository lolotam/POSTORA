import { Settings2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { WebhookManager } from "@/components/messaging/WebhookManager";
import { WhatsAppDiagnostics } from "@/components/messaging/WhatsAppDiagnostics";
import { WhatsAppSetup } from "@/components/messaging/WhatsAppSetup";
import { BringOverSetupBanner } from "@/components/messaging/BringOverSetupBanner";
import { UndeliveredStoreOrdersBanner } from "@/components/dashboard/UndeliveredStoreOrdersBanner";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMessagingAccounts, type MessagingAccount } from "@/hooks/useMessaging";

const TABS = ["connect", "webhooks", "diagnostics"] as const;
type SetupTab = (typeof TABS)[number];

function isSetupTab(value: string | null): value is SetupTab {
  return TABS.includes((value ?? "") as SetupTab);
}

/** Millis since the account was last (re)connected, 0 when the row carries no dates. */
function lastConnectedMs(account: MessagingAccount): number {
  const connected = Date.parse(account.connected_at ?? "");
  if (Number.isFinite(connected)) return connected;
  const updated = Date.parse(account.updated_at ?? "");
  return Number.isFinite(updated) ? updated : 0;
}

export default function Setup() {
  const { accounts } = useMessagingAccounts();
  const [searchParams, setSearchParams] = useSearchParams();
  const whatsappAccounts = accounts.filter((account) => account.platform === "whatsapp");
  // useMessagingAccounts only returns active rows; among several live numbers the
  // most recently connected one is the connection the owner is working with, so
  // that is where a previous setup is offered to move into.
  const primaryAccount = [...whatsappAccounts].sort(
    (a, b) => lastConnectedMs(b) - lastConnectedMs(a),
  )[0];
  const diagnosticsAccount = whatsappAccounts[0];

  // Kept in the URL so a tab stays linkable and survives a reload — the redirect from the
  // retired /webhooks route depends on it.
  const requested = searchParams.get("tab");
  const activeTab: SetupTab = isSetupTab(requested) ? requested : "connect";

  const selectTab = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "connect") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Settings2}
        title="Setup"
        description="Connect numbers, manage webhooks, and run diagnostics."
      />

      <Tabs value={activeTab} onValueChange={selectTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="connect">Connect</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
        </TabsList>

        <TabsContent value="connect" className="space-y-6">
          <UndeliveredStoreOrdersBanner />
          {primaryAccount && (
            <BringOverSetupBanner
              activeAccount={{ id: primaryAccount.id, platform_username: primaryAccount.platform_username }}
            />
          )}
          <WhatsAppSetup connectedAccounts={whatsappAccounts} />
        </TabsContent>

        <TabsContent value="webhooks">
          <WebhookManager />
        </TabsContent>

        <TabsContent value="diagnostics">
          {diagnosticsAccount
            ? (
              <WhatsAppDiagnostics
                socialAccountId={diagnosticsAccount.id}
                phoneNumberId={diagnosticsAccount.platform_user_id || ""}
              />
            )
            : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Connect a WhatsApp number to run diagnostics against it.
                </CardContent>
              </Card>
            )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
