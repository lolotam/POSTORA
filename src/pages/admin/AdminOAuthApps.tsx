import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Copy, Plus, Trash2, KeyRound, Loader2, Globe, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";

interface OAuthApp {
  id: string;
  name: string;
  client_id: string;
  redirect_uris: string[];
  description: string | null;
  icon_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface RedirectRequest {
  id: string;
  user_id: string;
  oauth_app_id: string;
  redirect_uri: string;
  status: string;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export default function AdminOAuthApps() {
  const queryClient = useQueryClient();
  const [newRedirectUri, setNewRedirectUri] = useState<Record<string, string>>({});
  const [showAddApp, setShowAddApp] = useState(false);
  const [newApp, setNewApp] = useState({ name: "", client_id: "", description: "" });
  const [rejectNote, setRejectNote] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const { data: apps, isLoading } = useQuery({
    queryKey: ["oauth-apps"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("oauth_apps")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as OAuthApp[];
    },
  });

  const addAppMutation = useMutation({
    mutationFn: async (app: { name: string; client_id: string; description: string }) => {
      const { error } = await (supabase as any).from("oauth_apps").insert({
        name: app.name,
        client_id: app.client_id,
        description: app.description || null,
        redirect_uris: [],
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      setShowAddApp(false);
      setNewApp({ name: "", client_id: "", description: "" });
      toast.success("OAuth app added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncRedirectUris = async (clientId: string, redirectUris: string[]) => {
    const { data, error } = await supabase.functions.invoke("manage-oauth-redirects", {
      body: { client_id: clientId, redirect_uris: redirectUris },
    });
    if (error) {
      console.error("Sync error:", error);
      toast.warning("URI updated locally but failed to sync to OAuth server. Update manually in Supabase Dashboard.");
      return;
    }
    if (data?.synced) {
      toast.success("Synced to Supabase OAuth server ✓");
    } else if (data?.message) {
      toast.warning(data.message);
    }
  };

  const addUriMutation = useMutation({
    mutationFn: async ({ appId, uri, currentUris, clientId }: { appId: string; uri: string; currentUris: string[]; clientId: string }) => {
      if (currentUris.includes(uri)) throw new Error("URI already exists");
      const updatedUris = [...currentUris, uri];
      const { error } = await (supabase as any)
        .from("oauth_apps")
        .update({ redirect_uris: updatedUris })
        .eq("id", appId);
      if (error) throw error;
      await syncRedirectUris(clientId, updatedUris);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      setNewRedirectUri({});
      toast.success("Redirect URI added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeUriMutation = useMutation({
    mutationFn: async ({ appId, uri, currentUris, clientId }: { appId: string; uri: string; currentUris: string[]; clientId: string }) => {
      const updatedUris = currentUris.filter((u) => u !== uri);
      const { error } = await (supabase as any)
        .from("oauth_apps")
        .update({ redirect_uris: updatedUris })
        .eq("id", appId);
      if (error) throw error;
      await syncRedirectUris(clientId, updatedUris);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      toast.success("Redirect URI removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ appId, isActive }: { appId: string; isActive: boolean }) => {
      const { error } = await (supabase as any)
        .from("oauth_apps")
        .update({ is_active: isActive })
        .eq("id", appId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      toast.success("App status updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteAppMutation = useMutation({
    mutationFn: async (appId: string) => {
      const { error } = await (supabase as any).from("oauth_apps").delete().eq("id", appId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      toast.success("OAuth app deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Pending redirect URI requests
  const { data: pendingRequests } = useQuery({
    queryKey: ["oauth-redirect-requests"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("oauth_redirect_requests")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as RedirectRequest[];
    },
  });

  // Fetch user emails for display
  const { data: requestUserProfiles } = useQuery({
    queryKey: ["request-user-profiles", pendingRequests?.map((r) => r.user_id)],
    queryFn: async () => {
      if (!pendingRequests?.length) return {};
      const userIds = [...new Set(pendingRequests.map((r) => r.user_id))];
      const { data } = await supabase.from("profiles").select("id, email").in("id", userIds);
      const map: Record<string, string> = {};
      data?.forEach((p) => { map[p.id] = p.email; });
      return map;
    },
    enabled: !!pendingRequests?.length,
  });

  const approveRequestMutation = useMutation({
    mutationFn: async (request: RedirectRequest) => {
      const app = apps?.find((a) => a.id === request.oauth_app_id);
      if (!app) throw new Error("App not found");
      let updatedUris = app.redirect_uris;
      if (!app.redirect_uris.includes(request.redirect_uri)) {
        updatedUris = [...app.redirect_uris, request.redirect_uri];
        const { error: updateError } = await (supabase as any)
          .from("oauth_apps")
          .update({ redirect_uris: updatedUris })
          .eq("id", app.id);
        if (updateError) throw updateError;
        await syncRedirectUris(app.client_id, updatedUris);
      }
      const { error } = await (supabase as any)
        .from("oauth_redirect_requests")
        .update({ status: "approved", reviewed_at: new Date().toISOString() })
        .eq("id", request.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
      queryClient.invalidateQueries({ queryKey: ["oauth-redirect-requests"] });
      toast.success("Request approved and redirect URI added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectRequestMutation = useMutation({
    mutationFn: async ({ requestId, note }: { requestId: string; note: string }) => {
      const { error } = await (supabase as any)
        .from("oauth_redirect_requests")
        .update({ status: "rejected", admin_note: note || null, reviewed_at: new Date().toISOString() })
        .eq("id", requestId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["oauth-redirect-requests"] });
      setRejectingId(null);
      setRejectNote("");
      toast.success("Request rejected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pendingCount = pendingRequests?.filter((r) => r.status === "pending").length || 0;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">OAuth Apps</h2>
            <p className="text-muted-foreground">
              Manage registered OAuth applications and their allowed redirect URIs
            </p>
          </div>
          <Dialog open={showAddApp} onOpenChange={setShowAddApp}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 me-2" />
                Add App
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Register OAuth App</DialogTitle>
                <DialogDescription>
                  Add a new OAuth application.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>App Name</Label>
                  <Input
                    placeholder="e.g. n8n, Zapier, Make"
                    value={newApp.name}
                    onChange={(e) => setNewApp({ ...newApp, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Client ID</Label>
                  <Input
                    placeholder="From Supabase OAuth Server"
                    value={newApp.client_id}
                    onChange={(e) => setNewApp({ ...newApp, client_id: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Description</Label>
                  <Textarea
                    placeholder="Brief description of this integration"
                    value={newApp.description}
                    onChange={(e) => setNewApp({ ...newApp, description: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAddApp(false)}>Cancel</Button>
                <Button
                  onClick={() => addAppMutation.mutate(newApp)}
                  disabled={!newApp.name || !newApp.client_id || addAppMutation.isPending}
                >
                  {addAppMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  Register App
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {/* Info banner */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">
              <strong>Auto-sync enabled:</strong> Adding or removing redirect URIs will automatically sync to the Supabase OAuth server. If sync fails, you'll be notified to update manually.
            </p>
          </CardContent>
        </Card>

        {/* Pending Redirect URI Requests */}
        {pendingCount > 0 && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <CardTitle className="text-lg">Pending Redirect URI Requests</CardTitle>
                <Badge variant="secondary">{pendingCount}</Badge>
              </div>
              <CardDescription>Users requesting redirect URIs for their self-hosted integrations.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingRequests?.filter((r) => r.status === "pending").map((req) => (
                <div key={req.id} className="flex items-start justify-between gap-4 rounded-lg border p-4">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">
                        {apps?.find((a) => a.id === req.oauth_app_id)?.name || "Unknown App"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        by {requestUserProfiles?.[req.user_id] || "Unknown user"}
                      </span>
                    </div>
                    <p className="text-sm font-mono text-muted-foreground break-all">{req.redirect_uri}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {rejectingId === req.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          placeholder="Reason (optional)"
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                          className="w-48 h-8 text-xs"
                        />
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => rejectRequestMutation.mutate({ requestId: req.id, note: rejectNote })}
                          disabled={rejectRequestMutation.isPending}
                        >
                          Confirm
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRejectingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRejectingId(req.id)}
                        >
                          <XCircle className="w-3 h-3 me-1" />
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => approveRequestMutation.mutate(req)}
                          disabled={approveRequestMutation.isPending}
                        >
                          <CheckCircle className="w-3 h-3 me-1" />
                          Approve
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : !apps?.length ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <KeyRound className="w-12 h-12 mx-auto mb-4 opacity-30" />
              <p>No OAuth apps registered yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {apps.map((app) => (
              <Card key={app.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg">{app.name}</CardTitle>
                        <Badge variant={app.is_active ? "default" : "secondary"}>
                          {app.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      {app.description && (
                        <CardDescription>{app.description}</CardDescription>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={app.is_active}
                        onCheckedChange={(checked) =>
                          toggleActiveMutation.mutate({ appId: app.id, isActive: checked })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (confirm(`Delete "${app.name}"?`)) {
                            deleteAppMutation.mutate(app.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Client ID */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Client ID</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-sm bg-muted px-3 py-1.5 rounded-md flex-1 font-mono">
                        {app.client_id}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(app.client_id)}
                      >
                        <Copy className="w-3 h-3 me-1" />
                        Copy
                      </Button>
                    </div>
                  </div>

                  {/* Redirect URIs */}
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Allowed Redirect URIs ({app.redirect_uris.length})
                    </Label>
                    <div className="mt-2 space-y-2">
                      {app.redirect_uris.map((uri) => (
                        <div
                          key={uri}
                          className="flex items-center gap-2 bg-muted/50 rounded-md px-3 py-2"
                        >
                          <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="text-sm font-mono flex-1 break-all">{uri}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() =>
                              removeUriMutation.mutate({
                                appId: app.id,
                                uri,
                                currentUris: app.redirect_uris,
                                clientId: app.client_id,
                              })
                            }
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}

                      {/* Add URI input */}
                      <div className="flex items-center gap-2">
                        <Input
                          placeholder="https://your-instance.com/oauth2/callback"
                          value={newRedirectUri[app.id] || ""}
                          onChange={(e) =>
                            setNewRedirectUri({ ...newRedirectUri, [app.id]: e.target.value })
                          }
                          className="text-sm font-mono"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!newRedirectUri[app.id]?.startsWith("https://") || addUriMutation.isPending}
                          onClick={() =>
                            addUriMutation.mutate({
                              appId: app.id,
                              uri: newRedirectUri[app.id],
                              currentUris: app.redirect_uris,
                              clientId: app.client_id,
                            })
                          }
                        >
                          <Plus className="w-3 h-3 me-1" />
                          Add
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Must start with https://. URIs are automatically synced to the Supabase OAuth server.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
