import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plug, Trash2, Globe, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

interface AuthorizedClient {
  id: string;
  name: string;
  icon?: string;
  scopes?: string[];
  created_at?: string;
  authorized_at?: string;
}

export function IntegrationsSection() {
  const { t } = useTranslation("accounts");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const { data: clients, isLoading, error } = useQuery({
    queryKey: ["oauth-authorized-clients"],
    queryFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error(t("integrations.errors.notAuth", "Not authenticated"));

      const res = await fetch(`${SUPABASE_URL}/auth/v1/oauth/authorized-clients`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        if (res.status === 404) return [];
        const errText = await res.text();
        throw new Error(t("integrations.errors.fetchFailed", "Failed to fetch authorized apps: {{detail}}", { detail: errText }));
      }

      return (await res.json()) as AuthorizedClient[];
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (clientId: string) => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error(t("integrations.errors.notAuth", "Not authenticated"));

      const res = await fetch(
        `${SUPABASE_URL}/auth/v1/oauth/authorized-clients/${clientId}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(t("integrations.errors.revokeFailed", "Failed to revoke access: {{detail}}", { detail: errText }));
      }
    },
    onSuccess: () => {
      toast({ title: t("integrations.toast.revoked", "Access revoked"), description: t("integrations.toast.revokedDesc", "The application can no longer access your account.") });
      queryClient.invalidateQueries({ queryKey: ["oauth-authorized-clients"] });
      setRevokingId(null);
    },
    onError: (err: any) => {
      toast({ title: t("common:error", "Error"), description: err.message, variant: "destructive" });
      setRevokingId(null);
    },
  });

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-primary" />
          <CardTitle>{t("integrations.header.title", "Connected Applications")}</CardTitle>
        </div>
        <CardDescription>
          {t("integrations.header.desc", "Third-party applications that have access to your Postora account.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-sm">{t("integrations.errors.load", "Unable to load connected applications.")}</p>
            <p className="text-xs mt-1">{(error as Error).message}</p>
          </div>
        ) : !clients || clients.length === 0 ? (
          <div className="text-center py-8 space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <ShieldCheck className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("integrations.empty.title", "No connected applications")}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("integrations.empty.hint", "When you authorize third-party apps (like n8n, Zapier, or Make), they'll appear here.")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {clients.map((client) => (
              <div
                key={client.id}
                className="flex items-center justify-between rounded-lg border p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary border">
                    {client.icon ? (
                      <img src={client.icon} alt={client.name} className="h-6 w-6 rounded" />
                    ) : (
                      <Globe className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{client.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {client.scopes?.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">
                          {s}
                        </Badge>
                      ))}
                      {(client.authorized_at || client.created_at) && (
                        <span className="text-xs text-muted-foreground">
                          {t("integrations.connectedOn", "Connected {{date}}", { date: format(new Date(client.authorized_at || client.created_at!), "MMM d, yyyy") })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("integrations.actions.revoke", "Revoke")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("integrations.dialog.title", "Revoke Access")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("integrations.dialog.desc", "Are you sure you want to revoke access for {{name}}? This application will no longer be able to access your Postora account.", { name: client.name })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setRevokingId(client.id);
                          revokeMutation.mutate(client.id);
                        }}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {revokingId === client.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          t("integrations.dialog.confirm", "Revoke Access")
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
