import { Platform } from "@/lib/types";
import { useTranslation } from "react-i18next";
import { ValidationResult } from "@/lib/imageUtils";
import { AlertCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface MediaValidationProps {
  validation: ValidationResult | null;
  className?: string;
}

export function MediaValidation({ validation, className }: MediaValidationProps) {
  const { t } = useTranslation("postmedia");

  if (!validation) return null;

  const hasErrors = validation.errors.length > 0;
  const hasWarnings = validation.warnings.length > 0;

  if (!hasErrors && !hasWarnings) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-emerald-500", className)}>
        <CheckCircle2 className="w-4 h-4" />
        <span>{t("validation.allCompatible", "Media is compatible with all selected platforms")}</span>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {hasErrors && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
          <div className="flex items-center gap-2 text-destructive font-medium text-sm mb-2">
            <AlertCircle className="w-4 h-4" />
            <span>{t("validation.issuesTitle", "Compatibility Issues")}</span>
          </div>
          <ul className="space-y-1">
            {validation.errors.map((error, index) => (
              <li key={index} className="text-xs text-destructive/80 ps-6">
                • {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasWarnings && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <div className="flex items-center gap-2 text-amber-500 font-medium text-sm mb-2">
            <AlertTriangle className="w-4 h-4" />
            <span>{t("validation.suggestionsTitle", "Optimization Suggestions")}</span>
          </div>
          <ul className="space-y-1">
            {validation.warnings.map((warning, index) => (
              <li key={index} className="text-xs text-amber-500/80 ps-6">
                • {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
