import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { XCircle, ArrowLeft } from "lucide-react";

export default function SubscriptionCancel() {
  const { t } = useTranslation("billing");
  const navigate = useNavigate();

  return (
    <DashboardLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <XCircle className="w-10 h-10 text-muted-foreground" />
        </div>
        
        <h1 className="text-3xl font-bold mb-2">{t("subscriptionCancel.title", "Subscription Canceled")}</h1>
        <p className="text-muted-foreground mb-8 max-w-md">
          {t("subscriptionCancel.desc", "No worries! Your checkout was canceled and you haven't been charged. You can upgrade to Pro anytime when you're ready.")}
        </p>

        <div className="flex gap-4">
          <Button variant="outline" onClick={() => navigate("/pricing")} className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            {t("subscriptionCancel.actions.backToPricing", "Back to Pricing")}
          </Button>
          <Button onClick={() => navigate("/dashboard")}>
            {t("subscriptionCancel.actions.goToDashboard", "Go to Dashboard")}
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
}
