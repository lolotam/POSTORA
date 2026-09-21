import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { decodeOAuthState, type PinterestOAuthState } from "@/lib/oauthState";
import { Loader2, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const PINTEREST_PRODUCTION_ORIGIN = "https://postora.cloud";
const PINTEREST_REDIRECT_URI = `${PINTEREST_PRODUCTION_ORIGIN}/oauth/pinterest/callback`;

export default function PinterestCallback() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isWorking, setIsWorking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");

  const decodedState = useMemo(() => {
    if (!stateParam) return null;
    return decodeOAuthState<PinterestOAuthState>(stateParam);
  }, [stateParam]);

  // Check if we're on a preview URL (not production)
  const isPreviewUrl = useMemo(() => {
    const hostname = window.location.hostname;
    return hostname !== "postora.cloud" && hostname !== "www.postora.cloud";
  }, []);

  useEffect(() => {
    document.title = "Pinterest OAuth Callback | Postora";
  }, []);

  useEffect(() => {
    const run = async () => {
      if (!user) return;

      if (!code) {
        setError("Missing authorization code from Pinterest.");
        toast({
          title: "Pinterest connection failed",
          description: "Missing authorization code from Pinterest.",
          variant: "destructive",
        });
        setIsWorking(false);
        return;
      }

      if (!decodedState?.user_id || !decodedState?.social_profile_id) {
        setError("Missing or invalid OAuth state.");
        toast({
          title: "Pinterest connection failed",
          description: "Missing or invalid OAuth state.",
          variant: "destructive",
        });
        setIsWorking(false);
        return;
      }

      if (decodedState.user_id !== user.id) {
        setError("OAuth state does not match the signed-in user.");
        toast({
          title: "Pinterest connection failed",
          description: "OAuth state does not match the signed-in user.",
          variant: "destructive",
        });
        setIsWorking(false);
        return;
      }

      try {
        const { data, error } = await supabase.functions.invoke("pinterest-oauth", {
          body: {
            action: "callback",
            code,
            redirect_uri: PINTEREST_REDIRECT_URI,
            user_id: user.id,
            social_profile_id: decodedState.social_profile_id,
          },
        });

        if (error) throw error;
        if (!data?.success) throw new Error(data?.error || "Failed to connect Pinterest");

        navigate("/profiles?connected=pinterest", { replace: true });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : "Failed to connect Pinterest";
        setError(errorMessage);
        toast({
          title: "Pinterest connection failed",
          description: errorMessage,
          variant: "destructive",
        });
      } finally {
        setIsWorking(false);
      }
    };

    run();
  }, [user, code, decodedState, navigate, toast]);

  // Show error state with helpful guidance
  if (error) {
    return (
      <main className="min-h-[60vh] grid place-items-center px-6">
        <section className="w-full max-w-md rounded-xl border border-destructive/50 bg-card p-6 text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold">Pinterest Connection Failed</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
          
          {isPreviewUrl && (
            <div className="mt-4 p-4 rounded-lg bg-muted/50 border border-border text-start space-y-3">
              <p className="text-sm font-medium">Are you on a preview URL?</p>
              <p className="text-xs text-muted-foreground">
                Pinterest OAuth requires connecting from the production site. 
                Please try connecting your Pinterest account from:
              </p>
              <a
                href="https://postora.cloud/profiles"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
              >
                postora.cloud/profiles
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          
          <div className="flex gap-3 justify-center pt-2">
            <Button variant="outline" onClick={() => navigate("/profiles", { replace: true })}>
              Back to Profiles
            </Button>
            {!isPreviewUrl && (
              <Button onClick={() => window.location.reload()}>
                Try Again
              </Button>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-[60vh] grid place-items-center px-6">
      <section className="w-full max-w-md rounded-xl border border-border bg-card/50 p-6 text-center">
        <h1 className="text-lg font-semibold">Connecting Pinterest…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Please keep this tab open while we finish the connection.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Connecting</span>
        </div>
        {!isWorking && (
          <p className="mt-4 text-xs text-muted-foreground">Redirecting…</p>
        )}
      </section>
    </main>
  );
}
