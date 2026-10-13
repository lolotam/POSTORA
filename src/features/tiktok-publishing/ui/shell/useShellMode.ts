import { useLayoutEffect } from "react";
import { TIKTOK_REVIEW_MODE } from "@/config/tiktokReviewMode";
import { useUserRole } from "@/hooks/useUserRole";

export type ShellMode = "loading" | "review" | "admin";

/** Which chrome the signed-in user gets in the TikTok review build: non-admins get the review shell. */
export function useShellMode(): ShellMode {
  const { isAdmin, isLoading } = useUserRole();
  return !TIKTOK_REVIEW_MODE || isAdmin ? "admin" : isLoading ? "loading" : "review";
}

/**
 * Carries the review theme to portalled popovers and dialogs through <html data-shell="review">,
 * and removes it again when the shell unmounts (sign-out, public pages). A layout effect keeps
 * page-to-page navigation from flashing the admin theme.
 */
export function useShellTheme(mode: ShellMode): void {
  useLayoutEffect(() => {
    if (mode !== "review") return;
    const root = document.documentElement;
    root.dataset.shell = "review";
    return () => {
      delete root.dataset.shell;
    };
  }, [mode]);
}
