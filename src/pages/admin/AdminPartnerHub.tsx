import { useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useConnectorOverview, usePartnerHubOverview, usePartnerKeys, useRevokePartnerKey, type PartnerKeyRow } from "@/features/partner-hub";
import { PartnerHubKpiCards } from "@/components/admin/partner/PartnerHubKpiCards";
import { PartnerKeysTable } from "@/components/admin/partner/PartnerKeysTable";
import { GeneratePartnerKeyDialog } from "@/components/admin/partner/GeneratePartnerKeyDialog";
import { RevokePartnerKeyDialog } from "@/components/admin/partner/RevokePartnerKeyDialog";
import { PartnerKeyActivitySheet } from "@/components/admin/partner/PartnerKeyActivitySheet";
import { ConnectorUsageTables } from "@/components/admin/partner/ConnectorUsageTables";
import { ConnectorConnectionsTable } from "@/components/admin/partner/ConnectorConnectionsTable";
import { Plus, X } from "lucide-react";

export default function AdminPartnerHub() {
  const { toast } = useToast();
  const overview = usePartnerHubOverview();
  const keys = usePartnerKeys();
  const connectorOverview = useConnectorOverview();
  const revoke = useRevokePartnerKey();

  const [activeScope, setActiveScope] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PartnerKeyRow | null>(null);
  const [activityTarget, setActivityTarget] = useState<PartnerKeyRow | null>(null);

  const confirmRevoke = (reason: string) => {
    if (!revokeTarget) return;
    revoke.mutate({ keyId: revokeTarget.id, reason }, {
      onSuccess: () => { toast({ title: "Key revoked", description: `${revokeTarget.name} no longer authenticates.` }); setRevokeTarget(null); },
      onError: (err) => toast({ title: "Revocation failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" }),
    });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">Partner Hub</h1>
            <p className="text-sm text-muted-foreground">Partner API keys, quotas and live consumption across every workspace.</p>
          </div>
          <Button onClick={() => setGenerateOpen(true)}><Plus className="me-1 h-4 w-4" /> Generate partner key</Button>
        </div>

        <PartnerHubKpiCards overview={overview.data} connectorOverview={connectorOverview.data} connectorError={connectorOverview.error as Error | null} isLoading={overview.isLoading} error={overview.error as Error | null} />

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Partner keys</CardTitle>
                <CardDescription>Click a scope to filter. Quota bars turn amber at 80% and red at 95%.</CardDescription>
              </div>
              {activeScope && (
                <Button variant="ghost" size="sm" onClick={() => setActiveScope(null)}><X className="me-1 h-3.5 w-3.5" /> Clear filter: {activeScope}</Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <PartnerKeysTable
              keys={keys.data}
              isLoading={keys.isLoading}
              error={keys.error as Error | null}
              activeScope={activeScope}
              onToggleScope={(scope) => setActiveScope((prev) => (prev === scope ? null : scope))}
              onViewActivity={setActivityTarget}
              onRevoke={setRevokeTarget}
            />
          </CardContent>
        </Card>

        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-bold">Connectors</h2>
            <p className="text-sm text-muted-foreground">
              Composio connections and metered tool executions across every door and workspace.
            </p>
          </div>
          <ConnectorUsageTables />
          <ConnectorConnectionsTable />
        </section>
      </div>

      <GeneratePartnerKeyDialog open={generateOpen} onOpenChange={setGenerateOpen} />
      <RevokePartnerKeyDialog
        keyName={revokeTarget?.name ?? ""}
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        onConfirm={confirmRevoke}
        isPending={revoke.isPending}
      />
      <PartnerKeyActivitySheet partnerKey={activityTarget} open={activityTarget !== null} onOpenChange={(open) => { if (!open) setActivityTarget(null); }} />
    </AdminLayout>
  );
}
