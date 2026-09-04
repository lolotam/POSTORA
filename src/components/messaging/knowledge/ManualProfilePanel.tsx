import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export interface ManualProfilePanelProps {
  profile: string;
  onProfileChange: (next: string) => void;
  onSave: () => void;
  saveDisabled: boolean;
  saving: boolean;
  /** WhatsApp product catalog. Rendered only when the platform actually has one. */
  catalog: { catalog_id: string } | null;
  /** Whether a WhatsApp account is connected at all — the button needs both. */
  hasCatalogAccount: boolean;
  onSyncCatalog: () => void;
  catalogBusy: boolean;
  showCatalog: boolean;
}

/**
 * Describing the business by hand.
 *
 * The WhatsApp catalog lives here rather than beside the sources list: it is
 * another way of DESCRIBING the business, not another view of what is indexed.
 */
export function ManualProfilePanel({
  profile,
  onProfileChange,
  onSave,
  saveDisabled,
  saving,
  catalog,
  hasCatalogAccount,
  onSyncCatalog,
  catalogBusy,
  showCatalog,
}: ManualProfilePanelProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Business profile</CardTitle>
          <CardDescription>This is included in what the AI knows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={profile}
            onChange={(event) => onProfileChange(event.target.value)}
            rows={6}
            placeholder="Describe your business, products, policies, and FAQs."
          />
          <Button onClick={onSave} disabled={saveDisabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save &amp; index
          </Button>
        </CardContent>
      </Card>
      {showCatalog && (
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp catalog</CardTitle>
            <CardDescription>
              {hasCatalogAccount && catalog?.catalog_id
                ? "Sync products for AI product answers."
                : "Connect a WhatsApp account with a catalog to sync products."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={onSyncCatalog}
              disabled={!hasCatalogAccount || !catalog?.catalog_id || catalogBusy}
            >
              Sync catalog
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
