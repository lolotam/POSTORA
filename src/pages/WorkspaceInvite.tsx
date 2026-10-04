import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, MessageCircle } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useAcceptInvitation } from "@/hooks/useWhatsAppWorkspace";
import { WHATSAPP_WORKSPACE_STORAGE_KEY } from "@/components/whatsapp/WhatsAppWorkspaceProvider";

const INVITATION_FAILURE_MESSAGE = "This invitation is invalid or no longer available.";
const AUTH_RETURN_STORAGE_KEY = "oauth_redirect_after_login";

export default function WorkspaceInvite() {
  const { user, isLoading: authLoading } = useAuth();
  const { mutate: acceptInvitation } = useAcceptInvitation();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const attemptedToken = useRef<string>();
  const [failed, setFailed] = useState(false);
  const token = searchParams.get("token");

  useEffect(() => {
    if (authLoading || !token || attemptedToken.current === token) return;

    if (!user) {
      sessionStorage.setItem(AUTH_RETURN_STORAGE_KEY, `${location.pathname}${location.search}`);
      navigate("/auth", { replace: true });
      return;
    }

    attemptedToken.current = token;
    acceptInvitation(token, {
      onSuccess: (workspaceId) => {
        localStorage.setItem(WHATSAPP_WORKSPACE_STORAGE_KEY, workspaceId);
        navigate("/messaging/whatsapp", { replace: true });
      },
      onError: () => setFailed(true),
    });
  }, [acceptInvitation, authLoading, location.pathname, location.search, navigate, token, user]);

  const invalidInvitation = !token || failed;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10 bg-[#DCF8C6]/35 dark:bg-[#075E54]/30">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#25D366]/15 text-[#128C7E] dark:text-[#25D366]">
            <MessageCircle className="h-6 w-6" />
          </div>
          <CardTitle>WhatsApp workspace invitation</CardTitle>
        </CardHeader>
        <CardContent>
          {invalidInvitation ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Invitation unavailable</AlertTitle>
              <AlertDescription>{INVITATION_FAILURE_MESSAGE}</AlertDescription>
            </Alert>
          ) : (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {authLoading ? "Checking your account…" : user ? "Joining workspace…" : "Redirecting to sign in…"}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
