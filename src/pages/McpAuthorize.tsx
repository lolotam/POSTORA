import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Loader2, AlertTriangle, Plug, ShieldCheck } from "lucide-react";

interface AuthorizationDetails {
  authorization_id: string;
  client: {
    client_id: string;
    client_name: string;
    client_uri?: string | null;
    logo_uri?: string | null;
  } | null;
  redirect_uri: string;
  scopes: string[];
  expires_at: string;
}

export const SCOPE_LABEL: Record<string, string> = {
  "accounts:read": "View your connected social media accounts",
  "posts:read": "Read your posts, media library, analytics, competitor reports, brand analysis, and run paid AI best-time suggestions",
  "posts:write": "Create, schedule, publish, and delete posts (including platform copies and media), sync analytics, track competitors, and run paid AI generation (captions, hashtags, and images; post creation and image generation also require media:write)",
  "media:write": "Upload and store media in your Postora library",
  "webhooks:manage": "Register and manage webhook subscriptions",
};

function functionUrl(path: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/mcp-oauth${path}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function McpAuthorize() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();

  const authorizationId = params.get("authorization_id") ?? "";

  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  // Redirect to sign-in if needed
  useEffect(() => {
    if (!authLoading && !user) {
      sessionStorage.setItem("oauth_redirect_after_login", window.location.href);
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  // Load authorization details
  useEffect(() => {
    if (!user) return;
    if (!authorizationId) {
      setError("Missing authorization_id parameter. The MCP client must start the OAuth flow.");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const headers = await authHeaders();
        const res = await fetch(functionUrl(`/authorization/${authorizationId}`), { headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_description || data.error || "Failed to load authorization");
        setDetails(data);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, authorizationId]);

  const handleDecision = async (approve: boolean) => {
    if (!details) return;
    setSubmitting(approve ? "approve" : "deny");
    try {
      const headers = await authHeaders();
      const res = await fetch(functionUrl("/consent"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ authorization_id: details.authorization_id, approve }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.error || "Failed");
      if (data.redirect_to) {
        window.location.href = data.redirect_to;
      }
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-xl font-semibold">Authorization error</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" onClick={() => navigate("/dashboard")}>Back to dashboard</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (!details) return null;

  const clientName = details.client?.client_name ?? "An MCP application";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4 text-center">
          <div className="flex items-center justify-center gap-3">
            {details.client?.logo_uri ? (
              <img src={details.client.logo_uri} alt="" className="h-10 w-10 rounded-md" />
            ) : (
              <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center">
                <Plug className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
            <span className="text-muted-foreground">↔</span>
            <Logo className="h-10 w-10" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{clientName} wants to access your Postora account</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Signed in as {user?.email}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> This will allow it to:
          </p>
          <ul className="space-y-2">
            {details.scopes.map((s) => (
              <li key={s} className="text-sm flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                <span>{SCOPE_LABEL[s] ?? s}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground pt-2">
            You can revoke access at any time from Settings → Connected MCP clients.
          </p>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleDecision(false)}
            disabled={submitting !== null}
          >
            {submitting === "deny" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Deny"}
          </Button>
          <Button
            className="flex-1"
            onClick={() => handleDecision(true)}
            disabled={submitting !== null}
          >
            {submitting === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Authorize"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}