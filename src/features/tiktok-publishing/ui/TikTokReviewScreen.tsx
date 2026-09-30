import { useMemo, type ReactNode } from "react";
import { createSupabaseReviewGateway } from "../infrastructure/supabaseReviewGateway";
import { TikTokReviewGatewayProvider } from "../application/ports";
import { TikTokReviewWorkspace } from "./TikTokReviewWorkspace";
import "./tiktokReview.css";

export function TikTokReviewScreen({ headerLink }: { headerLink: ReactNode }) {
  const gateway = useMemo(() => createSupabaseReviewGateway(), []);
  return (
    <TikTokReviewGatewayProvider gateway={gateway}>
      <TikTokReviewWorkspace headerLink={headerLink} />
    </TikTokReviewGatewayProvider>
  );
}
