import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

interface WhatsAppChromeContextValue {
  compact: boolean;
  immersive: boolean;
  setCompact: Dispatch<SetStateAction<boolean>>;
  setImmersive: Dispatch<SetStateAction<boolean>>;
}

const WhatsAppChromeContext = createContext<WhatsAppChromeContextValue | null>(null);

export function WhatsAppChromeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [compact, setCompact] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const value = useMemo(
    () => ({ compact, immersive, setCompact, setImmersive }),
    [compact, immersive],
  );

  return <WhatsAppChromeContext.Provider value={value}>{children}</WhatsAppChromeContext.Provider>;
}

// Provider modules intentionally export their consumer hook alongside the provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useWhatsAppChrome(): WhatsAppChromeContextValue {
  const context = useContext(WhatsAppChromeContext);
  if (!context) {
    throw new Error("useWhatsAppChrome must be used within WhatsAppChromeProvider");
  }
  return context;
}
