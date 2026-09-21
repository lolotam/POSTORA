import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface SessionRow {
  id: string;
  client_id: string;
  scopes: string[];
  expires_at: string;
  refresh_expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  last_user_agent: string | null;
  created_at: string;
  client: {
    client_id: string;
    client_name: string;
    client_uri?: string | null;
    logo_uri?: string | null;
  };
}

function functionUrl(path: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/mcp-oauth${path}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function statusFor(s: SessionRow): { label: string; tone: string } {
  if (s.revoked_at) return { label: "Revoked", tone: "bg-muted text-muted-foreground" };
  const now = Date.now();
  if (s.refresh_expires_at && new Date(s.refresh_expires_at).getTime() < now) {
    return { label: "Expired", tone: "bg-destructive/10 text-destructive" };
  }
  return { label: "Active", tone: "bg-emerald-500/10 text-emerald-500" };
}

export function McpConnectedClients() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetch(functionUrl("/sessions"), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.error || "Failed");
      setSessions(data.sessions ?? []);
    } catch (e) {
      toast({ title: "Couldn't load connected clients", description: (e as Error).message, variant: "destructive" });
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Realtime updates so a brand new Claude/ChatGPT connection appears live.
  useEffect(() => {
    const channel = supabase
      .channel("mcp-oauth-tokens")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mcp_oauth_tokens" },
        () => { load(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      const headers = await authHeaders();
      const res = await fetch(functionUrl(`/sessions/${id}`), { method: "DELETE", headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error_description || data.error || "Failed");
      }
      toast({ title: "Disconnected", description: "The MCP client no longer has access." });
      await load();
    } catch (e) {
      toast({ title: "Couldn't disconnect", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRevoking(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Plug className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Connected MCP clients</CardTitle>
              <CardDescription>
                Apps you've authorized to access Postora via MCP (Claude, ChatGPT, Antigravity, etc.). Disconnect any you no longer use.
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && sessions === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin me-2" /> Loading…
          </div>
        ) : (sessions ?? []).filter((s) => !s.revoked_at).length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground border border-dashed rounded-lg">
            <Plug className="w-6 h-6 mx-auto mb-2 opacity-50" />
            No MCP clients connected yet. Add Postora as a custom connector in Claude, ChatGPT or another MCP-compatible app to see it here.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border">
            {(sessions ?? []).map((s) => {
              const status = statusFor(s);
              return (
                <li key={s.id} className="flex items-start gap-3 p-3">
                  {s.client.logo_uri ? (
                    <img src={s.client.logo_uri} alt="" className="h-9 w-9 rounded" />
                  ) : (
                    <div className="h-9 w-9 rounded bg-muted flex items-center justify-center">
                      <Plug className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{s.client.client_name}</span>
                      <Badge variant="outline" className={`text-[10px] ${status.tone}`}>{status.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Connected {formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}
                      {s.last_used_at && (
                        <> · Last used {formatDistanceToNow(new Date(s.last_used_at), { addSuffix: true })}</>
                      )}
                    </p>
                    {s.scopes?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {s.scopes.map((sc) => (
                          <span key={sc} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{sc}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {!s.revoked_at && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleRevoke(s.id)}
                      disabled={revoking === s.id}
                    >
                      {revoking === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      <span className="ms-1.5 hidden sm:inline">Disconnect</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}