import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { isReviewPathAllowed, REVIEW_HOME_PATH } from "../../domain/shellRoutes";
import { TikTokReviewProvider } from "../TikTokReviewScreen";
import { ReviewShell } from "./ReviewShell";
import { useShellMode, useShellTheme } from "./useShellMode";

function ShellLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  );
}

interface ShellGateProps {
  /** The existing dashboard chrome, rendered unchanged for admins. */
  legacy: ReactNode;
  children: ReactNode;
  fill?: boolean;
}

/** Picks the dashboard chrome for the signed-in user and keeps non-admins on review routes. */
export function ShellGate({ legacy, children, fill }: ShellGateProps) {
  const mode = useShellMode();
  const location = useLocation();
  useShellTheme(mode);

  if (mode === "admin") return <>{legacy}</>;
  if (mode === "loading") return <ShellLoading />;
  if (!isReviewPathAllowed(location.pathname)) return <Navigate to={REVIEW_HOME_PATH} replace />;

  return (
    <TikTokReviewProvider>
      <ReviewShell fill={fill}>{children}</ReviewShell>
    </TikTokReviewProvider>
  );
}

/** Routes that render a different page for review users than for admins (e.g. /calendar). */
export function ByShell({ review, admin }: { review: ReactNode; admin: ReactNode }) {
  const mode = useShellMode();
  if (mode === "loading") return <ShellLoading />;
  return <>{mode === "review" ? review : admin}</>;
}
