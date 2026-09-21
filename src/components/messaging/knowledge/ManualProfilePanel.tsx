import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import type { TFunction } from "i18next";
import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  INDUSTRY_OPTIONS,
  POLICY_KEYS,
  POLICY_LABELS,
  policyKeysForIndustry,
  renderBusinessProfileText,
  type BusinessIndustry,
  type BusinessPolicyKey,
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

const POLICY_PLACEHOLDERS: Record<BusinessPolicyKey, string> = {
  returns: "e.g. 14 days, unopened, receipt required",
  shipping: "e.g. free over 20 KWD, 2-4 working days",
  warranty: "e.g. 1 year manufacturer warranty",
  payment_methods: "e.g. KNET, Visa, cash on delivery",
  delivery: "e.g. same-day inside Kuwait City, 1.5 KWD fee",
  booking: "e.g. book on WhatsApp at least 24 hours ahead",
  cancellation: "e.g. free up to 24 hours before, then 50%",
  opening_hours: "e.g. Sat-Thu 9am-9pm, Fri 4pm-9pm",
  menu: "e.g. halal, vegan options, gluten-free on request",
  insurance: "e.g. GIG, Warba; cash patients welcome",
  service_area: "e.g. all of Kuwait; Hawally same-day",
  leasing: "e.g. viewings Sat-Thu, 1 year minimum, 2 months deposit",
};

function industryLabel(value: BusinessIndustry, fallback: string, t: TFunction): string {
  switch (value) {
    case "ecommerce": return t("knowledge.industryEcommerce", fallback);
    case "retail": return t("knowledge.industryRetail", fallback);
    case "clinic": return t("knowledge.industryClinic", fallback);
    case "dental": return t("knowledge.industryDental", fallback);
    case "pharmacy": return t("knowledge.industryPharmacy", fallback);
    case "beauty": return t("knowledge.industryBeauty", fallback);
    case "fitness": return t("knowledge.industryFitness", fallback);
    case "restaurant": return t("knowledge.industryRestaurant", fallback);
    case "cafe": return t("knowledge.industryCafe", fallback);
    case "hotel": return t("knowledge.industryHotel", fallback);
    case "real_estate": return t("knowledge.industryRealEstate", fallback);
    case "b2b_services": return t("knowledge.industryB2b", fallback);
    case "agency": return t("knowledge.industryAgency", fallback);
    case "education": return t("knowledge.industryEducation", fallback);
    case "legal": return t("knowledge.industryLegal", fallback);
    case "finance": return t("knowledge.industryFinance", fallback);
    case "automotive": return t("knowledge.industryAutomotive", fallback);
    case "logistics": return t("knowledge.industryLogistics", fallback);
    case "travel": return t("knowledge.industryTravel", fallback);
    case "events": return t("knowledge.industryEvents", fallback);
    case "home_services": return t("knowledge.industryHomeServices", fallback);
    case "saas": return t("knowledge.industrySaas", fallback);
    case "other": return t("knowledge.industryOther", fallback);
  }
}

function policyLabel(key: BusinessPolicyKey, fallback: string, t: TFunction): string {
  switch (key) {
    case "returns": return t("knowledge.policyReturns", fallback);
    case "shipping": return t("knowledge.policyShipping", fallback);
    case "warranty": return t("knowledge.policyWarranty", fallback);
    case "payment_methods": return t("knowledge.policyPayment", fallback);
    case "delivery": return t("knowledge.policyDelivery", fallback);
    case "booking": return t("knowledge.policyBooking", fallback);
    case "cancellation": return t("knowledge.policyCancellation", fallback);
    case "opening_hours": return t("knowledge.policyHours", fallback);
    case "menu": return t("knowledge.policyMenu", fallback);
    case "insurance": return t("knowledge.policyInsurance", fallback);
    case "service_area": return t("knowledge.policyServiceArea", fallback);
    case "leasing": return t("knowledge.policyLeasing", fallback);
  }
}

function policyPlaceholder(key: BusinessPolicyKey, fallback: string, t: TFunction): string {
  switch (key) {
    case "returns": return t("knowledge.policyReturnsPh", fallback);
    case "shipping": return t("knowledge.policyShippingPh", fallback);
    case "warranty": return t("knowledge.policyWarrantyPh", fallback);
    case "payment_methods": return t("knowledge.policyPaymentPh", fallback);
    case "delivery": return t("knowledge.policyDeliveryPh", fallback);
    case "booking": return t("knowledge.policyBookingPh", fallback);
    case "cancellation": return t("knowledge.policyCancellationPh", fallback);
    case "opening_hours": return t("knowledge.policyHoursPh", fallback);
    case "menu": return t("knowledge.policyMenuPh", fallback);
    case "insurance": return t("knowledge.policyInsurancePh", fallback);
    case "service_area": return t("knowledge.policyServiceAreaPh", fallback);
    case "leasing": return t("knowledge.policyLeasingPh", fallback);
  }
}

