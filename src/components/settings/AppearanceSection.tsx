import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Palette,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";

export function AppearanceSection() {
  const { t } = useTranslation("accounts");
  const { theme, setTheme } = useTheme();

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Palette className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">{t("appearance.header.title", "Appearance")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("appearance.header.subtitle", "Customize how Postora looks")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("appearance.form.theme", "Theme")}</label>
          <Select value={theme} onValueChange={setTheme}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder={t("appearance.form.placeholder", "Select theme")} />
            </SelectTrigger>
            <SelectContent className="bg-background border border-border z-50">
              <SelectItem value="light">
                <div className="flex items-center gap-2">
                  <Sun className="w-4 h-4" />
                  <span>{t("appearance.form.light", "Light")}</span>
                </div>
              </SelectItem>
              <SelectItem value="dark">
                <div className="flex items-center gap-2">
                  <Moon className="w-4 h-4" />
                  <span>{t("appearance.form.dark", "Dark")}</span>
                </div>
              </SelectItem>
              <SelectItem value="system">
                <div className="flex items-center gap-2">
                  <Monitor className="w-4 h-4" />
                  <span>{t("appearance.form.system", "System")}</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("appearance.form.hint", "Choose your preferred color scheme")}
          </p>
        </div>
      </div>
    </div>
  );
}
