import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlatformIcon, type ExtendedPlatform } from "@/components/PlatformIcon";
import { contactLabel, type SocialContact } from "@/features/audience";

export function ContactsTable({ rows, onOpen, onDelete }: {
  rows: SocialContact[]; onOpen: (row: SocialContact) => void; onDelete: (row: SocialContact) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contact</TableHead><TableHead>Source</TableHead><TableHead>Contact info</TableHead>
          <TableHead>Engagement</TableHead><TableHead>Tags</TableHead><TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const label = contactLabel(row);
          return (
            <TableRow key={row.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8"><AvatarFallback>{label.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  <div>
                    <div className="flex items-center gap-2 font-medium"><PlatformIcon platform={row.platform as ExtendedPlatform} size="sm" />{label}</div>
                    {row.username && row.display_name && <div className="text-xs text-muted-foreground">@{row.username}</div>}
                  </div>
                </div>
              </TableCell>
              <TableCell><Badge variant={row.source === "workflow_lead" ? "default" : "secondary"}>{row.source === "workflow_lead" ? "Workflow" : "Organic"}</Badge></TableCell>
              <TableCell className="text-sm">
                {row.phone_number || row.email
                  ? <div className="flex flex-col">{row.phone_number && <span>{row.phone_number}</span>}{row.email && <span>{row.email}</span>}</div>
                  : <span className="text-muted-foreground">Not captured</span>}
              </TableCell>
              <TableCell className="text-sm">
                {row.total_comments_count} comments
                <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(row.last_interacted_at), { addSuffix: true })}</div>
              </TableCell>
              <TableCell><div className="flex flex-wrap gap-1">{row.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}</div></TableCell>
              <TableCell className="text-right">
                {row.whatsapp_contact_id && (
                  // Same destination as the drawer's link (spec §3.4): the
                  // existing WhatsApp contacts page.
                  <Button asChild size="sm" variant="ghost">
                    <Link to="/messaging/whatsapp/contacts">Open on WhatsApp</Link>
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onOpen(row)}>Details</Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(row)}>Delete</Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
