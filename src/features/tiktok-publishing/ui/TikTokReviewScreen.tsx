import { useMemo, type ReactNode } from "react";
import { createSupabaseReviewGateway } from "../infrastructure/supabaseReviewGateway";
import { createSupabaseConnectionGateway } from "../infrastructure/supabaseConnectionGateway";
import { TikTokReviewGatewayProvider } from "../application/ports";
import { TikTokConnectionProvider } from "../application/connectionPort";
import { TikTokReviewWorkspace } from "./TikTokReviewWorkspace";
import "./tiktokReview.css";

/** Composition root: the only ui/ file that wires the Supabase adapters into the ports. */
export function TikTokReviewProvider({ children }: { children: ReactNode }) {
  const gateway = useMemo(() => createSupabaseReviewGateway(), []);
  const connection = useMemo(() => createSupabaseConnectionGateway(), []);
  return (
    <TikTokReviewGatewayProvider gateway={gateway}>
      <TikTokConnectionProvider gateway={connection}>{children}</TikTokConnectionProvider>
    </TikTokReviewGatewayProvider>
  );
}

export function TikTokReviewScreen({ headerLink }: { headerLink: ReactNode }) {
  return (
    <TikTokReviewProvider>
      <TikTokReviewWorkspace headerLink={headerLink} />
    </TikTokReviewProvider>
  );
}
