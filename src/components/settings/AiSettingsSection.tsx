import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  Loader2,
} from "lucide-react";

interface AiSettingsSectionProps {
  aiModel: string;
  setAiModel: (model: string) => void;
  onSave: () => void;
  isSaving: boolean;
}

export function AiSettingsSection({
  aiModel,
  setAiModel,
  onSave,
  isSaving,
}: AiSettingsSectionProps) {
  const { t } = useTranslation("accounts");

  return (
    <div className="space-y-6">
      {/* AI Model Section */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">{t("ai.model.title", "AI Model")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("ai.model.subtitle", "Configure your AI model preferences")}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aiModel">{t("ai.model.label", "AI Model")}</Label>
            <Select value={aiModel} onValueChange={setAiModel}>
              <SelectTrigger className="w-full max-w-md">
                <SelectValue placeholder={t("ai.model.placeholder", "Select AI model")} />
              </SelectTrigger>
              <SelectContent className="bg-background border border-border z-50">
                <SelectItem value="google/gemini-2.5-flash">
                  <div className="flex flex-col">
                    <span className="font-medium">{t("ai.model.geminiFlash", "Gemini Flash")}</span>
                    <span className="text-xs text-muted-foreground">{t("ai.model.geminiFlashDesc", "Fast & balanced - recommended for most tasks")}</span>
                  </div>
                </SelectItem>
                <SelectItem value="google/gemini-3-pro-preview">
                  <div className="flex flex-col">
                    <span className="font-medium">{t("ai.model.geminiPro", "Gemini 3 Pro")}</span>
                    <span className="text-xs text-muted-foreground">{t("ai.model.geminiProDesc", "Advanced reasoning - best for complex captions")}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("ai.model.hint", "This model will be used for caption generation and AI features.")}
            </p>
          </div>

          {/* Save Button for AI settings */}
          <div className="flex justify-end pt-4">
            <Button
              variant="gradient"
              onClick={onSave}
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("common:saving", "Saving...")}
                </>
              ) : (
                t("common:saveChanges", "Save Changes")
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* AI Credits Section */}
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">{t("ai.credits.title", "AI Credits")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("ai.credits.subtitle", "Your AI usage and remaining credits")}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-secondary/50 border border-border">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">{t("ai.credits.usage", "Usage This Month")}</span>
              <a
                href="https://lovable.dev/settings"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                {t("ai.credits.viewLovable", "View in Lovable Dashboard →")}
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("ai.credits.managed", "AI credits are managed through your Lovable workspace. Visit your Lovable settings to view detailed usage, add credits, or upgrade your plan.")}
            </p>
            <div className="mt-3 flex gap-2">
              <a
                href="https://lovable.dev/settings"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  {t("ai.credits.manage", "Manage Credits")}
                </Button>
              </a>
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p>• <strong>{t("ai.credits.err401Label", "401 Error:")}</strong> {t("ai.credits.err401", "Session expired - re-login required")}</p>
            <p>• <strong>{t("ai.credits.err402Label", "402 Error:")}</strong> {t("ai.credits.err402", "Credits exhausted - add more credits")}</p>
            <p>• <strong>{t("ai.credits.err429Label", "429 Error:")}</strong> {t("ai.credits.err429", "Rate limited - wait and retry")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
