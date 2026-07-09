import { PieChart } from "lucide-react";
import { CannedResponseAnalytics } from "@/components/messaging/CannedResponseAnalytics";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function ResponseStats() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={PieChart}
        title="Response Stats"
        description="Track canned response usage and automation performance."
      />
      <CannedResponseAnalytics />
    </div>
  );
}
