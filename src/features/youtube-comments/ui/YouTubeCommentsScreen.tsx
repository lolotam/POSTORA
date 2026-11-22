import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { YouTubeCommentsGateway } from "../application/ports";
import { defaultYouTubeCommentsGateway } from "../infrastructure/supabaseYouTubeCommentsGateway";

export interface YouTubeCommentsScreenProps {
  accountId: string | null;
  gateway?: YouTubeCommentsGateway;
}

export function YouTubeCommentsScreen(props: YouTubeCommentsScreenProps): JSX.Element {
  const { accountId, gateway = defaultYouTubeCommentsGateway } = props;
  const { t } = useTranslation("automation");
  const [status, setStatus] = useState<string | null>(null);

  if (!accountId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          {t("empty.noYoutube", "No YouTube channels connected")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-8 text-center">
        <p className="font-medium">{t("header.commentsManager", "Comments")}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("empty.noCommentsHint", "Stage 4 capabilities are controlled by the server rollout.")}
        </p>
        {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
        <Button className="mt-4" variant="outline" onClick={() => setStatus("ready")} size="sm">
          {t("common:refresh", "Refresh")}
        </Button>
      </CardContent>
    </Card>
  );
}
