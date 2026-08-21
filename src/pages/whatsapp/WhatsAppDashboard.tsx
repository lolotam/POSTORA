import type { LucideIcon } from "lucide-react";
import { ArrowRight, BarChart3, CheckCircle2, Loader2, MessageSquare, Phone, Settings2 } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import {
  whatsappLegacyTabTarget,
  whatsappNavItems,
  whatsappSectionDescriptions,
  whatsappSectionRoute,
} from "@/components/whatsapp/waNav";
import { useMessagingAccounts, type MessagingAccount } from "@/hooks/useMessaging";

const dashboardSectionItems = whatsappNavItems.filter((item) => item.path !== "");

function ConnectionStatusCard({ accounts, isLoading }: { accounts: MessagingAccount[]; isLoading: boolean }) {
  return (
    <Card className="overflow-hidden border-[#25D366]/25">
      <CardHeader className="bg-[#DCF8C6]/40 dark:bg-[#075E54]/20">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg">Connection Status</CardTitle>
            <CardDescription>Connected WhatsApp Business accounts available to this workspace.</CardDescription>
          </div>
          <Badge variant={accounts.length > 0 ? "default" : "secondary"} className="w-fit">
            {accounts.length > 0 ? "Connected" : "Not connected"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        <ConnectionStatusContent accounts={accounts} isLoading={isLoading} />
      </CardContent>
    </Card>
  );
}

function ConnectionStatusContent({ accounts, isLoading }: { accounts: MessagingAccount[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading WhatsApp accounts...
      </div>
    );
  }

  if (accounts.length === 0) {
    return <NotConnectedState />;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} />
      ))}
    </div>
  );
}

function AccountRow({ account }: { account: MessagingAccount }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <WhatsAppIconBox icon={Phone} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {account.platform_username || account.platform_user_id}
        </p>
        <p className="text-xs text-muted-foreground">Phone ID: {account.platform_user_id}</p>
      </div>
      <Badge variant="outline" className="border-[#25D366]/40 text-[#128C7E] dark:text-[#25D366]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Active
      </Badge>
    </div>
  );
}

function NotConnectedState() {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed p-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">No WhatsApp Business account connected.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a number before using conversations, broadcasts, templates, and diagnostics.
        </p>
      </div>
      <Button asChild>
        <Link to={whatsappSectionRoute("setup")}>
          <Settings2 className="h-4 w-4" />
          Open Setup
        </Link>
      </Button>
    </div>
  );
}

function WhatsAppIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#25D366]/10 text-[#128C7E] dark:text-[#25D366]">
      <Icon className="h-5 w-5" />
    </div>
  );
}

function QuickStats({ accountCount }: { accountCount: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ConnectedAccountsStat accountCount={accountCount} />
      <ShortcutStat icon={MessageSquare} title="Inbox" description="Open conversations" path="conversations" />
      <ShortcutStat icon={BarChart3} title="Analytics" description="View performance" path="analytics" />
    </div>
  );
}

function ConnectedAccountsStat({ accountCount }: { accountCount: number }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <WhatsAppIconBox icon={Phone} />
        <div>
          <p className="text-2xl font-bold">{accountCount}</p>
          <p className="text-sm text-muted-foreground">Connected accounts</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ShortcutStat({
  icon,
  title,
  description,
  path,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  path: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <WhatsAppIconBox icon={icon} />
          <div>
            <p className="font-semibold">{title}</p>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button asChild variant="ghost" size="icon">
          <Link to={whatsappSectionRoute(path)} aria-label={`Open ${title.toLowerCase()}`}>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function SectionCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {dashboardSectionItems.map((item) => (
        <SectionCard key={item.path} item={item} />
      ))}
    </div>
  );
}

function SectionCard({ item }: { item: (typeof dashboardSectionItems)[number] }) {
  const Icon = item.icon;

  return (
    <Link to={whatsappSectionRoute(item.path)} className="group block">
      <Card
        interactive
        className="h-full transition-colors group-hover:border-[#25D366]/60 group-hover:bg-[#DCF8C6]/20 dark:group-hover:bg-[#075E54]/20"
      >
        <CardContent className="flex h-full flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#25D366]/10 text-[#128C7E] transition-colors group-hover:bg-[#25D366] group-hover:text-[#075E54] dark:text-[#25D366]">
              <Icon className="h-5 w-5" />
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-[#128C7E] dark:group-hover:text-[#25D366]" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">{item.label}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {whatsappSectionDescriptions[item.path]}
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function WhatsAppDashboard() {
  const [searchParams] = useSearchParams();
  // Resolved through the shared helper so retired sections keep their deep links; matching on
  // the visible nav alone silently broke ?tab=webhooks when Webhooks moved into Setup.
  const legacyRoute = whatsappLegacyTabTarget(searchParams.get("tab"));
  const { accounts, isLoading } = useMessagingAccounts();
  const whatsappAccounts = accounts.filter((account) => account.platform === "whatsapp");

  if (legacyRoute) {
    return <Navigate to={legacyRoute} replace />;
  }

  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={MessageSquare}
        title="WhatsApp Dashboard"
        description="A focused command center for WhatsApp Business messaging, automation, and setup."
      />
      <ConnectionStatusCard accounts={whatsappAccounts} isLoading={isLoading} />
      <QuickStats accountCount={whatsappAccounts.length} />
      <SectionCards />
    </div>
  );
}
