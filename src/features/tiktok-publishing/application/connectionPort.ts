import { createContext, createElement, useContext, type ReactNode } from "react";

/** Connecting and disconnecting TikTok accounts, kept apart from the review gateway on purpose. */
export interface TikTokConnectionGateway {
  /** TikTok's authorization URL; the browser is sent there to connect an account. */
  authorizeUrl(): Promise<string>;
  /** Revokes Postora in TikTok and marks the account inactive. Posts already sent to TikTok are not affected. */
  disconnect(accountId: string): Promise<void>;
}

const TikTokConnectionContext = createContext<TikTokConnectionGateway | null>(null);

export function TikTokConnectionProvider({
  gateway,
  children,
}: {
  gateway: TikTokConnectionGateway;
  children: ReactNode;
}) {
  return createElement(TikTokConnectionContext.Provider, { value: gateway }, children);
}

export function useTikTokConnectionGateway(): TikTokConnectionGateway {
  const gateway = useContext(TikTokConnectionContext);
  if (!gateway) throw new Error("useTikTokConnectionGateway must be used within TikTokConnectionProvider");
  return gateway;
}
