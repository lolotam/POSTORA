import { useState } from "react";
import { Loader2, Link2, Unlink, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useConnectorConnections,
  useInitiateConnection,
  useRevokeConnection,
  type ConnectorConnectionRow,
} from "@/features/connectors";
import { connectorDefinition, type ConnectorType } from "@/lib/connectorRegistry";
import { ConnectorUsageLine } from "./ConnectorUsageLine";

interface ComposioConnectCardProps {
  connectorType: ConnectorType;
  /** Owning workspace; null when the surface has none yet. */
  workspaceId: string | null;
  /** Only the editable mount passes this: it opens the agent tool form. The
   *  read-only Settings mount hides the tool form, not the connection
   *  controls (spec §9.1). */
  onConfigureTool?: (connectorType: ConnectorType) => void;
}

/** The connection this card speaks for: a live one first, then one still
 *  waiting for the user, then the most recent outcome. */
function currentConnection(
  rows: readonly ConnectorConnectionRow[] | undefined,
  connectorType: ConnectorType,
): ConnectorConnectionRow | undefined {
  const ofType = (rows ?? []).filter((row) => row.connector_type === connectorType);
  return ofType.find((row) => row.status === "active")
    ?? ofType.find((row) => row.status === "initiated")
    ?? ofType[0];
}

export function ComposioConnectCard({ connectorType, workspaceId, onConfigureTool }: ComposioConnectCardProps) {
  const label = connectorDefinition(connectorType).label;
  const connections = useConnectorConnections(workspaceId);
  const initiate = useInitiateConnection();
  const revoke = useRevokeConnection();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const connection = currentConnection(connections.data, connectorType);
  const status = connection?.status ?? "disconnected";
  const isActive = status === "active";
  const isInitiated = status === "initiated";

  const connect = () => {
    if (workspaceId === null) return;
    initiate.mutate(
      { connector_type: connectorType, workspace_id: workspaceId },
      {
        // The authorisation happens on the provider's own page; the callback
        // brings the browser back to Settings → Integrations with the result.
        onSuccess: (result) => window.location.assign(result.redirect_url),
        onError: (error) => toast.error(error instanceof Error ? error.message : `Could not start the ${label} connection`),
      },
    );
  };

  const disconnect = () => {
    if (!connection) return;
    revoke.mutate(connection.id, {
      onSuccess: () => {
        setConfirmingDisconnect(false);
        toast.success(`${label} disconnected`);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : `Could not disconnect ${label}`),
    });
  };

  return (
    <Card data-testid={`composio-card-${connectorType}`}>
      <CardHeader className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-bold">{label}</CardTitle>
            <CardDescription className="truncate text-xs">
              {isActive
                ? connection?.external_account_label ?? "Connected account"
                : "One-click OAuth connection"}
            </CardDescription>
          </div>
          {isActive && (
            <Badge className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/15 py-0 text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Connected
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-4 pt-0">
        {connections.error && (
          <p className="text-xs text-destructive">
            Connections could not be loaded, so this app's status is unknown.
          </p>
        )}

        {isInitiated && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorisation…
          </p>
        )}

        {(status === "failed" || status === "revoked") && (
          <p className="text-xs text-muted-foreground">
            {status === "failed"
              ? `Last attempt failed — ${connection?.failure_code ?? "unknown reason"}.`
              : "This connection was disconnected."}
          </p>
        )}

        {isActive && <ConnectorUsageLine workspaceId={workspaceId} connectorType={connectorType} />}

        {workspaceId === null && (
          <p className="text-xs text-muted-foreground">
            No workspace is available for this connector yet.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          {isActive ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
                onClick={() => setConfirmingDisconnect(true)}
              >
                <Unlink className="mr-1 h-3.5 w-3.5" /> Disconnect
              </Button>
              {onConfigureTool && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onConfigureTool(connectorType)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add agent tool
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={workspaceId === null || isInitiated || initiate.isPending}
              onClick={connect}
            >
              {initiate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              <span>{status === "disconnected" || isInitiated ? "Connect" : "Reconnect"}</span>
            </Button>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agent tools built on this connection stop working until it is connected again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => { event.preventDefault(); disconnect(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
