import type { ReactNode } from "react";
import {
  WhatsAppInboxApiContext,
  useWhatsAppInboxApi,
  type WhatsAppInboxApi,
} from "../application/ports";

interface WhatsAppInboxApiProviderProps {
  api: WhatsAppInboxApi;
  children: ReactNode;
}

export function WhatsAppInboxApiProvider({ api, children }: WhatsAppInboxApiProviderProps): JSX.Element {
  return <WhatsAppInboxApiContext.Provider value={api}>{children}</WhatsAppInboxApiContext.Provider>;
}

// Provider modules export their consumer hook alongside the provider.
// eslint-disable-next-line react-refresh/only-export-components
export { useWhatsAppInboxApi };
