import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { TikTokReviewScreen } from "@/features/tiktok-publishing";

export default function TikTokPublish() {
  const { t } = useTranslation("post");
  return (
    <DashboardLayout noPadding hideFooter>
      <TikTokReviewScreen
        headerLink={(
          <Link className="tiktok-review-auth-link" to="/tiktok-auth">
            {t("tiktokReview.connectAccount", "Connect a TikTok account")}
          </Link>
        )}
      />
    </DashboardLayout>
  );
}
