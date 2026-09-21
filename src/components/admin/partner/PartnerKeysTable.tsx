import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";
import { Activity, Ban } from "lucide-react";
import type { PartnerKeyRow } from "@/features/partner-hub";
import { QuotaUsageBar } from "./QuotaUsageBar";
import { ScopeBadges } from "./ScopeBadges";

interface PartnerKeysTableProps {
  keys: PartnerKeyRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
  activeScope: string | null;
  onToggleScope: (scope: string) => void;
  onViewActivity: (key: PartnerKeyRow) => void;
  onRevoke: (key: PartnerKeyRow) => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  revoked: "destructive",
  expired: "secondary",
  rotated: "outline",
};

function when(value: string | null): string {
  return value ? format(new Date(value), "yyyy-MM-dd HH:mm") : "—";
}

export function PartnerKeysTable({ keys, isLoading, error, activeScope, onToggleScope, onViewActivity, onRevoke }: PartnerKeysTableProps) {
  if (error) return <p className="text-sm text-destructive">Could not load partner keys: {error.message}</p>;
  if (isLoading || !keys) return <Skeleton className="h-40 w-full" />;
  const rows = activeScope ? keys.filter((k) => k.scopes.includes(activeScope)) : keys;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{activeScope ? `No keys hold ${activeScope}.` : "No partner keys yet."}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Partner / key</TableHead>
            <TableHead>Prefix</TableHead>
            <TableHead>Workspace · account</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Monthly quota</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-end">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((key) => (
            <TableRow key={key.id}>
              <TableCell>
                <div className="font-medium">{key.name}</div>
                <Badge variant={key.environment === "production" ? "default" : "secondary"} className="mt-1">{key.environment}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{key.key_prefix}…</TableCell>
              <TableCell>
                <div>{key.workspace_name ?? key.workspace_id}</div>
                <div className="text-xs text-muted-foreground">{key.account_platform ?? "?"} · {key.account_username ?? key.social_account_id}</div>
              </TableCell>
              <TableCell><ScopeBadges scopes={key.scopes} activeScope={activeScope} onToggle={onToggleScope} /></TableCell>
              <TableCell><QuotaUsageBar used={key.usage_charged} limit={key.monthly_quota} /></TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[key.status] ?? "outline"}>{key.status}</Badge>
                {key.revoked_reason && <div className="mt-1 max-w-[160px] truncate text-xs text-muted-foreground" title={key.revoked_reason}>{key.revoked_reason}</div>}
              </TableCell>
              <TableCell className="text-xs">{when(key.created_at)}</TableCell>
              <TableCell className="text-xs">{when(key.last_used_at)}</TableCell>
              <TableCell className="text-end">
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => onViewActivity(key)}>
                    <Activity className="me-1 h-3.5 w-3.5" /> View live activity
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={key.status !== "active"} onClick={() => onRevoke(key)}>
                    <Ban className="me-1 h-3.5 w-3.5" /> Revoke key
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
