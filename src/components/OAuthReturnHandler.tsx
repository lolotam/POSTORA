import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  higgsfieldCallbackRescuePath,
  shouldForwardSocialOAuthToProfiles,
} from "@/lib/higgsfieldOAuthReturn";

/**
 * Handles OAuth redirects and ensures logged-in users are directed to the dashboard.
 * - Redirects authenticated users from landing page to dashboard
 * - Handles Facebook OAuth callback storage
 * - Forwards Instagram-style code+state returns to /profiles
 * - Must not intercept Higgsfield (Clerk) callbacks
 */
export function OAuthReturnHandler() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;
    if (!user) return;

    const params = new URLSearchParams(location.search);

    const higgsfieldRescue = higgsfieldCallbackRescuePath(location.pathname, params);
    if (higgsfieldRescue) {
      navigate(higgsfieldRescue, { replace: true });
      return;
    }

    // Check for pending Facebook OAuth flow
    const hasPendingFacebook =
      !!localStorage.getItem("fb_oauth_profile_id") &&
      !!localStorage.getItem("fb_oauth_platform");

    if (hasPendingFacebook && location.pathname !== "/profiles") {
      navigate("/profiles", { replace: true });
      return;
    }

    if (shouldForwardSocialOAuthToProfiles(location.pathname, params)) {
      navigate("/profiles" + location.search, { replace: true });
      return;
    }

    // Redirect logged-in users from landing page or auth page to dashboard
    const publicPaths = ["/", "/auth"];
    if (publicPaths.includes(location.pathname)) {
      navigate("/dashboard", { replace: true });
    }
  }, [isLoading, user, location.pathname, location.search, navigate]);

  return null;
}
