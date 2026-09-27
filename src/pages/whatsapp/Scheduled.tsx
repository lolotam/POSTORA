import { Clock } from "lucide-react";
import { ScheduledMessageManager } from "@/components/messaging/ScheduledMessageManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Scheduled() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Clock}
        title="Scheduled"
        description="Schedule a WhatsApp message and review it before it sends."
      />
      <ScheduledMessageManager />
    </div>
  );
}
