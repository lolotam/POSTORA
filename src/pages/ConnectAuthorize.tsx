import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useOAuthConsent } from "@/hooks/useOAuthConsent";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Loader2, AlertTriangle } from "lucide-react";

export default function ConnectAuthorize() {
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const {
    clientInfo,
    scopes,
    isLoading,
    error,
    isApproving,
    handleApprove,
    handleDeny,
    validationError,
  } = useOAuthConsent();

  // If not logged in, save URL and redirect to auth
  useEffect(() => {
    if (!authLoading && !user) {
      sessionStorage.setItem("oauth_redirect_after_login", window.location.href);
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (validationError || error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-xl font-semibold">Authorization Error</h1>
            <p className="text-sm text-muted-foreground">
              {validationError || error}
            </p>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" onClick={() => window.history.back()}>
              Go Back
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Loading application details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4 pb-2">
          <div className="flex items-center justify-center gap-3">
            <h1 className="text-lg font-bold tracking-wide uppercase">
              {clientInfo?.name || "Application"}
            </h1>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary border overflow-hidden">
              {clientInfo?.icon ? (
                <img src={clientInfo.icon} alt={clientInfo.name} className="h-full w-full object-cover" />
              ) : (
                <Logo size="sm" showText={false} />
              )}
            </div>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            Authorized by you on{" "}
            {new Date().toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
            .
          </p>
        </CardHeader>

        <CardContent className="space-y-5 pt-4">
          {scopes.length > 0 ? (
            scopes.map((scope) => (
              <div key={scope.key} className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{scope.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {scope.description}
                  </p>
                </div>
                <div className="shrink-0 pt-0.5">
                  {scope.required ? (
                    <span className="text-xs text-muted-foreground">Required</span>
                  ) : (
                    <Switch checked disabled aria-label={`${scope.name} granted`} />
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Basic Access</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Permission to allow an app to read your profile info
                </p>
              </div>
              <span className="text-xs text-muted-foreground">Required</span>
            </div>
          )}

          <Separator className="my-2" />

          <p className="text-xs text-muted-foreground leading-relaxed">
            {clientInfo?.name || "This app"} uses your information to improve your experience. To
            learn more about how an app can use this information, please review the app's{" "}
            <Link to="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </CardContent>

        <CardFooter className="flex flex-col gap-3 pt-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={handleDeny}
            disabled={isApproving}
          >
            Close
          </Button>
          <Button className="w-full" onClick={handleApprove} disabled={isApproving}>
            {isApproving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin me-2" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
