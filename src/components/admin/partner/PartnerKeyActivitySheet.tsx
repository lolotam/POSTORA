import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { endpointForAction, useKeyConnectorActivity, usePartnerKeyActivity, usePartnerKeyDeliveries } from "@/features/partner-hub";

interface PartnerKeyActivitySheetProps {
  partnerKey: { id: string; name: string; workspace_name: string | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DASH = "—";
const stamp = (iso: string | null) => (iso ? format(new Date(iso), "MM-dd HH:mm:ss") : DASH);

function statusVariant(status: number): "default" | "secondary" | "destructive" {
  if (status >= 500) return "destructive";
  if (status >= 400) return "secondary";
  return "default";
}

function connectorVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "success") return "default";
  if (status === "failed" || status === "timeout") return "destructive";
  return "secondary";
}

function deliveryVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered") return "default";
  if (status === "exhausted") return "destructive";
  if (status === "delivering") return "secondary";
  return "outline";
}

export function PartnerKeyActivitySheet({ partnerKey, open, onOpenChange }: PartnerKeyActivitySheetProps) {
  const keyId = open && partnerKey ? partnerKey.id : null;
  const activity = usePartnerKeyActivity(keyId);
  const deliveries = usePartnerKeyDeliveries(keyId);
  const connectorCalls = useKeyConnectorActivity(keyId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Live activity — {partnerKey?.name ?? ""}</SheetTitle>
          <SheetDescription>Last 50 authenticated requests and the workspace's recent webhook deliveries. Refreshes every 15 s.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="mt-4 h-[calc(100vh-8rem)] pe-4">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Recent API requests</h3>
            {activity.error ? (
              <p className="text-sm text-destructive">Could not load requests: {activity.error.message}</p>
            ) : activity.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (activity.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No requests recorded for this key.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead><TableHead>Endpoint</TableHead><TableHead>Status</TableHead>
                    <TableHead>Request ID</TableHead><TableHead>Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(activity.data ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">{stamp(row.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{endpointForAction(row.action)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row.http_status)}>{row.http_status}</Badge>
                        {row.error_code && <span className="ms-1 text-xs text-muted-foreground">{row.error_code}</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.request_id ?? DASH}</TableCell>
                      <TableCell className="text-xs">{row.latency_ms === null ? DASH : `${row.latency_ms} ms`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="mt-6 space-y-2">
            <h3 className="text-sm font-semibold">Webhook deliveries — workspace {partnerKey?.workspace_name ?? DASH}</h3>
            {deliveries.error ? (
              <p className="text-sm text-destructive">Could not load deliveries: {deliveries.error.message}</p>
            ) : deliveries.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (deliveries.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No webhook deliveries for this workspace.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Occurred</TableHead><TableHead>Event</TableHead><TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead><TableHead>Endpoint</TableHead><TableHead>Last result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveries.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="text-xs">{stamp(d.occurred_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{d.event_type}</TableCell>
                      <TableCell><Badge variant={deliveryVariant(d.status)}>{d.status}</Badge></TableCell>
                      <TableCell className="text-xs">{d.attempts}{d.status === "pending" ? ` · next ${stamp(d.next_attempt_at)}` : ""}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono text-xs" title={d.webhook_url}>
                        {d.webhook_url}{!d.webhook_is_active && <span className="ms-1 text-destructive">(disabled)</span>}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-xs" title={d.last_error ?? undefined}>
                        {d.last_status_code ?? DASH}{d.last_error ? ` · ${d.last_error}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="mt-6 space-y-2">
            <h3 className="text-sm font-semibold">Connector calls</h3>
            {connectorCalls.error ? (
              <p className="text-sm text-destructive">Could not load connector calls: {connectorCalls.error.message}</p>
            ) : connectorCalls.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (connectorCalls.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No connector calls recorded for this key.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead><TableHead>Connector</TableHead><TableHead>Action</TableHead>
                    <TableHead>Status</TableHead><TableHead>Latency</TableHead><TableHead>Request ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(connectorCalls.data ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">{stamp(row.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{row.connector_type}</TableCell>
                      <TableCell className="font-mono text-xs">{row.action_name}</TableCell>
                      <TableCell>
                        <Badge variant={connectorVariant(row.status)}>{row.status}</Badge>
                        {row.error_code && <span className="ms-1 text-xs text-muted-foreground">{row.error_code}</span>}
                      </TableCell>
                      <TableCell className="text-xs">{row.latency_ms === null ? DASH : `${row.latency_ms} ms`}</TableCell>
                      <TableCell className="font-mono text-xs">{row.request_id ?? DASH}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
