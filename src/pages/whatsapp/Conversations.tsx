import { MessageSquare } from "lucide-react";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Conversations() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={MessageSquare}
        title="Conversations"
        description="Reply to WhatsApp customers and manage live inbox activity."
      />
      <div className="min-h-[640px]">
        <MessagingInbox platform="whatsapp" />
      </div>
    </div>
  );
}
