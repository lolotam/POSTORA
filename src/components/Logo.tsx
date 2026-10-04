import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/hooks/useAppSettings";

interface LogoProps {
  className?: string;
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  animate?: boolean;
}

// Shimmer loading skeleton component
function LogoSkeleton({ size, showText, className }: { size: "sm" | "md" | "lg"; showText: boolean; className?: string }) {
  const sizes = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-14 h-14",
  };

  const textWidths = {
    sm: "w-16",
    md: "w-20",
    lg: "w-24",
  };

  const textHeights = {
    sm: "h-5",
    md: "h-6",
    lg: "h-7",
  };

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className={cn("rounded-xl overflow-hidden relative", sizes[size])}>
        <div className="absolute inset-0 bg-muted animate-pulse" />
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
      </div>
      {showText && (
        <div className={cn("rounded overflow-hidden relative", textWidths[size], textHeights[size])}>
          <div className="absolute inset-0 bg-muted animate-pulse" />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" style={{ animationDelay: "0.2s" }} />
        </div>
      )}
    </div>
  );
}

export function Logo({ className, size = "md", showText = true, animate = true }: LogoProps) {
  const { data: settings, isLoading } = useAppSettings();
  const [failedLogoSrc, setFailedLogoSrc] = useState<string | null>(null);

  const sizes = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-14 h-14",
  };

  const textSizes = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl",
  };

  // Show shimmer while loading
  if (isLoading) {
    return <LogoSkeleton size={size} showText={showText} className={className} />;
  }

  const appName = settings?.appName || "Postora";
  // Blank/whitespace URLs and URLs that already failed to load fall back to
  // the built-in mark, so a stale app_logo value never renders a broken image.
  const storedLogo = settings?.appLogo?.trim() || null;
  const appLogo = storedLogo && storedLogo !== failedLogoSrc ? storedLogo : null;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      {appLogo ? (
        <div
          className={cn(
            "relative transition-transform duration-200 hover:scale-105 active:scale-95",
            animate && "animate-scale-in",
            sizes[size]
          )}
        >
          <img
            src={appLogo}
            alt={`${appName} logo`}
            className="object-contain w-full h-full"
            width={size === "sm" ? 32 : size === "md" ? 40 : 56}
            height={size === "sm" ? 32 : size === "md" ? 40 : 56}
            decoding="async"
            draggable={false}
            onError={() => setFailedLogoSrc(appLogo)}
          />
        </div>
      ) : (
        <div
          className={cn(
            "relative rounded-xl p-0.5 transition-transform duration-200 hover:scale-105 active:scale-95 bg-primary",
            animate && "animate-scale-in",
            sizes[size]
          )}
        >
          <div className="relative h-full w-full rounded-[10px] bg-background flex items-center justify-center">
            <svg
              viewBox="0 24"
              className="w-1/2 h-1/2 text-primary"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </div>
        </div>
      )}
      {showText && (
        <span
          className={cn(
            "font-bold tracking-tight gradient-text",
            animate && "animate-fade-in",
            textSizes[size]
          )}
        >
          {appName}
        </span>
      )}
    </div>
  );
}
