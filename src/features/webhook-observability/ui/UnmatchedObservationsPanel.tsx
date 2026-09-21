import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, Loader2, MailQuestion } from "lucide-react";
import { useUnmatchedObservations } from "./hooks/useWebhookObservability";

/**
 * Admin view of inbound events that arrived for an account Postora could not resolve.
 *
 * Two reasons show up here and they mean different things:
 *   account_inactive  -- we know this account, it is disconnected. The owner can see this
 *                        row too, and the fix is a reconnect.
 *   unknown_recipient -- nothing in social_accounts matches. Nobody owns this row, which
 *                        is why it is admin-only, and it usually means a user connected a
 *                        different account than the one they are actually messaging.
 */
export function UnmatchedObservationsPanel() {
  const { data: observations, isLoading } = useUnmatchedObservations(50);

  const total = (observations ?? []).reduce((sum, row) => sum + row.attempts, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <MailQuestion className="h-5 w-5" />
          Undeliverable Inbound Events
        </CardTitle>
        <CardDescription>
          Events Meta delivered and Postora verified, but could not route to a connected
          account. Kept for 7 days. Counts are delivery attempts, so a provider redelivery
          increments them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : !observations || observations.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Every inbound event in the last 7 days reached a connected account.
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {observations.length} recipient{observations.length === 1 ? "" : "s"},{" "}
              {total} attempt{total === 1 ? "" : "s"} in the last 7 days.
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-end">Attempts</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {observations.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">{row.recipient_id}</TableCell>
                      <TableCell className="capitalize">{row.platform}</TableCell>
                      <TableCell className="capitalize">{row.event_kind}</TableCell>
                      <TableCell>
                        <Badge
                          variant={row.reason === "account_inactive" ? "secondary" : "destructive"}
                        >
                          {row.reason === "account_inactive" ? "Disconnected account" : "Unknown recipient"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">{row.attempts}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(row.last_seen_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
