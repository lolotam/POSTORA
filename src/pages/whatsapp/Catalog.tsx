import { ShoppingBag } from "lucide-react";
import { WhatsAppCatalogContent } from "@/components/messaging/WhatsAppCatalogContent";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";

export default function Catalog() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={ShoppingBag}
        title="Catalog"
        description="Manage WhatsApp catalog items for commerce conversations."
      />
      <WhatsAppCatalogContent />
    </div>
  );
}
