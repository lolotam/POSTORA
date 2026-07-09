import { BarChart3 } from "lucide-react";
import { WhatsAppAnalyticsContent } from "@/components/messaging/WhatsAppAnalyticsContent";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Analytics() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={BarChart3}
        title="Analytics"
        description="Monitor conversations, unread volume, and response trends."
      />
      <WhatsAppAnalyticsContent />
    </div>
  );
}
