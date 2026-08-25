import { Bot } from "lucide-react";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { WhatsAppAutomationNav } from "@/components/whatsapp/WhatsAppAutomationNav";

export default function AutoReplies() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Bot}
        title="Auto Replies"
        description="Configure keyword and availability automation for inbound messages."
      />
      <WhatsAppAutomationNav />
      <AutoReplyManager />
    </div>
  );
}
