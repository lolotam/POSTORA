import { Users } from "lucide-react";
import { WhatsAppContactsContent } from "@/components/messaging/WhatsAppContactsContent";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Contacts() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Users}
        title="Contacts"
        description="Manage opted-in WhatsApp contacts, tags, and uploads."
      />
      <WhatsAppContactsContent />
    </div>
  );
}
