import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Link2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { HIGGSFIELD_CALLBACK_PATH } from "@/lib/higgsfieldOAuthReturn";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Status = {
  connected: boolean;
  account_id?: string | null;
  expires_at?: string | null;
  scope?: string | null;
};
const callback = () => `${window.location.origin}${HIGGSFIELD_CALLBACK_PATH}`;

export function HiggsfieldIntegrationCard({ onCatalogChanged }: { onCatalogChanged?: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const invoke = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("higgsfield-oauth", { body });
    if (error || data?.error) throw error ?? new Error(data.error);
    return data;
  };
  // Stable across renders so the mount effect can depend on it honestly rather
  // than silencing exhaustive-deps: `invoke` closes over nothing that changes.
  const load = useCallback(async () => {
    try {
      const data = await invoke({ action: "status", scope_kind: "platform" });
      const platform = data?.platform ?? data;
      setStatus({
        connected: !!(data?.connected ?? platform?.connected),
        account_id: data?.account_id ?? platform?.account_id ?? null,
        expires_at: data?.expires_at ?? platform?.expires_at ?? null,
        scope: data?.scope ?? platform?.scope ?? null,
      });
    } catch {
      setStatus({ connected: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const action = async (kind: "connect" | "sync" | "disconnect") => {
    setBusy(kind);
    try {
      if (kind === "connect") {
        const data = await invoke({
          action: "authorize_url",
          scope_kind: "platform",
          redirect_uri: callback(),
          return_to: "/admin/settings",
        });
        if (typeof data?.url !== "string" || !data.url.trim()) throw new Error("Higgsfield did not return an authorization URL");
        window.location.assign(data.url);
        return;
      }
      const data = await invoke({
        action: kind === "sync" ? "sync_models" : "disconnect",
        scope_kind: "platform",
      });
      if (kind === "disconnect") setStatus({ connected: false });
      toast({
        title: kind === "sync" ? "Model catalog synced" : "Higgsfield disconnected",
        description:
          kind === "sync"
            ? `${data?.activated ?? 0} model(s) available.`
            : "Stored tokens were deleted.",
      });
      onCatalogChanged?.();
    } catch (error) {
      toast({
        title: "Higgsfield action failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Higgsfield Hub</h3>
          <p className="text-sm text-muted-foreground">
            Connect the platform-wide Higgsfield account for AI image and video generation.
          </p>
        </div>
        <Badge variant={status?.connected ? "default" : "secondary"}>
          {status?.connected ? (
            <>
              <CheckCircle2 className="me-1 h-3 w-3" />
              Connected
            </>
          ) : (
            "Not connected"
          )}
        </Badge>
      </div>
      {status?.connected && (
        <p className="text-sm text-muted-foreground">
          Account: {status.account_id ?? "Connected account"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!status?.connected ? (
          <Button onClick={() => void action("connect")} disabled={!!busy}>
            {busy === "connect" ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="me-2 h-4 w-4" />
            )}
            Connect with Higgsfield
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => void action("sync")} disabled={!!busy}>
              {busy === "sync" ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="me-2 h-4 w-4" />
              )}
              Sync models
            </Button>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirm(true)}
              disabled={!!busy}
            >
              <Unlink className="me-2 h-4 w-4" />
              Disconnect
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Disconnect deletes stored tokens but does not revoke Higgsfield’s grant. Remove the app from
        your Higgsfield account settings to end that grant.
      </p>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Higgsfield?</AlertDialogTitle>
            <AlertDialogDescription>
              Disconnecting deletes stored tokens only; Higgsfield has no OAuth revocation endpoint.
              Remove the app from Higgsfield account settings to end the grant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void action("disconnect")}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
export default HiggsfieldIntegrationCard;
