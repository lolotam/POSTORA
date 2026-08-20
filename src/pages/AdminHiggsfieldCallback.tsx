import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
type Phase = "working" | "success" | "error";
export default function AdminHiggsfieldCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("working");
  const [message, setMessage] = useState("Completing the Higgsfield connection…");
  const destination = params.get("return_to") || "/settings";
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code"),
      state = params.get("state"),
      oauthError = params.get("error");
    if (oauthError || !code || !state) {
      setPhase("error");
      setMessage(oauthError || "The Higgsfield redirect was incomplete.");
      return;
    }
    void supabase.functions
      .invoke("higgsfield-oauth", { body: { action: "callback", code, state } })
      .then(({ data, error }) => {
        if (error || data?.error) throw error ?? new Error(data.error);
        setPhase("success");
        setMessage("Higgsfield is connected.");
        window.setTimeout(() => navigate(destination, { replace: true }), 900);
      })
      .catch((error) => {
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Could not complete the connection.");
      });
  }, [params, navigate, destination]);
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
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
            ? "Higgsfield connected"
            : phase === "error"
              ? "Connection failed"
              : "Connecting Higgsfield"}
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        {phase === "error" && (
          <Button asChild>
            <Link to={destination}>Back to settings</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
