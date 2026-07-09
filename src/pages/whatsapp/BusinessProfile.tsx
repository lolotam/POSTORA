import { Building2 } from "lucide-react";
import { BusinessProfileManager } from "@/components/messaging/BusinessProfileManager";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function BusinessProfile() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={Building2}
        title="Profile"
        description="Maintain your WhatsApp Business profile details."
      />
      <BusinessProfileManager />
    </div>
  );
}