/** A filled field the selected type no longer shows: kept, not indexed. */
function hiddenFilledPolicyCount(profile: BusinessProfile): number {
  const visible = new Set(policyKeysForIndustry(profile.industry));
  return POLICY_KEYS.filter(
    (key) => !visible.has(key) && (profile.policies?.[key] ?? "").trim(),
  ).length;
}

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
  const { t } = useTranslation("agent");
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = renderBusinessProfileText(profile);

  const setField = <K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) =>
    onProfileChange({ ...profile, [key]: value });

  // Only the fields this business type shows. The others stay in `profile`
  // untouched, so switching the type back brings their text with it.
  const policyKeys = policyKeysForIndustry(profile.industry);
  const hiddenFilled = hiddenFilledPolicyCount(profile);

  const setPolicy = (key: BusinessPolicyKey, value: string) =>
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
          <CardTitle>{t("knowledge.profileTitle", "Business profile")}</CardTitle>
          <CardDescription>
            {t("knowledge.profileDescription", "What the assistant knows about your business. Everything here is indexed and searchable, so fill in what customers actually ask about.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="profile-industry">{t("knowledge.businessType", "Business type")}</Label>
            <Select
              value={profile.industry ?? ""}
              onValueChange={(value) => setField("industry", value as BusinessIndustry)}
            >
              <SelectTrigger id="profile-industry" className="w-full max-w-sm">
                <SelectValue placeholder={t("knowledge.chooseMatch", "Choose the closest match")} />
              </SelectTrigger>
              <SelectContent>
                {INDUSTRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {industryLabel(option.value, option.label, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-products">{t("knowledge.products", "Products and services")}</Label>
            <Textarea
              id="profile-products"
              value={profile.products ?? ""}
              onChange={(event) => setField("products", event.target.value)}
              rows={4}
              placeholder={t("knowledge.productsPlaceholder", "What you sell, the ranges you carry, anything you are known for.")}
            />
          </div>

          <div className="space-y-2">
            <div className="grid gap-4 md:grid-cols-2">
              {policyKeys.map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`profile-${key}`}>{policyLabel(key, POLICY_LABELS[key], t)}</Label>
                  <Textarea
                    id={`profile-${key}`}
                    value={profile.policies?.[key] ?? ""}
                    onChange={(event) => setPolicy(key, event.target.value)}
                    rows={2}
                    placeholder={policyPlaceholder(key, POLICY_PLACEHOLDERS[key], t)}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("knowledge.profileFieldsHint", "These fields match the selected business type.")}
              {hiddenFilled > 0 &&
                (hiddenFilled === 1
                  ? ` ${t("knowledge.hiddenFieldsOne", "{{count}} filled field for other business types is kept but not indexed.", { count: hiddenFilled })}`
                  : ` ${t("knowledge.hiddenFieldsMany", "{{count}} filled fields for other business types are kept but not indexed.", { count: hiddenFilled })}`)}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("knowledge.faqs", "Frequently asked questions")}</Label>
            {faqs.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("knowledge.emptyFaqs", "No FAQs yet. These are the highest-value thing you can add — they answer customers in your own words.")}
              </p>
            )}
            {faqs.map((faq, index) => (
              <div key={index} className="space-y-2 rounded-md border p-3">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={t("knowledge.questionAria", "Question {{n}}", { n: index + 1 })}
                    value={faq.q}
                    onChange={(event) => setFaq(index, { q: event.target.value })}
                    placeholder={t("knowledge.questionPlaceholder", "Do you ship outside Kuwait?")}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("knowledge.removeQuestion", "Remove question {{n}}", { n: index + 1 })}
                    onClick={() =>
                      onProfileChange({ ...profile, faqs: faqs.filter((_, i) => i !== index) })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  aria-label={t("knowledge.answerAria", "Answer {{n}}", { n: index + 1 })}
                  value={faq.a}
                  onChange={(event) => setFaq(index, { a: event.target.value })}
                  rows={2}
                  placeholder={t("knowledge.answerPlaceholder", "Yes, across the GCC. Delivery takes 3-5 working days.")}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onProfileChange({ ...profile, faqs: [...faqs, { q: "", a: "" }] })}
            >
              <Plus className="mr-1 h-4 w-4" /> {t("knowledge.addQuestion", "Add a question")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-notes">{t("knowledge.notes", "Additional notes")}</Label>
            <Textarea
              id="profile-notes"
              value={profile.notes ?? ""}
              onChange={(event) => setField("notes", event.target.value)}
              rows={4}
              placeholder={t("knowledge.notesPlaceholder", "Describe your business, products, policies, and FAQs.")}
            />
          </div>

          <div className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
              onClick={() => setPreviewOpen((open) => !open)}
              aria-expanded={previewOpen}
            >
              <span>{t("knowledge.preview", "Preview what the assistant will read")}</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${previewOpen ? "rotate-180" : ""}`}
              />
            </button>
            {previewOpen && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs text-muted-foreground">
                {preview || t("knowledge.emptyPreview", "Nothing yet — the fields above are all empty.")}
              </pre>
            )}
          </div>

          <Button onClick={onSave} disabled={saveDisabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("knowledge.saveAndIndex", "Save & index")}
          </Button>
        </CardContent>
      </Card>

      {showCatalog && (
        <Card>
          <CardHeader>
            <CardTitle>{t("knowledge.catalogTitle", "WhatsApp catalog")}</CardTitle>
            <CardDescription>
              {hasCatalogAccount && catalog?.catalog_id
                ? t("knowledge.catalogSyncHint", "Sync products for AI product answers.")
                : t("knowledge.catalogConnect", "Connect a WhatsApp account with a catalog to sync products.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={onSyncCatalog}
              disabled={!hasCatalogAccount || !catalog?.catalog_id || catalogBusy}
            >
              {t("knowledge.syncCatalog", "Sync catalog")}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
