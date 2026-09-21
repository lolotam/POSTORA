import { useTranslation } from "react-i18next";
import "@/i18n";
import { Badge } from "@/components/ui/badge";

export interface ResolvedTier {
  provider_code: string;
  model_id: string;
  name: string;
}

const TIER_KEYS = ["primary", "fallback", "fallback2"] as const;

/**
 * Shows which models a generation will use, in order, without letting the user
 * change them.
 *
 * Which model an organisation generates with is an administrative decision, so
 * the picker was removed. This exists so the person generating still knows what
 * is running rather than facing an unexplained black box.
 */
export function ResolvedModelCards({ tiers }: { tiers: ResolvedTier[] }) {
  const { t } = useTranslation("automation");

  if (tiers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("models.empty", "No image model has been configured yet. An administrator sets this in Admin › AI Configuration.")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {t("models.chosenByAdmin", "Models are chosen by your administrator. The first available one is used.")}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {tiers.slice(0, TIER_KEYS.length).map((tier, index) => (
          <div key={`${index}:${tier.provider_code}:${tier.model_id}`} className="rounded-lg border p-3">
            <Badge variant={index === 0 ? "default" : "secondary"} className="mb-1.5">
              {index === 0
                ? t("models.primary", "Primary")
                : index === 1
                ? t("models.fallback", "Fallback")
                : t("models.fallback2", "Fallback 2")}
            </Badge>
            <p className="truncate text-sm font-medium" title={tier.name}>
              {tier.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">{tier.provider_code}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
