import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { buildCredentialsFile, type PartnerEnvironment } from "@/features/partner-hub";
import { AlertTriangle, Copy, Download } from "lucide-react";

export interface CreatedKeyDisplay {
  name: string;
  environment: PartnerEnvironment;
  key: string;
  prefix: string;
  scopes: string[];
  workspaceId: string;
  socialAccountId: string;
  createdAt: string;
}

interface PartnerKeyCreatedViewProps {
  created: CreatedKeyDisplay;
  onDone: () => void;
}

/** The one-time plaintext display. The parent drops `created` from state when
 *  the dialog closes, so this view cannot be reopened for the same key. */
export function PartnerKeyCreatedView({ created, onDone }: PartnerKeyCreatedViewProps) {
  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      toast({ title: "Copied", description: "The key is on your clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the key and copy it manually.", variant: "destructive" });
    }
  };

  const download = () => {
    const blob = new Blob([buildCredentialsFile({
      name: created.name, environment: created.environment, key: created.key, keyPrefix: created.prefix,
      scopes: created.scopes, workspaceId: created.workspaceId, socialAccountId: created.socialAccountId, createdAt: created.createdAt,
    })], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `postora-partner-key-${created.prefix}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Copy this key now</AlertTitle>
        <AlertDescription>It will not be shown again. Postora stores only a hash; a lost key must be revoked and re-issued.</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Input readOnly value={created.key} className="font-mono text-xs" aria-label="Partner API key" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={copy}><Copy className="mr-1 h-4 w-4" /> Copy</Button>
      </div>
      <div className="flex justify-between">
        <Button type="button" variant="secondary" onClick={download}><Download className="mr-1 h-4 w-4" /> Download credentials JSON</Button>
        <Button type="button" onClick={onDone}>I have saved the key</Button>
      </div>
    </div>
  );
}
