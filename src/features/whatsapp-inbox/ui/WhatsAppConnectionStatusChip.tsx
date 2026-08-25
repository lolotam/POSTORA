import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { WhatsAppCoexistenceSetupBanner } from "@/components/messaging/WhatsAppCoexistenceSetupBanner";
import { WhatsAppSetup } from "@/components/messaging/WhatsAppSetup";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { MessagingAccount } from "@/hooks/useMessaging";

const SETUP_STORAGE_KEY = "postora.whatsapp.setupExpanded";

function readExpandedPreference(): boolean {
  try {
    return window.localStorage.getItem(SETUP_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function connectionModeLabel(mode: MessagingAccount["connection_mode"]): string {
  if (mode === "evolution_qr") return "Direct QR";
  if (mode === "coexistence") return "Coexistence";
  return "Cloud API";
}

interface WhatsAppConnectionStatusChipProps {
  connectedAccounts: MessagingAccount[];
  selectedAccountId?: string | null;
}

function SetupDetails({ connectedAccounts }: { connectedAccounts: MessagingAccount[] }) {
  return (
    <div data-testid="wa-setup-panel" className="min-h-0 max-h-[min(70dvh,48rem)] overflow-y-auto border-t p-4">
      <div className="space-y-4">
        <WhatsAppCoexistenceSetupBanner />
        <WhatsAppSetup connectedAccounts={connectedAccounts} />
      </div>
    </div>
  );
}

export function WhatsAppConnectionStatusChip({
  connectedAccounts,
  selectedAccountId,
}: WhatsAppConnectionStatusChipProps): JSX.Element {
  const whatsappAccounts = useMemo(
    () => connectedAccounts.filter((account) => account.platform === "whatsapp"),
    [connectedAccounts],
  );
  const hasConnectedAccount = whatsappAccounts.length > 0;
  const selectedAccount = whatsappAccounts.find((account) => account.id === selectedAccountId) ?? whatsappAccounts[0];
  const [expanded, setExpanded] = useState(() => hasConnectedAccount ? readExpandedPreference() : true);

  useEffect(() => {
    if (!hasConnectedAccount) return;
    try {
      window.localStorage.setItem(SETUP_STORAGE_KEY, String(expanded));
    } catch {
      // The details remain usable for this session when privacy settings block persistence.
    }
  }, [expanded, hasConnectedAccount]);

  if (!hasConnectedAccount) {
    return (
      <div className="min-h-0 shrink-0 border-b bg-background/95">
        <SetupDetails connectedAccounts={connectedAccounts} />
      </div>
    );
  }

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="min-h-0 shrink-0 border-b bg-background/95"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label="Connection details"
          className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#128C7E]"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500 ring-2 ring-green-500/20" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-medium">
            {selectedAccount.platform_username || selectedAccount.platform_user_id}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {connectionModeLabel(selectedAccount.connection_mode)}
          </Badge>
          <span className="shrink-0 text-xs text-green-700 dark:text-green-400">Connected</span>
          {whatsappAccounts.length > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">+{whatsappAccounts.length - 1}</span>
          )}
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SetupDetails connectedAccounts={connectedAccounts} />
      </CollapsibleContent>
    </Collapsible>
  );
}
