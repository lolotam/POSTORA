import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
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
  connectionFailureMessage,
  openAuthorisationTab,
  useConnectionFinalizer,
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
  const { t } = useTranslation("automation");
  const label = connectorDefinition(connectorType).label;
  const connections = useConnectorConnections(workspaceId);
  const initiate = useInitiateConnection();
  const revoke = useRevokeConnection();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);
  // Resuming a waiting row happens once per mount. After Cancel, or after a
  // poll gives up, the row may still read "initiated" (the sweep expires it
  // later); adopting it again would restart the same poll — on 2026-09-03 that
  // was an eight-minute loop of failing requests behind a "waiting" spinner.
  const [resumeSpent, setResumeSpent] = useState(false);

  const connection = currentConnection(connections.data, connectorType);
  const status = connection?.status ?? "disconnected";
  const isActive = status === "active";

  // A row still "initiated" after a reload (or a tab closed mid-flow) is
  // resumed here: the poll completes it as soon as Composio has the account.
  useEffect(() => {
    if (status === "initiated" && connection && pendingConnectionId === null && !resumeSpent) {
      setResumeSpent(true);
      setPendingConnectionId(connection.id);
    }
  }, [status, connection, pendingConnectionId, resumeSpent]);

  const cancelWaiting = () => {
    setResumeSpent(true);
    setPendingConnectionId(null);
  };

  const finalizer = useConnectionFinalizer({
    connectionId: pendingConnectionId,
    onActive: () => {
      setPendingConnectionId(null);
      toast.success(t("toast.connected", "{{label}} connected", { label }));
    },
    onFailed: (code) => {
      setResumeSpent(true);
      setPendingConnectionId(null);
      toast.error(connectionFailureMessage(code, label));
    },
  });
  const isWaiting = finalizer.status === "waiting";

  const connect = () => {
    if (workspaceId === null) return;
    // Opened inside the click so popup blockers allow it; Composio's page
    // loads there while this card polls for the outcome.
    const authorisationTab = openAuthorisationTab();
    initiate.mutate(
      { connector_type: connectorType, workspace_id: workspaceId },
      {
        onSuccess: (result) => {
          setPendingConnectionId(result.connection_id);
          if (authorisationTab) authorisationTab.location.href = result.redirect_url;
          else window.location.assign(result.redirect_url);
        },
        onError: (error) => {
          authorisationTab?.close();
          toast.error(error instanceof Error ? error.message : t("toast.startFailed", "Could not start the {{label}} connection", { label }));
        },
      },
    );
  };

  const disconnect = () => {
    if (!connection) return;
    revoke.mutate(connection.id, {
      onSuccess: () => {
        setConfirmingDisconnect(false);
        toast.success(t("toast.disconnected", "{{label}} disconnected", { label }));
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : t("toast.disconnectFailed", "Could not disconnect {{label}}", { label })),
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
                ? connection?.external_account_label ?? t("composio.connectedAccount", "Connected account")
                : t("composio.oauthHint", "One-click OAuth connection")}
            </CardDescription>
          </div>
          {isActive && (
            <Badge className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/15 py-0 text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t("status.connected", "Connected")}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-4 pt-0">
        {connections.error && (
          <p className="text-xs text-destructive">
            {t("errors.connectionsUnknown", "Connections could not be loaded, so this app's status is unknown.")}
          </p>
        )}

        {isWaiting && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("composio.waitingAuth", "Waiting for authorisation — finish signing in on the Composio tab; this card updates by itself.")}
          </p>
        )}

        {!isWaiting && (status === "failed" || status === "revoked") && (
          <p className="text-xs text-muted-foreground">
            {status === "failed"
              ? connectionFailureMessage(connection?.failure_code ?? "unknown", label)
              : t("composio.wasDisconnected", "This connection was disconnected.")}
          </p>
        )}

        {isActive && <ConnectorUsageLine workspaceId={workspaceId} connectorType={connectorType} />}

        {workspaceId === null && (
          <p className="text-xs text-muted-foreground">
            {t("composio.noWorkspace", "No workspace is available for this connector yet.")}
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
                <Unlink className="mr-1 h-3.5 w-3.5" /> {t("common:disconnect", "Disconnect")}
              </Button>
              {onConfigureTool && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onConfigureTool(connectorType)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> {t("actions.addAgentTool", "Add agent tool")}
                </Button>
              )}
            </>
          ) : isWaiting ? (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={cancelWaiting}>
              {t("common:cancel", "Cancel")}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={workspaceId === null || initiate.isPending}
              onClick={connect}
            >
              {initiate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              <span>{status === "disconnected" || status === "initiated" ? t("common:connect", "Connect") : t("common:reconnect", "Reconnect")}</span>
            </Button>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialog.disconnectTitle", "Disconnect {{label}}?", { label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialog.disconnectDesc", "Agent tools built on this connection stop working until it is connected again.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={(event) => { event.preventDefault(); disconnect(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("dialog.disconnectConfirm", "Disconnect {{label}}", { label })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
