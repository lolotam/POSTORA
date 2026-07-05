import { FileText } from "lucide-react";
import { WhatsAppTemplatesContent } from "@/components/messaging/WhatsAppTemplatesContent";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Templates() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={FileText}
        title="Templates"
        description="Review and send approved WhatsApp message templates."
      />
      <WhatsAppTemplatesContent />
    </div>
  );
}
