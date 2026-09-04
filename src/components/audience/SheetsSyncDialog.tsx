import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import {
  fetchSpreadsheetInfo, listGoogleSheetsConnections, syncContactsToSheet,
  type GoogleSheetsConnection,
} from "@/features/audience";

// Stable edge-function refusal codes worded for the person pasting an id.
const LOOKUP_ERRORS: Record<string, string> = {
  composio_failed: "That id is not a spreadsheet this connection can read.",
  forbidden: "You are not a member of that connection's workspace.",
  connection_not_found: "That Google Sheets connection no longer exists.",
  composio_unconfigured: "The Sheets connector is not configured on the server.",
  unexpected_spreadsheet_response: "Google answered with something unexpected.",
};

function lookupMessage(code: string): string {
  return LOOKUP_ERRORS[code] ?? `Could not read that spreadsheet (${code}).`;
}

export function SheetsSyncDialog({ contactIds, onClose }: { contactIds: string[]; onClose: () => void }) {
  const [connections, setConnections] = useState<GoogleSheetsConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [tabs, setTabs] = useState<string[] | null>(null);
  const [spreadsheetTitle, setSpreadsheetTitle] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

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

  // Tabs belong to one spreadsheet read through one connection; editing either
  // invalidates them, and the chosen tab with them.
  useEffect(() => {
    setTabs(null);
    setSpreadsheetTitle(null);
    setLookupError(null);
    setSheetName("");
  }, [spreadsheetId, selectedId]);

  const checkSpreadsheet = async () => {
    if (!selectedId || !spreadsheetId.trim() || lookupBusy) return;
    setLookupBusy(true);
    setLookupError(null);
    try {
      const info = await fetchSpreadsheetInfo({
        connection_id: selectedId,
        spreadsheet_id: spreadsheetId.trim(),
      });
      setTabs(info.sheets);
      setSpreadsheetTitle(info.spreadsheet_title);
      setSheetName((current) => (info.sheets.includes(current) ? current : info.sheets[0] ?? ""));
    } catch (error) {
      // A failed lookup must never render like a spreadsheet with no tabs
      // (AGENTS.md rule 3): the error stays until retried or the id changes.
      setLookupError((error as Error).message);
    } finally {
      setLookupBusy(false);
    }
  };

  const sync = async () => {
    if (!selectedId || !spreadsheetId.trim() || !sheetName || busy || contactIds.length === 0) return;
    setBusy(true);
    try {
      const appended = await syncContactsToSheet({
        connection_id: selectedId,
        spreadsheet_id: spreadsheetId.trim(),
        sheet_name: sheetName,
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
              <div className="mt-1 flex gap-2">
                <Input
                  id="spreadsheet_id"
                  placeholder="The id between /d/ and /edit in the sheet URL"
                  value={spreadsheetId}
                  onChange={(e) => setSpreadsheetId(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={checkSpreadsheet}
                  disabled={lookupBusy || !selectedId || !spreadsheetId.trim()}
                >
                  {lookupBusy ? "Checking…" : "Check"}
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="sheet_name">Sheet tab</Label>
              <div className="mt-1">
                {lookupError ? (
                  <div className="text-sm text-destructive" role="alert">
                    {lookupMessage(lookupError)} Check the id, or open the sheet once in the
                    connected Google account, then press Check again.
                  </div>
                ) : lookupBusy ? (
                  <div className="text-sm text-muted-foreground">Reading tabs…</div>
                ) : tabs === null ? (
                  <div className="text-sm text-muted-foreground">
                    Enter the spreadsheet id, then press Check to load its tabs.
                  </div>
                ) : tabs.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    That spreadsheet has no tabs.
                  </div>
                ) : (
                  <>
                    {spreadsheetTitle && (
                      <div className="mb-1 text-xs text-muted-foreground">
                        {spreadsheetTitle} · {tabs.length} tab{tabs.length === 1 ? "" : "s"}
                      </div>
                    )}
                    <Select value={sheetName} onValueChange={setSheetName}>
                      <SelectTrigger id="sheet_name">
                        <SelectValue placeholder="Choose a tab" />
                      </SelectTrigger>
                      <SelectContent>
                        {tabs.map((tab) => (
                          <SelectItem key={tab} value={tab}>{tab}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
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
            // 400 that invoke() only reports as "non-2xx status code". sheetName
            // is set only from the spreadsheet's real tabs, so a mistyped tab
            // name can never reach Google as an unparseable range.
            disabled={busy || !selectedId || !spreadsheetId.trim() || !sheetName || contactIds.length === 0}
          >
            Sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
