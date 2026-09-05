import { ExternalLink, FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AiKnowledgeGraphExport } from "@/hooks/useAiKnowledge";

export interface KnowledgeGraphCardProps {
  graphExport: Pick<AiKnowledgeGraphExport, "html_url" | "vault_url"> | null;
  busy: boolean;
  resolving: boolean;
  /** A stored link that could not be resolved — the button disables rather than 404s. */
  unresolvable: { html: boolean; vault: boolean };
  onGenerate: () => void;
  onOpen: (kind: "html" | "vault") => void;
}

export function KnowledgeGraphCard({
  graphExport,
  busy,
  resolving,
  unresolvable,
  onGenerate,
  onOpen,
}: KnowledgeGraphCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge graph</CardTitle>
        <CardDescription>
          Generate inspection exports from the knowledge currently indexed for this business.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={onGenerate}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Generate exports
        </Button>
        {graphExport?.html_url && (
          <Button
            variant="secondary"
            disabled={unresolvable.html || resolving}
            title={unresolvable.html ? "Regenerate exports to refresh this link" : undefined}
            onClick={() => onOpen("html")}
          >
            {resolving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            Open graph
          </Button>
        )}
        {graphExport?.vault_url && (
          <Button
            variant="secondary"
            disabled={unresolvable.vault || resolving}
            title={unresolvable.vault ? "Regenerate exports to refresh this link" : undefined}
            onClick={() => onOpen("vault")}
          >
            {resolving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileArchive className="mr-2 h-4 w-4" />
            )}
            Download vault
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
