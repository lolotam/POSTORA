import { Zap } from "lucide-react";
import { QuickReplyManager } from "@/components/messaging/QuickReplyManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function QuickReplies() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Zap}
        title="Quick Replies"
        description="Maintain saved responses agents can insert quickly."
      />
      <QuickReplyManager />
    </div>
  );
}
