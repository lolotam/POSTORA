import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, KeyRound, Send, Clock, CheckCircle, XCircle } from "lucide-react";

interface OAuthApp {
  id: string;
  name: string;
  description: string | null;
}

interface RedirectRequest {
  id: string;
  oauth_app_id: string;
  redirect_uri: string;
  status: string;
  admin_note: string | null;
  created_at: string;
}

export function RedirectUriRequestSection() {
  const { t } = useTranslation("accounts");
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedAppId, setSelectedAppId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  const { data: apps, isLoading: appsLoading } = useQuery({
    queryKey: ["oauth-apps-public"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("oauth_apps")
        .select("id, name, description")
        .eq("is_active", true);
      if (error) throw error;
      return data as OAuthApp[];
    },
  });

  const { data: requests, isLoading: requestsLoading } = useQuery({
    queryKey: ["my-redirect-requests"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("oauth_redirect_requests")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as RedirectRequest[];
    },
    enabled: !!user,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error(t("redirect.errors.notAuth", "Not authenticated"));
      const { error } = await (supabase as any)
        .from("oauth_redirect_requests")
        .insert({
          user_id: user.id,
          oauth_app_id: selectedAppId,
          redirect_uri: redirectUri,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-redirect-requests"] });
      setRedirectUri("");
      setSelectedAppId("");
      toast({ title: t("redirect.toast.submitted", "Request submitted"), description: t("redirect.toast.submittedDesc", "An admin will review your redirect URI request.") });
    },
    onError: (e: Error) => {
      toast({ title: t("common:error", "Error"), description: e.message, variant: "destructive" });
    },
  });

  const getAppName = (appId: string) => apps?.find((a) => a.id === appId)?.name || t("common:unknown", "Unknown");

  const statusLabel = (status: string) => {
    if (status === "pending") return t("common:status.pending", "Pending");
    if (status === "approved") return t("redirect.status.approved", "Approved");
    if (status === "rejected") return t("redirect.status.rejected", "Rejected");
    return status;
  };

  const statusConfig: Record<string, { icon: React.ReactNode; variant: "default" | "secondary" | "destructive" }> = {
    pending: { icon: <Clock className="h-3 w-3" />, variant: "secondary" },
    approved: { icon: <CheckCircle className="h-3 w-3" />, variant: "default" },
    rejected: { icon: <XCircle className="h-3 w-3" />, variant: "destructive" },
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          <CardTitle>{t("redirect.header.title", "Request API Access")}</CardTitle>
        </div>
        <CardDescription>
          {t("redirect.header.desc", "Request a redirect URI for your self-hosted integration (e.g., n8n, Zapier, Make). An admin will review your request.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Request Form */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("redirect.form.platform", "Integration Platform")}</Label>
            {appsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Select value={selectedAppId} onValueChange={setSelectedAppId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("redirect.form.placeholder", "Select an app...")} />
                </SelectTrigger>
                <SelectContent>
                  {apps?.map((app) => (
                    <SelectItem key={app.id} value={app.id}>
                      {app.name}
                      {app.description && <span className="text-muted-foreground ms-2">— {app.description}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("redirect.form.uri", "Your Redirect URI")}</Label>
            <Input
              placeholder="https://your-instance.com/rest/oauth2-credential/callback"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("redirect.form.hint", "Must start with https://")}</p>
          </div>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={!selectedAppId || !redirectUri.startsWith("https://") || submitMutation.isPending}
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin me-2" />
            ) : (
              <Send className="h-4 w-4 me-2" />
            )}
            {t("redirect.actions.submit", "Submit Request")}
          </Button>
        </div>

        {/* Request History */}
        {requestsLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : requests && requests.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">{t("redirect.history.title", "Your Requests")}</Label>
            {requests.map((req) => {
              const config = statusConfig[req.status] || statusConfig.pending;
              return (
                <div key={req.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{getAppName(req.oauth_app_id)}</span>
                      <Badge variant={config.variant} className="text-xs flex items-center gap-1">
                        {config.icon}
                        {statusLabel(req.status)}
                      </Badge>
                    </div>
                    <p className="text-xs font-mono text-muted-foreground truncate">{req.redirect_uri}</p>
                    {req.admin_note && (
                      <p className="text-xs text-muted-foreground italic">{t("redirect.adminNote", "Admin: {{note}}", { note: req.admin_note })}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
