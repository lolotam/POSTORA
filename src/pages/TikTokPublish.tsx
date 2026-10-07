import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { TikTokReviewScreen } from "@/features/tiktok-publishing";

export default function TikTokPublish() {
  const { t } = useTranslation("post");
  return (
    <DashboardLayout noPadding hideFooter>
      <TikTokReviewScreen
        headerLink={(
          <Button asChild className="w-full">
            <Link to="/tiktok-auth">
              <Plus className="h-4 w-4" />
              {t("tiktokReview.connectAccount", "Connect a TikTok account")}
            </Link>
          </Button>
        )}
      />
    </DashboardLayout>
  );
}
