import { Camera } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface UnsplashAttributionProps {
  photographerName: string;
  photographerUrl: string;
  unsplashUrl: string;
  className?: string;
  variant?: "inline" | "overlay" | "card";
}

/**
 * Unsplash Attribution Component
 * Displays proper attribution as required by Unsplash API guidelines:
 * "Photo by [Photographer Name] on Unsplash"
 * with clickable links including UTM parameters
 */
export function UnsplashAttribution({
  photographerName,
  photographerUrl,
  unsplashUrl,
  className,
  variant = "inline",
}: UnsplashAttributionProps) {
  useTranslation("postmedia");

  if (variant === "overlay") {
    return (
      <div
        className={cn(
          "absolute bottom-0 start-0 end-0 p-2 bg-gradient-to-t from-black/70 to-transparent",
          className
        )}
      >
        <p className="text-[10px] text-white/90 flex items-center gap-1">
          <Camera className="w-3 h-3" />
          <Trans
            ns="postmedia"
            i18nKey="unsplash.attribution"
            values={{ photographerName }}
            components={{
              1: (
                <a
                  href={photographerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-white font-medium"
                  onClick={(e) => e.stopPropagation()}
                />
              ),
              2: (
                <a
                  href={unsplashUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-white font-medium"
                  onClick={(e) => e.stopPropagation()}
                />
              ),
            }}
          >
            Photo by{" "}
            <a
              href={photographerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              {photographerName}
            </a>
            {" "}on{" "}
            <a
              href={unsplashUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              Unsplash
            </a>
          </Trans>
        </p>
      </div>
    );
  }

  if (variant === "card") {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1",
          className
        )}
      >
        <Camera className="w-3 h-3" />
        <span>
          <Trans
            ns="postmedia"
            i18nKey="unsplash.attribution"
            values={{ photographerName }}
            components={{
              1: (
                <a
                  href={photographerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground font-medium"
                />
              ),
              2: (
                <a
                  href={unsplashUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground font-medium"
                />
              ),
            }}
          >
            Photo by{" "}
            <a
              href={photographerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground font-medium"
            >
              {photographerName}
            </a>
            {" "}on{" "}
            <a
              href={unsplashUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground font-medium"
            >
              Unsplash
            </a>
          </Trans>
        </span>
      </div>
    );
  }

  // Default inline variant
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <Trans
        ns="postmedia"
        i18nKey="unsplash.attribution"
        values={{ photographerName }}
        components={{
          1: (
            <a
              href={photographerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            />
          ),
          2: (
            <a
              href={unsplashUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            />
          ),
        }}
      >
        Photo by{" "}
        <a
          href={photographerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          {photographerName}
        </a>
        {" "}on{" "}
        <a
          href={unsplashUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Unsplash
        </a>
      </Trans>
    </span>
  );
}
