import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/hooks/use-toast";
import { buildContactsCsv, buildMetaAudienceCsv, downloadBlob, fetchAllContacts, type ContactFilters, type SocialContact } from "@/features/audience";

export function ExportMenu({ filters }: { filters: ContactFilters }) {
  const [busy, setBusy] = useState(false);

  const exportRows = async (build: (rows: SocialContact[]) => string, filename: string) => {
    setBusy(true);
    try {
      const { rows, truncated, cap } = await fetchAllContacts(filters);
      downloadBlob(new Blob([build(rows)], { type: "text/csv;charset=utf-8" }), filename);
      // A short file looks exactly like a complete one, so the cap has to be said
      // out loud rather than left for the user to discover by counting.
      if (truncated) {
        toast({
          title: "Export truncated",
          description: `This file holds the first ${cap.toLocaleString()} contacts. Narrow the filters to export the rest.`,
        });
      }
    } catch (error) {
      toast({ title: "Export failed", description: (error as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const date = new Date().toISOString().slice(0, 10);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy}>Export</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => exportRows(buildContactsCsv, `audience-${date}.csv`)}>Full CSV</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => exportRows(buildMetaAudienceCsv, `meta-audience-${date}.csv`)}>Meta Custom Audience CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
