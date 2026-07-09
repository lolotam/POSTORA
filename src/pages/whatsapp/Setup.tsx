import { Settings2 } from "lucide-react";
import { WhatsAppDiagnostics } from "@/components/messaging/WhatsAppDiagnostics";
import { WhatsAppSetup } from "@/components/messaging/WhatsAppSetup";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { useMessagingAccounts } from "@/hooks/useMessaging";

export default function Setup() {
  const { accounts } = useMessagingAccounts();
  const whatsappAccounts = accounts.filter((account) => account.platform === "whatsapp");
  const diagnosticsAccount = whatsappAccounts[0];

  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Settings2}
        title="Setup"
        description="Connect numbers, choose connection mode, and run diagnostics."
      />
      <WhatsAppSetup connectedAccounts={whatsappAccounts} />
      {diagnosticsAccount && (
        <WhatsAppDiagnostics
          socialAccountId={diagnosticsAccount.id}
          phoneNumberId={diagnosticsAccount.platform_user_id || ""}
        />
      )}
    </div>
  );
}
