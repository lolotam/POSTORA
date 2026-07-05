import { Webhook } from "lucide-react";
import { WebhookManager } from "@/components/messaging/WebhookManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Webhooks() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Webhook}
        title="Webhooks"
        description="Inspect and manage WhatsApp webhook integrations."
      />
      <WebhookManager />
    </div>
  );
}
