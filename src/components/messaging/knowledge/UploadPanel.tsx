import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AI_KNOWLEDGE_ACCEPT } from "@/lib/aiKnowledge";

export interface UploadPanelProps {
  accountId: string | null;
  selectedAccountLabel: string | null;
  uploadScope: "account" | "all";
  onUploadScopeChange: (next: "account" | "all") => void;
  uploading: boolean;
  onFileSelected: (file: File | undefined) => void;
}

export function UploadPanel({
  accountId,
  selectedAccountLabel,
  uploadScope,
  onUploadScopeChange,
  uploading,
  onFileSelected,
}: UploadPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload knowledge file</CardTitle>
        <CardDescription>
          Spreadsheets (CSV/XLSX/XLS), PDFs, text files (TXT/MD), and images (PNG/JPG/WEBP — text
          is extracted automatically).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {accountId && (
          <div className="space-y-1.5">
            <Label htmlFor="upload-scope">Available to</Label>
            <Select
              value={uploadScope}
              onValueChange={(value) => onUploadScopeChange(value as "account" | "all")}
            >
              <SelectTrigger id="upload-scope" className="w-full max-w-xs" data-testid="upload-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">
                  {selectedAccountLabel ? `Only ${selectedAccountLabel}` : "Only this account"}
                </SelectItem>
                <SelectItem value="all">All accounts</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applies to the next file you upload. Existing files keep the scope they were given.
            </p>
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2">
          <Button type="button" variant="outline" disabled={uploading} asChild>
            <span>
              {uploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Upload file
            </span>
          </Button>
          <input
            className="sr-only"
            type="file"
            accept={AI_KNOWLEDGE_ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              onFileSelected(file);
            }}
          />
        </label>
      </CardContent>
    </Card>
  );
}
