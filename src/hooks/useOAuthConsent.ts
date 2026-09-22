import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

// No user id is passed: log_system_event takes the actor from the caller's JWT
// and refuses any other service, so a caller cannot attribute an event to
// someone else. It also means this only records while signed in — which is the
// only state the consent screen is reachable in.
async function logOAuthEvent(
  level: "info" | "error",
  message: string,
  details: Record<string, any>
) {
  try {
    await supabase.rpc("log_system_event", {
      p_level: level,
      p_service: "oauth-consent",
      p_message: message,
      p_details: details,
    });
  } catch (e) {
    console.error("Failed to log OAuth event:", e);
  }
}

export interface OAuthClientInfo {
  id: string;
  name: string;
  icon?: string;
}

export interface OAuthScope {
  key: string;
  name: string;
  description: string;
  required: boolean;
}

const SCOPE_META: Record<string, { name: string; description: string; required?: boolean }> = {
  openid: {
    name: "Basic Access",
    description: "Permission to allow an app to read your profile info",
    required: true,
  },
  email: {
    name: "Email Address",
    description: "Permission to allow an app to read your email address",
  },
  profile: {
    name: "Profile Info",
    description: "Permission to allow an app to read your Postora profile information",
  },
  phone: {
    name: "Phone Number",
    description: "Permission to allow an app to read your phone number",
  },
};

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function useOAuthConsent() {
  const [searchParams] = useSearchParams();
  const [clientInfo, setClientInfo] = useState<OAuthClientInfo | null>(null);
  const [scopes, setScopes] = useState<OAuthScope[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);

  const authorizationId = searchParams.get("authorization_id") || "";

  // Validate required param
  const validationError = !authorizationId
    ? "Missing authorization_id parameter. The OAuth flow must start from the third-party application."
    : null;

  // Fetch authorization details from Supabase
  useEffect(() => {
    if (validationError) {
      setError(validationError);
      setIsLoading(false);
      return;
    }

    async function fetchAuthorizationDetails() {
      try {
        const result = await (supabase.auth as any).oauth.getAuthorizationDetails(authorizationId);

        if (result.error) {
          throw new Error(result.error.message || "Failed to get authorization details");
        }

        const data = result.data;

        // If it's a redirect (user already consented), redirect immediately
        if (data?.redirect_to) {
          window.location.href = data.redirect_to;
          return;
        }

        // Extract client info and scopes from the authorization details
        setClientInfo({
          id: data?.client?.id || "",
          name: data?.client?.name || "Unknown Application",
          icon: data?.client?.icon,
        });

        // Parse scopes
        const scopeList: OAuthScope[] = (data?.scopes || []).map((s: string) => {
          const meta = SCOPE_META[s];
          return {
            key: s,
            name: meta?.name || titleCase(s),
            description:
              meta?.description || `Permission to allow an app to access your ${s}`,
            required: meta?.required === true,
          };
        });
        setScopes(scopeList);
      } catch (err: any) {
        await logOAuthEvent("error", "OAuth authorization details fetch failed", {
          authorization_id: authorizationId,
          error: err.message,
        });
        setError(err.message || "Failed to load authorization details");
      } finally {
        setIsLoading(false);
      }
    }

    fetchAuthorizationDetails();
  }, [authorizationId, validationError]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      const result = await (supabase.auth as any).oauth.approveAuthorization(authorizationId);

      if (result.error) {
        throw new Error(result.error.message || "Authorization failed");
      }

      // Log successful approval
      await logOAuthEvent("info", "OAuth authorization approved", {
        authorization_id: authorizationId,
        client_name: clientInfo?.name,
        scopes: scopes.map(s => s.key),
      });

      // Redirect to the URL provided by Supabase (contains auth code for the third-party app)
      if (result.data?.redirect_to) {
        window.location.href = result.data.redirect_to;
      } else {
        throw new Error("No redirect URL returned from authorization server");
      }
    } catch (err: any) {
      await logOAuthEvent("error", "OAuth authorization approval failed", {
        authorization_id: authorizationId,
        client_name: clientInfo?.name,
        error: err.message,
      });
      setError(err.message || "Authorization failed");
      setIsApproving(false);
    }
  };

  const handleDeny = async () => {
    try {
      // Log denial
      await logOAuthEvent("info", "OAuth authorization denied", {
        authorization_id: authorizationId,
        client_name: clientInfo?.name,
      });

      const result = await (supabase.auth as any).oauth.denyAuthorization(authorizationId);

      if (result.data?.redirect_to) {
        window.location.href = result.data.redirect_to;
      } else {
        // Fallback: go back
        window.history.back();
      }
    } catch (err: any) {
      // If deny API fails, just go back
      console.error("Deny failed:", err);
      window.history.back();
    }
  };

  return {
    clientInfo,
    scopes,
    isLoading,
    error,
    isApproving,
    handleApprove,
    handleDeny,
    validationError,
  };
}
