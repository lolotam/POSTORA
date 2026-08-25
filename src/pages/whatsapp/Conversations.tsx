import { useEffect } from "react";
import { useWhatsAppChrome } from "@/components/whatsapp/WhatsAppChromeContext";
import { WhatsAppInboxScreen } from "@/features/whatsapp-inbox";

export default function Conversations() {
  const { setCompact, setImmersive } = useWhatsAppChrome();

  useEffect(() => {
    setImmersive(true);
    return () => {
      setCompact(false);
      setImmersive(false);
    };
  }, [setCompact, setImmersive]);

  return <WhatsAppInboxScreen />;
}
