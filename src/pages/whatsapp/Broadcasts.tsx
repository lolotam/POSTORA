import { Radio } from "lucide-react";
import { BroadcastManager } from "@/components/messaging/BroadcastManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Broadcasts() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Radio}
        title="Broadcasts"
        description="Create and track WhatsApp broadcast campaigns."
      />
      <BroadcastManager />
    </div>
  );
}
