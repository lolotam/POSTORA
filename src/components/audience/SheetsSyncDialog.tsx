import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { listGoogleSheetsConnections, syncContactsToSheet, type GoogleSheetsConnection } from "@/features/audience";

export function SheetsSyncDialog({ contactIds, onClose }: { contactIds: string[]; onClose: () => void }) {
  const [connections, setConnections] = useState<GoogleSheetsConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listGoogleSheetsConnections()
      .then((rows) => {
        if (cancelled) return;
        setConnections(rows);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      // A failed read must not look like "no connections": the first is retryable
      // in a new dialog, the second tells the user to go connect something they
      // may already have connected.
      .catch((error: Error) => { if (!cancelled) setLoadError(error.message); });
    return () => { cancelled = true; };
  }, []);

  const sync = async () => {
    if (!selectedId || !spreadsheetId.trim() || busy || contactIds.length === 0) return;
    setBusy(true);
    try {
      const appended = await syncContactsToSheet({
        connection_id: selectedId,
        spreadsheet_id: spreadsheetId.trim(),
        sheet_name: sheetName.trim() || "Sheet1",
        contact_ids: contactIds,
      });
      toast({ title: `Appended ${appended} row${appended === 1 ? "" : "s"} to the sheet` });
      onClose();
    } catch (error) {
      toast({ title: "Sheets sync failed", description: (error as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Sync to Google Sheets</DialogTitle></DialogHeader>
        {loadError ? (
          <div className="text-sm text-destructive">Could not load connections: {loadError}</div>
        ) : connections === null ? (
          <div className="text-sm text-muted-foreground">Loading connections…</div>
        ) : connections.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No active Google Sheets connection. Connect one from Settings → Integrations first.
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Connection</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {connections.map((connection) => (
                  <Button
                    key={connection.id}
                    type="button"
                    size="sm"
                    variant={connection.id === selectedId ? "default" : "outline"}
                    aria-pressed={connection.id === selectedId}
                    onClick={() => setSelectedId(connection.id)}
                  >
                    {connection.external_account_label || "Google Sheets"}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="spreadsheet_id">Spreadsheet ID</Label>
              <Input
                id="spreadsheet_id"
                placeholder="The id between /d/ and /edit in the sheet URL"
                value={spreadsheetId}
                onChange={(e) => setSpreadsheetId(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sheet_name">Sheet name</Label>
              <Input id="sheet_name" value={sheetName} onChange={(e) => setSheetName(e.target.value)} />
            </div>
            <div className="text-sm text-muted-foreground">
              {contactIds.length} contact{contactIds.length === 1 ? "" : "s"} will be appended.
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={sync}
            // contactIds empty means the page had no rows: the edge function
            // requires at least one id, so leaving Sync enabled would answer a
            // 400 that invoke() only reports as "non-2xx status code".
            disabled={busy || !selectedId || !spreadsheetId.trim() || contactIds.length === 0}
          >
            Sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
