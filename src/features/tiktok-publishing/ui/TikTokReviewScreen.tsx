import { useMemo, type ReactNode } from "react";
import { createSupabaseReviewGateway } from "../infrastructure/supabaseReviewGateway";
import { createSupabaseConnectionGateway } from "../infrastructure/supabaseConnectionGateway";
import { createSupabaseMediaUploader } from "../infrastructure/supabaseMediaUploader";
import { TikTokReviewGatewayProvider } from "../application/ports";
import { TikTokConnectionProvider } from "../application/connectionPort";
import { TikTokMediaUploaderProvider } from "../application/mediaUploadPort";
import { TikTokReviewWorkspace } from "./TikTokReviewWorkspace";
import "./tiktokReview.css";

/** Composition root: the only ui/ file that wires the Supabase adapters into the ports. */
export function TikTokReviewProvider({ children }: { children: ReactNode }) {
  const gateway = useMemo(() => createSupabaseReviewGateway(), []);
  const connection = useMemo(() => createSupabaseConnectionGateway(), []);
  const uploader = useMemo(() => createSupabaseMediaUploader(), []);
  return (
    <TikTokReviewGatewayProvider gateway={gateway}>
      <TikTokConnectionProvider gateway={connection}>
        <TikTokMediaUploaderProvider uploader={uploader}>{children}</TikTokMediaUploaderProvider>
      </TikTokConnectionProvider>
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
