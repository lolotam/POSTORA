import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

type RetentionChoice = "7" | "30" | "90" | "never";

const CHOICES: RetentionChoice[] = ["7", "30", "90", "never"];

function choiceFromDays(days: number | null | undefined): RetentionChoice {
  if (days === 7 || days === 30 || days === 90) return String(days) as RetentionChoice;
  if (days === null) return "never";
  return "30";
}

export function MediaRetentionSection() {
  const { t } = useTranslation("accounts");
  const { toast } = useToast();
  const { profile, refreshProfile, user } = useAuth();
  const [choice, setChoice] = useState<RetentionChoice>("30");
  const [isSaving, setIsSaving] = useState(false);
  const profileReady = profile != null;
  const savedDays = profile?.media_retention_days;

  useEffect(() => {
    if (!profileReady) return;
    setChoice(choiceFromDays(savedDays));
  }, [profileReady, savedDays]);

  const savedChoice = profileReady ? choiceFromDays(savedDays) : choice;

  const handleSave = async () => {
    if (!user) return;
    setIsSaving(true);
    try {
      const media_retention_days = choice === "never" ? null : Number(choice);
      const { error } = await supabase
        .from("profiles")
        .update({ media_retention_days })
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast({
        title: t("retention.toast.saved", "Media retention saved"),
        description: choice === "never"
          ? t("retention.toast.never", "Your library files are kept until you delete them.")
          : t("retention.toast.days", "Unused files are warned after {{count}} days.", { count: Number(choice) }),
      });
    } catch (error) {
      console.error("Media retention save error:", error);
      toast({
        title: t("retention.toast.failed", "Failed to save media retention"),
        description: t("retention.errors.generic", "An error occurred"),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Clock className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">{t("retention.header.title", "Media library retention")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("retention.header.subtitle", "Choose how long unused library files stay.")}
          </p>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="sr-only">{t("retention.header.title", "Media library retention")}</legend>
        {CHOICES.map((option) => (
          <label key={option} className="flex items-center gap-3 text-sm">
            <input
              type="radio"
              name="media-retention-days"
              value={option}
              checked={choice === option}
              onChange={() => setChoice(option)}
            />
            <span>
              {option === "never"
                ? t("retention.choices.never", "Never")
                : t("retention.choices.days", "{{count}} days", { count: Number(option) })}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4">
        <Button onClick={handleSave} disabled={isSaving || !user || choice === savedChoice}>
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
              {t("common:saving", "Saving...")}
            </>
          ) : (
            <>
              <Check className="w-4 h-4 me-2" />
              {t("retention.actions.save", "Save retention")}
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground mt-4">
        {t(
          "retention.hint",
          "You get a 7-day warning before a file is deleted, and you can keep it. Files that are in use are never deleted.",
        )}
      </p>
    </div>
  );
}
