import { useState } from "react";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  INDUSTRY_OPTIONS,
  renderBusinessProfileText,
  type BusinessIndustry,
  type BusinessProfile,
} from "@/lib/agentProfile";

export interface ManualProfilePanelProps {
  profile: BusinessProfile;
  onProfileChange: (next: BusinessProfile) => void;
  onSave: () => void;
  saveDisabled: boolean;
  saving: boolean;
  /** WhatsApp product catalog. Rendered only on WhatsApp. */
  showCatalog: boolean;
  catalog: { catalog_id: string } | null;
  hasCatalogAccount: boolean;
  onSyncCatalog: () => void;
  catalogBusy: boolean;
}

const POLICY_FIELDS = [
  { key: "returns", label: "Returns policy", placeholder: "e.g. 14 days, unopened, receipt required" },
  { key: "shipping", label: "Shipping policy", placeholder: "e.g. free over 20 KWD, 2-4 working days" },
  { key: "warranty", label: "Warranty policy", placeholder: "e.g. 1 year manufacturer warranty" },
] as const;

/**
 * Describing the business by hand.
 *
 * Structured fields rather than one textarea, because the blank box asked the
 * user to guess what the agent needs. Each field also becomes its own labelled
 * paragraph in the indexed text, so a question about returns retrieves the
 * returns policy instead of a window across three unrelated topics.
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
  showCatalog,
  catalog,
  hasCatalogAccount,
  onSyncCatalog,
  catalogBusy,
}: ManualProfilePanelProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = renderBusinessProfileText(profile);

  const setField = <K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) =>
    onProfileChange({ ...profile, [key]: value });

  const setPolicy = (key: (typeof POLICY_FIELDS)[number]["key"], value: string) =>
    onProfileChange({ ...profile, policies: { ...(profile.policies ?? {}), [key]: value } });

  const faqs = profile.faqs ?? [];
  const setFaq = (index: number, patch: { q?: string; a?: string }) =>
    onProfileChange({
      ...profile,
      faqs: faqs.map((faq, i) => (i === index ? { ...faq, ...patch } : faq)),
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Business profile</CardTitle>
          <CardDescription>
            What the assistant knows about your business. Everything here is indexed and
            searchable, so fill in what customers actually ask about.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="profile-industry">Business type</Label>
            <Select
              value={profile.industry ?? ""}
              onValueChange={(value) => setField("industry", value as BusinessIndustry)}
            >
              <SelectTrigger id="profile-industry" className="w-full max-w-sm">
                <SelectValue placeholder="Choose the closest match" />
              </SelectTrigger>
              <SelectContent>
                {INDUSTRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-products">Products and services</Label>
            <Textarea
              id="profile-products"
              value={profile.products ?? ""}
              onChange={(event) => setField("products", event.target.value)}
              rows={4}
              placeholder="What you sell, the ranges you carry, anything you are known for."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {POLICY_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`profile-${field.key}`}>{field.label}</Label>
                <Textarea
                  id={`profile-${field.key}`}
                  value={profile.policies?.[field.key] ?? ""}
                  onChange={(event) => setPolicy(field.key, event.target.value)}
                  rows={2}
                  placeholder={field.placeholder}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label>Frequently asked questions</Label>
            {faqs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No FAQs yet. These are the highest-value thing you can add — they answer customers
                in your own words.
              </p>
            )}
            {faqs.map((faq, index) => (
              <div key={index} className="space-y-2 rounded-md border p-3">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={`Question ${index + 1}`}
                    value={faq.q}
                    onChange={(event) => setFaq(index, { q: event.target.value })}
                    placeholder="Do you ship outside Kuwait?"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove question ${index + 1}`}
                    onClick={() =>
                      onProfileChange({ ...profile, faqs: faqs.filter((_, i) => i !== index) })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  aria-label={`Answer ${index + 1}`}
                  value={faq.a}
                  onChange={(event) => setFaq(index, { a: event.target.value })}
                  rows={2}
                  placeholder="Yes, across the GCC. Delivery takes 3-5 working days."
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onProfileChange({ ...profile, faqs: [...faqs, { q: "", a: "" }] })}
            >
              <Plus className="mr-1 h-4 w-4" /> Add a question
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-notes">Additional notes</Label>
            <Textarea
              id="profile-notes"
              value={profile.notes ?? ""}
              onChange={(event) => setField("notes", event.target.value)}
              rows={4}
              placeholder="Describe your business, products, policies, and FAQs."
            />
          </div>

          <div className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
              onClick={() => setPreviewOpen((open) => !open)}
              aria-expanded={previewOpen}
            >
              <span>Preview what the assistant will read</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${previewOpen ? "rotate-180" : ""}`}
              />
            </button>
            {previewOpen && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs text-muted-foreground">
                {preview || "Nothing yet — the fields above are all empty."}
              </pre>
            )}
          </div>

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
