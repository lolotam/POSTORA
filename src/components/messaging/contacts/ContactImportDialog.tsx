import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import Papa from "papaparse";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
} from "lucide-react";
import {
  COUNTRY_DIAL_CODES,
  CSV_FIELDS,
  autoMapHeaders,
  deriveDisplayName,
  normalizePhone,
  type ContactInput,
  type CsvField,
} from "./contactCodecs";
import { useContactGroups } from "./useContacts";

interface ContactImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "upload" | "map" | "running" | "done";

interface ParsedData {
  headers: string[];
  rows: Record<string, string>[];
}

interface FailRow {
  row: Record<string, string>;
  reason: string;
}

export function ContactImportDialog({ open, onOpenChange }: ContactImportDialogProps) {
  const { session } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: groups = [] } = useContactGroups();

  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [columnMap, setColumnMap] = useState<Partial<Record<CsvField, number>>>({});
  const [defaultDial, setDefaultDial] = useState("965");
  const [targetGroupId, setTargetGroupId] = useState<string>("none");
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState({
    imported: 0,
    skippedInvalid: 0,
    failed: 0,
    cleaned: 0,
  });
  const [failRows, setFailRows] = useState<FailRow[]>([]);

  const reset = () => {
    setStep("upload");
    setParsed(null);
    setColumnMap({});
    setProgress(0);
    setResults({ imported: 0, skippedInvalid: 0, failed: 0, cleaned: 0 });
    setFailRows([]);
    setTargetGroupId("none");
  };

  const handleFile = (file: File) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = (res.meta.fields || []) as string[];
        const rows = res.data as Record<string, string>[];
        setParsed({ headers, rows });
        setColumnMap(autoMapHeaders(headers));
        setStep("map");
      },
      error: () => toast({ title: "Failed to parse CSV", variant: "destructive" }),
    });
  };

  const buildContacts = (): {
    valid: (ContactInput & { _rawPhone: string })[];
    invalidCount: number;
    cleanedCount: number;
  } => {
    if (!parsed) return { valid: [], invalidCount: 0, cleanedCount: 0 };

    const valid: (ContactInput & { _rawPhone: string })[] = [];
    let invalidCount = 0;
    let cleanedCount = 0;

    for (const row of parsed.rows) {
      const phoneRaw = columnMap.phone_number !== undefined
        ? (row[parsed.headers[columnMap.phone_number]] || "").trim()
        : "";
      const phone = normalizePhone(phoneRaw, defaultDial);
      if (!phone) {
        invalidCount++;
        continue;
      }

      const get = (field: CsvField) =>
        columnMap[field] !== undefined
          ? (row[parsed.headers[columnMap[field]]] || "").trim()
          : "";

      const firstName = get("first_name");
      const lastName = get("last_name");
      const displayNameCol = get("display_name");
      const displayName =
        displayNameCol || deriveDisplayName(firstName, lastName, `+${phone}`);

      const birthdayRaw = get("birthday");
      let birthday = "";
      if (birthdayRaw) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw)) {
          birthday = birthdayRaw;
        } else {
          cleanedCount++;
        }
      }

      const tagsRaw = get("tags");

      valid.push({
        _rawPhone: phoneRaw,
        phone_number: phone,
        display_name: displayName,
        first_name: firstName || null,
        last_name: lastName || null,
        email: get("email") || null,
        company: get("company") || null,
        job_title: get("job_title") || null,
        phone_secondary: normalizePhone(get("phone_secondary"), defaultDial) || null,
        street: get("street") || null,
        city: get("city") || null,
        country: get("country") || null,
        birthday: birthday || null,
        website: get("website") || null,
        notes: get("notes") || null,
        tags: tagsRaw
          ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
          : [],
        avatar_url: get("avatar_url") || null,
      });
    }

    return { valid, invalidCount, cleanedCount };
  };

  const previewData = (() => {
    if (!parsed || step !== "map") return [];
    const { valid } = buildContacts();
    return valid.slice(0, 10);
  })();

  const previewInvalid = parsed ? parsed.rows.length - buildContacts().valid.length - 0 : 0;

  const runImport = async () => {
    if (!session?.user?.id || !parsed) return;
    setStep("running");
    setProgress(0);

    const { valid, invalidCount, cleanedCount } = buildContacts();
    const BATCH = 500;
    let imported = 0;
    const fails: FailRow[] = [];

    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH);
      const { _rawPhone, ...rest } = batch[0];
      void _rawPhone;
      const payload = batch.map(({ _rawPhone: _rp, ...c }) => ({
        ...c,
        user_id: session.user.id,
      }));
      void rest;
      const { error } = await supabase
        .from("whatsapp_contacts")
        .upsert(payload, { onConflict: "user_id,phone_number" });
      if (error) {
        batch.forEach((b) =>
          fails.push({ row: { phone: b._rawPhone, name: b.display_name || "" }, reason: error.message }),
        );
      } else {
        imported += batch.length;
      }
      setProgress(Math.round(((i + batch.length) / valid.length) * 100));
    }

    if (targetGroupId !== "none" && imported > 0) {
      const phones = valid.map((v) => v.phone_number);
      const { data: inserted } = await supabase
        .from("whatsapp_contacts")
        .select("id, phone_number")
        .in("phone_number", phones);
      if (inserted && inserted.length > 0) {
        const memberRows = inserted.map((c) => ({
          group_id: targetGroupId,
          contact_id: c.id,
        }));
        await supabase
          .from("whatsapp_contact_group_members")
          .upsert(memberRows, {
            onConflict: "group_id,contact_id",
            ignoreDuplicates: true,
          });
      }
    }

    setResults({
      imported,
      skippedInvalid: invalidCount,
      failed: fails.length,
      cleaned: cleanedCount,
    });
    setFailRows(fails);
    qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
    qc.invalidateQueries({ queryKey: ["whatsapp-group-members"] });
    setStep("done");
  };

  const downloadErrors = () => {
    if (failRows.length === 0) return;
    const csv = Papa.unparse(
      failRows.map((f) => ({ ...f.row, error: f.reason })),
    );
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-errors.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(reset, 300);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === "upload" && "Import Contacts from CSV"}
            {step === "map" && "Map Columns"}
            {step === "running" && "Importing..."}
            {step === "done" && "Import Complete"}
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4">
            <button
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors border-border hover:border-primary/50 w-full"
            >
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">Click to select a CSV file</p>
              <p className="text-sm text-muted-foreground mt-1">
                Header row required. Expected columns: phone_number, first_name, last_name, email, etc.
              </p>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>
        )}

        {step === "map" && parsed && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <span>{parsed.rows.length} rows · {parsed.headers.length} columns</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Default country code</Label>
                <Select value={defaultDial} onValueChange={setDefaultDial}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {COUNTRY_DIAL_CODES.map((c) => (
                      <SelectItem key={c.code} value={c.dial}>
                        {c.flag} +{c.dial} {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Add imported to group (optional)</Label>
                <Select value={targetGroupId} onValueChange={setTargetGroupId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No group</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                Column mapping
              </Label>
              {CSV_FIELDS.filter((f) => f === "phone_number" || columnMap[f] !== undefined || true).slice(0, 8).map((field) => (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-32 text-sm capitalize shrink-0">
                    {field.replace(/_/g, " ")}
                  </span>
                  <Select
                    value={columnMap[field] !== undefined ? String(columnMap[field]) : "__none"}
                    onValueChange={(val) =>
                      setColumnMap((prev) => ({
                        ...prev,
                        [field]: val === "__none" ? undefined : Number(val),
                      }))
                    }
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">— Skip —</SelectItem>
                      {parsed.headers.map((h, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {h}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {previewData.length > 0 && (
              <div className="border rounded-lg overflow-hidden max-h-[200px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Phone</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewData.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell>{c.display_name}</TableCell>
                        <TableCell className="font-mono text-sm">+{c.phone_number}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex gap-2">
              {previewInvalid > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {previewInvalid} invalid (no valid phone)
                </Badge>
              )}
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {buildContacts().valid.length} valid
              </Badge>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={reset}>
                Back
              </Button>
              <Button
                onClick={runImport}
                disabled={buildContacts().valid.length === 0}
              >
                Import {buildContacts().valid.length} contacts
              </Button>
            </div>
          </div>
        )}

        {step === "running" && (
          <div className="space-y-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin mx-auto" />
            <Progress value={progress} />
            <p className="text-center text-sm text-muted-foreground">{progress}%</p>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="font-medium">Import report</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <div className="text-2xl font-bold">{results.imported}</div>
                <div className="text-sm text-muted-foreground">Imported / Updated</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-2xl font-bold text-amber-500">
                  {results.skippedInvalid}
                </div>
                <div className="text-sm text-muted-foreground">Skipped (invalid phone)</div>
              </div>
              {results.cleaned > 0 && (
                <div className="rounded-lg border p-3">
                  <div className="text-2xl font-bold text-muted-foreground">
                    {results.cleaned}
                  </div>
                  <div className="text-sm text-muted-foreground">Cleaned (bad birthday)</div>
                </div>
              )}
              {results.failed > 0 && (
                <div className="rounded-lg border p-3">
                  <div className="text-2xl font-bold text-destructive">
                    {results.failed}
                  </div>
                  <div className="text-sm text-muted-foreground">Failed</div>
                </div>
              )}
            </div>

            {failRows.length > 0 && (
              <Button variant="outline" onClick={downloadErrors} className="w-full">
                <Download className="h-4 w-4 mr-2" />
                Download error report ({failRows.length} rows)
              </Button>
            )}

            <Button onClick={close} className="w-full">
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
