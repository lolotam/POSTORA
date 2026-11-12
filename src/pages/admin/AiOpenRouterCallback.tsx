import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { useFinishAiOAuth } from "@/hooks/ai-config/useAiProviderAuth";

/** Where the admin lands once the subscription is connected. */
const SETTINGS_AI_TAB = "/admin/settings?tab=ai";

type Phase = "working" | "success" | "error";

/**
 * The route OpenRouter redirects to after the admin approved the sign-in.
 *
 * The redirect is read from the address bar itself rather than from the router:
 * the finish call hands the whole address to the edge function, which pulls the
 * authorization code and the state out of it, so both must come from the same
 * place.
 *
 * The credentials never reach the browser: the edge function exchanges the
 * code and keeps the key in Vault.
 */
export function AiOpenRouterCallbackPanel() {
  const finishLogin = useFinishAiOAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("working");
  const [message, setMessage] = useState("Connecting OpenRouter…");

  useEffect(() => {
    // React runs an effect twice in development, and the authorization code is
    // single use: the second attempt would spend it and fail the login.
    if (started.current) return;
    started.current = true;

    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) {
      setPhase("error");
      setMessage("The redirect carried no login code. Start the sign-in again.");
      return;
    }

    void finishLogin
      .mutateAsync({ provider: "openrouter", pasted: window.location.href })
      .then(() => {
        setPhase("success");
        setMessage("OpenRouter is connected.");
        toast.success("OpenRouter connected");
        window.setTimeout(() => navigate(SETTINGS_AI_TAB, { replace: true }), 900);
      })
      .catch((error) => {
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Could not connect OpenRouter.");
      });
  }, [finishLogin, navigate]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border p-8 text-center">
        {phase === "working" ? (
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
        ) : phase === "success" ? (
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
        ) : (
          <XCircle className="mx-auto h-10 w-10 text-destructive" />
        )}
        <h1 className="font-semibold">
          {phase === "success"
            ? "OpenRouter connected"
            : phase === "error"
              ? "Connection failed"
              : "Connecting OpenRouter"}
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        {phase === "error" && (
          <Button asChild>
            <Link to={SETTINGS_AI_TAB}>Back to the AI settings</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** The admin guard: a non-admin never sees this route. */
export default function AdminAiOpenRouterCallback() {
  return (
    <AdminLayout>
      <AiOpenRouterCallbackPanel />
    </AdminLayout>
  );
}
