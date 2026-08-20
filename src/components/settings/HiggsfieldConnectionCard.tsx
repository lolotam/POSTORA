import { useEffect, useState } from "react";
import { Link2, Loader2, Unlink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

export function HiggsfieldConnectionCard() {
  const { toast } = useToast();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const invoke = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("higgsfield-oauth", { body });
    if (error || data?.error) throw error ?? new Error(data.error);
    return data;
  };
  useEffect(() => {
    void invoke({ action: "status", scope_kind: "user" })
      .then((data) => setConnected(!!data?.connected))
      .catch(() => setConnected(false));
  }, []);
  const connect = async () => {
    setBusy(true);
    try {
      const data = await invoke({
        action: "authorize_url",
        scope_kind: "user",
        redirect_uri: `${window.location.origin}/admin/oauth/higgsfield/callback`,
      });
      if (typeof data?.url !== "string" || !data.url.trim()) throw new Error("Higgsfield did not return an authorization URL");
      window.location.assign(data.url);
    } catch (e) {
      toast({
        title: "Could not connect Higgsfield",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await invoke({ action: "disconnect", scope_kind: "user" });
      setConnected(false);
      toast({ title: "Higgsfield disconnected" });
    } catch (e) {
      toast({
        title: "Could not disconnect",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Higgsfield account</CardTitle>
        <CardDescription>
          Use your own Higgsfield account for generation. BYO generation bills Higgsfield and does
          not consume your Postora plan quota; without it, Postora uses the platform connection and
          plan quota.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={() => void (connected ? disconnect() : connect())}
          variant={connected ? "outline" : "default"}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : connected ? (
            <Unlink className="mr-2 h-4 w-4" />
          ) : (
            <Link2 className="mr-2 h-4 w-4" />
          )}
          {connected ? "Disconnect" : "Connect with Higgsfield"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Disconnect deletes stored tokens but does not revoke Higgsfield’s grant. Remove the app
          from your Higgsfield account settings to end the grant.
        </p>
      </CardContent>
    </Card>
  );
}
export default HiggsfieldConnectionCard;
