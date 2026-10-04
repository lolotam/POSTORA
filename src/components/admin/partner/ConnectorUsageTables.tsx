import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConnectorUsageByKey, useConnectorUsageByType } from "@/features/partner-hub";

const DASH = "—";
const WINDOWS = [7, 30, 90] as const;
const SELECT_CLASS = "h-9 rounded-md border border-input bg-background px-3 py-1 text-sm";

const ms = (value: number | null) => (value === null ? DASH : `${value} ms`);

/**
 * A partner-door refusal that happens before any tool is resolved still owes
 * a metered row, and both `connector_type` and `auth_strategy` are NOT NULL,
 * so it is written as 'unknown' rather than inventing a strategy nobody
 * established (spec §4.3). The Hub names that bucket for what it is.
 */
function typeLabel(connectorType: string): string {
  return connectorType === "unknown" ? "Unresolved requests" : connectorType;
}

function ReadError({ error }: { error: { message?: string } }) {
  return (
    <p className="text-sm text-destructive">
      Could not load connector usage: {error.message ?? "the read was refused"}
    </p>
  );
}

export function ConnectorUsageTables() {
  const [days, setDays] = useState<number>(30);
  const byType = useConnectorUsageByType(days);
  const byKey = useConnectorUsageByKey(days);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="connector-usage-window" className="text-xs">Window</Label>
        <select
          id="connector-usage-window"
          className={SELECT_CLASS}
          value={String(days)}
          onChange={(event) => setDays(Number(event.target.value))}
        >
          {WINDOWS.map((option) => (
            <option key={option} value={option}>Last {option} days</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connector usage by type</CardTitle>
            <CardDescription>Calls, failures and latency per connector type and authentication strategy.</CardDescription>
          </CardHeader>
          <CardContent>
            {byType.error ? (
              <ReadError error={byType.error} />
            ) : byType.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (byType.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No connector calls in the last {days} days.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Connector</TableHead><TableHead>Auth</TableHead><TableHead>Calls</TableHead>
                    <TableHead>Failures</TableHead><TableHead>p50</TableHead><TableHead>p95</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(byType.data ?? []).map((row) => (
                    <TableRow key={`${row.connector_type}:${row.auth_strategy}`}>
                      <TableCell className="font-mono text-xs">{typeLabel(row.connector_type)}</TableCell>
                      <TableCell className="text-xs">{row.auth_strategy}</TableCell>
                      <TableCell className="text-xs">{row.calls}</TableCell>
                      <TableCell className="text-xs">{row.failures}</TableCell>
                      <TableCell className="text-xs">{ms(row.p50_latency_ms)}</TableCell>
                      <TableCell className="text-xs">{ms(row.p95_latency_ms)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Connector usage by partner key</CardTitle>
            <CardDescription>Which partner keys drive connector traffic, and how reliably.</CardDescription>
          </CardHeader>
          <CardContent>
            {byKey.error ? (
              <ReadError error={byKey.error} />
            ) : byKey.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (byKey.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No partner-door connector calls in the last {days} days.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead><TableHead>Workspace</TableHead><TableHead>Calls</TableHead>
                    <TableHead>Failures</TableHead><TableHead>p95</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(byKey.data ?? []).map((row) => (
                    <TableRow key={row.partner_key_id}>
                      <TableCell className="text-xs">
                        {row.key_name ?? DASH}
                        {row.key_prefix && <span className="ms-1 font-mono text-muted-foreground">{row.key_prefix}</span>}
                      </TableCell>
                      <TableCell className="text-xs">{row.workspace_name ?? DASH}</TableCell>
                      <TableCell className="text-xs">{row.calls}</TableCell>
                      <TableCell className="text-xs">{row.failures}</TableCell>
                      <TableCell className="text-xs">{ms(row.p95_latency_ms)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
