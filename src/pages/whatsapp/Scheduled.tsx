import { Clock } from "lucide-react";
import { ScheduledMessageManager } from "@/components/messaging/ScheduledMessageManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Scheduled() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Clock}
        title="Scheduled"
        description="Review scheduled WhatsApp messages before they send."
      />
      <ScheduledMessageManager />
    </div>
  );
}
