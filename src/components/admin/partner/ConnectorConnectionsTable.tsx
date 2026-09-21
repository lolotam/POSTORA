import { useState } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  useAdminConnectorConnections,
  useAdminRevokeConnection,
  type AdminConnectorConnectionRow,
} from "@/features/partner-hub";

const DASH = "—";
const stamp = (iso: string | null) => (iso ? format(new Date(iso), "yyyy-MM-dd HH:mm") : DASH);

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "failed") return "destructive";
  if (status === "initiated") return "secondary";
  return "outline";
}

/**
 * Every workspace's Composio connections, with the platform-admin revoke
 * (spec §9.2). Revoking is one-way and breaks the agent tools built on the
 * connection, so it is confirmed first.
 */
export function ConnectorConnectionsTable() {
  const { toast } = useToast();
  const connections = useAdminConnectorConnections();
  const revoke = useAdminRevokeConnection();
  const [target, setTarget] = useState<AdminConnectorConnectionRow | null>(null);

  const confirmRevoke = () => {
    if (!target) return;
    revoke.mutate(target.id, {
      onSuccess: () => {
        toast({ title: "Connection revoked", description: `${target.connector_type} in ${target.workspace_name} no longer authenticates.` });
        setTarget(null);
      },
      onError: (error) => toast({
        title: "Revocation failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <CardDescription>Composio connected accounts across every workspace, and the tools that depend on them.</CardDescription>
      </CardHeader>
      <CardContent>
        {connections.error ? (
          <p className="text-sm text-destructive">
            Could not load connections: {(connections.error as Error).message}
          </p>
        ) : connections.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (connections.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspace has connected an app yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead><TableHead>Connector</TableHead><TableHead>External account</TableHead>
                <TableHead>Status</TableHead><TableHead>Tools</TableHead><TableHead>Connected</TableHead>
                <TableHead>Last used</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(connections.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs">{row.workspace_name}</TableCell>
                  <TableCell className="font-mono text-xs">{row.connector_type}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs">{row.external_account_label ?? DASH}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    {row.failure_code && <span className="ms-1 text-xs text-muted-foreground">{row.failure_code}</span>}
                  </TableCell>
                  <TableCell className="text-xs">{row.dependent_tools}</TableCell>
                  <TableCell className="text-xs">{stamp(row.connected_at)}</TableCell>
                  <TableCell className="text-xs">{stamp(row.last_used_at)}</TableCell>
                  <TableCell className="text-end">
                    {row.status !== "revoked" && (
                      <Button variant="ghost" size="sm" className="h-8 text-xs text-rose-500 hover:bg-rose-500/10 hover:text-rose-600" onClick={() => setTarget(row)}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? `${target.connector_type} in ${target.workspace_name} stops working immediately, along with ${target.dependent_tools} dependent tool${target.dependent_tools === 1 ? "" : "s"}. This cannot be undone; the workspace must connect the app again.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => { event.preventDefault(); confirmRevoke(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoke.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              Revoke connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
