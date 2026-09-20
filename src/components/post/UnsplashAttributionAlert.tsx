import { AlertCircle, Camera, CheckCircle2, ExternalLink } from "lucide-react";
import { useTranslation, Trans } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { UnsplashAttributionData } from "@/lib/unsplashAttribution";

interface UnsplashAttributionAlertProps {
  attribution: UnsplashAttributionData;
  hasValidAttribution: boolean;
  className?: string;
}

/**
 * Alert component that displays when Unsplash images are selected.
 * Shows attribution requirements and validation status.
 */
export function UnsplashAttributionAlert({
  attribution,
  hasValidAttribution,
  className,
}: UnsplashAttributionAlertProps) {
  const { t } = useTranslation("postmedia");

  if (!attribution) return null;

  return (
    <Alert
      variant={hasValidAttribution ? "default" : "destructive"}
      className={cn(
        "border-l-4",
        hasValidAttribution 
          ? "border-l-green-500 bg-green-50/50 dark:bg-green-950/20" 
          : "border-l-orange-500 bg-orange-50/50 dark:bg-orange-950/20",
        className
      )}
    >
      <div className="flex items-start gap-3">
        {hasValidAttribution ? (
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="h-5 w-5 text-orange-600 dark:text-orange-400 mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <AlertTitle className={cn(
            "text-sm font-semibold mb-1",
            hasValidAttribution 
              ? "text-green-800 dark:text-green-200" 
              : "text-orange-800 dark:text-orange-200"
          )}>
            {hasValidAttribution ? t("unsplashAlert.titleAdded", "Attribution Added") : t("unsplashAlert.titleRequired", "Attribution Required")}
          </AlertTitle>
          <AlertDescription className="text-sm">
            {hasValidAttribution ? (
              <span className="text-green-700 dark:text-green-300">
                <Trans
                  ns="postmedia"
                  i18nKey="unsplashAlert.validCaption"
                  values={{ name: attribution.photographerName }}
                  components={{
                    1: (
                      <a
                        href={attribution.photographerProfileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline hover:no-underline inline-flex items-center gap-1"
                      >
                        {attribution.photographerName}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ),
                  }}
                >
                  Your caption includes proper credit to{" "}
                  <a
                    href={attribution.photographerProfileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:no-underline inline-flex items-center gap-1"
                  >
                    {attribution.photographerName}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  {" "}on Unsplash.
                </Trans>
              </span>
            ) : (
              <div className="space-y-2">
                <p className="text-orange-700 dark:text-orange-300">
                  {t("unsplashAlert.requiredNotice", "Using Unsplash images requires crediting the photographer in your post text. Please keep the attribution at the end of your caption.")}
                </p>
                <div className="flex items-center gap-2 text-xs text-orange-600 dark:text-orange-400 bg-orange-100/50 dark:bg-orange-900/30 rounded-md px-2 py-1.5">
                  <Camera className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono">
                    {t("unsplashAlert.format", "Photo by {{name}} on Unsplash", { name: attribution.photographerName })}
                  </span>
                </div>
              </div>
            )}
          </AlertDescription>
        </div>
      </div>
    </Alert>
  );
}

/**
 * Compact inline version for tight spaces
 */
export function UnsplashAttributionBadge({
  photographerName,
  isValid,
  className,
}: {
  photographerName: string;
  isValid: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium",
        isValid
          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
        className
      )}
    >
      {isValid ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      <Camera className="h-3 w-3" />
      <span>{photographerName}</span>
    </div>
  );
}
