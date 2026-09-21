import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { TimezoneSelector } from "@/components/post/TimezoneSelector";
import {
  Globe,
  Loader2,
  Check,
} from "lucide-react";

interface TimezoneSectionProps {
  preferredTimezone: string;
  setPreferredTimezone: (tz: string) => void;
}

export function TimezoneSection({
  preferredTimezone,
  setPreferredTimezone,
}: TimezoneSectionProps) {
  const { t } = useTranslation("accounts");
  const { toast } = useToast();
  const { profile, refreshProfile, user } = useAuth();
  const [isSavingTimezone, setIsSavingTimezone] = useState(false);

  const handleSaveTimezone = async () => {
    if (!user) return;

    setIsSavingTimezone(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ preferred_timezone: preferredTimezone || null })
        .eq("id", user.id);

      if (error) throw error;

      await refreshProfile();

      toast({
        title: t("timezone.toast.saved", "Timezone saved"),
        description: preferredTimezone
          ? t("timezone.toast.savedDesc", "Your preferred timezone is now {{timezone}}.", { timezone: preferredTimezone })
          : t("timezone.toast.cleared", "Timezone preference has been cleared."),
      });
    } catch (error) {
      console.error("Timezone save error:", error);
      toast({
        title: t("timezone.toast.failed", "Failed to save timezone"),
        description: error instanceof Error ? error.message : t("timezone.errors.generic", "An error occurred"),
        variant: "destructive",
      });
    } finally {
      setIsSavingTimezone(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">{t("timezone.header.title", "Timezone Preferences")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("timezone.header.subtitle", "Set your preferred timezone for scheduling posts")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <TimezoneSelector
          value={preferredTimezone}
          onChange={setPreferredTimezone}
        />

        <div className="flex items-center gap-3">
          <Button
            onClick={handleSaveTimezone}
            disabled={isSavingTimezone || preferredTimezone === (profile?.preferred_timezone || "")}
          >
            {isSavingTimezone ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("common:saving", "Saving...")}
              </>
            ) : (
              <>
                <Check className="w-4 h-4 me-2" />
                {t("timezone.actions.save", "Save Timezone")}
              </>
            )}
          </Button>
          {preferredTimezone && (
            <Button
              variant="ghost"
              onClick={() => setPreferredTimezone("")}
            >
              {t("common:clear", "Clear")}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {t("timezone.hint", "This timezone will be automatically selected when scheduling new posts.")}
        </p>
      </div>
    </div>
  );
}
