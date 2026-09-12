/**
 * The structured business profile, and the text the vector database is built
 * from.
 *
 * `ai_agent_configs.business_profile_text` stays the column every consumer
 * reads: `ingest_profile_text` chunks it, `blankedFields` guards it, retrieval
 * embeds it. This module is what turns the structure the UI now collects back
 * into that text — and it runs on the SERVER, inside `ai_upsert_config`, on
 * purpose. The browser form is the layer that emptied live business profiles
 * twice (2026-08-28, 2026-08-30); giving it a second job of composing the
 * guarded column would put the composition behind the same failure.
 *
 * `src/lib/agentProfile.ts` mirrors the industry list, the policy fields and the
 * industry-to-fields map VERBATIM. Change both files together.
 */

export type BusinessIndustry =
  | "ecommerce"
  | "retail"
  | "clinic"
  | "dental"
  | "pharmacy"
  | "beauty"
  | "fitness"
  | "restaurant"
  | "cafe"
  | "hotel"
  | "real_estate"
  | "b2b_services"
  | "agency"
  | "education"
  | "legal"
  | "finance"
  | "automotive"
  | "logistics"
  | "travel"
  | "events"
  | "home_services"
  | "saas"
  | "other";

const INDUSTRY_LABELS: Record<BusinessIndustry, string> = {
  ecommerce: "E-commerce store",
  retail: "Retail store",
  clinic: "Clinic or medical practice",
  dental: "Dental clinic",
  pharmacy: "Pharmacy",
  beauty: "Beauty salon or spa",
  fitness: "Gym or fitness studio",
  restaurant: "Restaurant",
  cafe: "Cafe or bakery",
  hotel: "Hotel or accommodation",
  real_estate: "Real estate or property management",
  b2b_services: "B2B services",
  agency: "Agency or consultancy",
  education: "Education or training",
  legal: "Legal services",
  finance: "Finance or insurance",
  automotive: "Automotive sales or service",
  logistics: "Logistics or courier",
  travel: "Travel or tourism",
  events: "Events or entertainment",
  home_services: "Home services or maintenance",
  saas: "Software or SaaS",
  other: "Other",
};

export const BUSINESS_INDUSTRIES = Object.keys(INDUSTRY_LABELS) as readonly BusinessIndustry[];

/**
 * Every extra field the profile can hold, in the order they render. The order
 * is fixed here rather than per industry so two industries sharing a field
 * produce the same paragraph sequence.
 */
export const POLICY_KEYS = [
  "returns",
  "shipping",
  "warranty",
  "payment_methods",
  "delivery",
  "booking",
  "cancellation",
  "opening_hours",
  "menu",
  "insurance",
  "service_area",
  "leasing",
] as const;

export type BusinessPolicyKey = (typeof POLICY_KEYS)[number];

export const POLICY_LABELS: Record<BusinessPolicyKey, string> = {
  returns: "Returns policy",
  shipping: "Shipping policy",
  warranty: "Warranty policy",
  payment_methods: "Payment methods",
  delivery: "Delivery options",
  booking: "Booking and appointments",
  cancellation: "Cancellation policy",
  opening_hours: "Opening hours",
  menu: "Menu and dietary information",
  insurance: "Insurance accepted",
  service_area: "Service area",
  leasing: "Viewing and leasing terms",
};

/**
 * Which extra fields each business type shows and indexes.
 *
 * A field outside the selected type is KEPT in the stored profile (so switching
 * back restores it) but left out of the rendered text, so a clinic never
 * indexes a shipping policy it filled in while it was still set to e-commerce.
 * "other" shows everything, as does a profile with no type chosen yet.
 */
export const INDUSTRY_FIELDS: Record<BusinessIndustry, readonly BusinessPolicyKey[]> = {
  ecommerce: ["returns", "shipping", "warranty", "payment_methods", "delivery"],
  retail: ["returns", "warranty", "payment_methods", "delivery", "opening_hours"],
  clinic: ["booking", "cancellation", "opening_hours", "insurance", "payment_methods"],
  dental: ["booking", "cancellation", "opening_hours", "insurance", "payment_methods"],
  pharmacy: ["returns", "payment_methods", "delivery", "opening_hours", "insurance"],
  beauty: ["booking", "cancellation", "opening_hours", "payment_methods"],
  fitness: ["booking", "cancellation", "opening_hours", "payment_methods"],
  restaurant: ["delivery", "booking", "opening_hours", "menu", "payment_methods"],
  cafe: ["delivery", "opening_hours", "menu", "payment_methods"],
  hotel: ["booking", "cancellation", "payment_methods"],
  real_estate: ["payment_methods", "opening_hours", "service_area", "leasing"],
  b2b_services: ["payment_methods", "cancellation", "opening_hours", "service_area"],
  agency: ["payment_methods", "cancellation", "service_area"],
  education: ["booking", "cancellation", "opening_hours", "payment_methods"],
  legal: ["booking", "opening_hours", "payment_methods", "service_area"],
  finance: ["cancellation", "opening_hours", "insurance", "payment_methods"],
  automotive: ["warranty", "booking", "opening_hours", "payment_methods", "service_area"],
  logistics: ["shipping", "delivery", "payment_methods", "service_area"],
  travel: ["booking", "cancellation", "payment_methods"],
  events: ["booking", "cancellation", "payment_methods"],
  home_services: ["warranty", "booking", "cancellation", "payment_methods", "service_area"],
  saas: ["returns", "payment_methods", "cancellation"],
  other: POLICY_KEYS,
};

/** The fields a profile of this type shows, in render order. */
export function policyKeysForIndustry(industry?: BusinessIndustry): readonly BusinessPolicyKey[] {
  if (!industry) return POLICY_KEYS;
  const allowed = new Set<BusinessPolicyKey>(INDUSTRY_FIELDS[industry]);
  return POLICY_KEYS.filter((key) => allowed.has(key));
}

export type BusinessProfilePolicies = Partial<Record<BusinessPolicyKey, string>>;

export interface BusinessProfileFaq {
  q: string;
  a: string;
}

export interface BusinessProfile {
  industry?: BusinessIndustry;
  products?: string;
  policies?: BusinessProfilePolicies;
  faqs?: BusinessProfileFaq[];
  notes?: string;
}

export class BusinessProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessProfileError";
  }
}

const PROFILE_KEYS = ["industry", "products", "policies", "faqs", "notes"] as const;
const MAX_FAQS = 50;

function asText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new BusinessProfileError(`${field} must be a string`);
  return value;
}

function asPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BusinessProfileError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new BusinessProfileError(`Unknown ${label} key: ${key}`);
  }
}

// Every policy key is accepted whatever the industry: a value the user typed
// under one type survives a switch to another (it is simply not rendered).
function parsePolicies(value: unknown): BusinessProfilePolicies {
  const source = asPlainObject(value, "policies");
  rejectUnknownKeys(source, POLICY_KEYS, "policies");
  const policies: BusinessProfilePolicies = {};
  for (const key of POLICY_KEYS) {
    if (key in source && source[key] !== undefined) {
      policies[key] = asText(source[key], `policies.${key}`);
    }
  }
  return policies;
}

function parseFaqs(value: unknown): BusinessProfileFaq[] {
  if (!Array.isArray(value)) throw new BusinessProfileError("faqs must be an array");
  if (value.length > MAX_FAQS) {
    throw new BusinessProfileError(`faqs is limited to ${MAX_FAQS} entries`);
  }
  return value.map((entry, index) => {
    const source = asPlainObject(entry, `faqs[${index}]`);
    rejectUnknownKeys(source, ["q", "a"], "faqs");
    return {
      q: asText(source.q, `faqs[${index}].q`),
      a: asText(source.a, `faqs[${index}].a`),
    };
  });
}

/**
 * The profile as the database may store it.
 *
 * Rejects rather than drops. A silently discarded key is a field the user filled
 * in, saved, and will find empty on their next visit with nothing to explain it.
 */
export function parseBusinessProfile(input: unknown): BusinessProfile {
  if (input === null || input === undefined) return {};
  const source = asPlainObject(input, "business_profile");
  rejectUnknownKeys(source, PROFILE_KEYS, "business_profile");

  const profile: BusinessProfile = {};
  if (source.industry !== undefined) {
    const industry = asText(source.industry, "industry");
    if (!(industry in INDUSTRY_LABELS)) {
      throw new BusinessProfileError(
        `industry must be one of: ${BUSINESS_INDUSTRIES.join(", ")}`,
      );
    }
    profile.industry = industry as BusinessIndustry;
  }
  if (source.products !== undefined) profile.products = asText(source.products, "products");
  if (source.policies !== undefined) profile.policies = parsePolicies(source.policies);
  if (source.faqs !== undefined) profile.faqs = parseFaqs(source.faqs);
  if (source.notes !== undefined) profile.notes = asText(source.notes, "notes");
  return profile;
}

/**
 * The indexable text for a profile.
 *
 * The paragraph is the unit, because `chunkProfileText` splits on blank lines.
 * One FAQ per paragraph means a retrieval hit returns that answer rather than
 * an arbitrary window across three unrelated questions.
 *
 * Only the policy fields the selected business type shows are rendered; the
 * rest stay stored but unindexed, so the agent never quotes a field the form
 * no longer displays.
 *
 * A profile whose every field is blank renders to "" — deliberately identical
 * to a cleared textarea, so `blankedFields` still recognises the clear.
 */
export function renderBusinessProfileText(profile: BusinessProfile): string {
  const sections: string[] = [];
  const addSection = (label: string, body?: string) => {
    const trimmed = (body ?? "").trim();
    if (trimmed) sections.push(`${label}:\n${trimmed}`);
  };

  if (profile.industry) sections.push(`Business type: ${INDUSTRY_LABELS[profile.industry]}`);
  addSection("Products and services", profile.products);
  for (const key of policyKeysForIndustry(profile.industry)) {
    addSection(POLICY_LABELS[key], profile.policies?.[key]);
  }
  for (const faq of profile.faqs ?? []) {
    const question = faq.q.trim();
    const answer = faq.a.trim();
    // Half an entry is worse than none: "FAQ: Do you ship abroad?" with no
    // answer reads to the model as a fact it may complete.
    if (question && answer) sections.push(`FAQ: ${question}\n${answer}`);
  }
  addSection("Additional notes", profile.notes);

  return sections.join("\n\n");
}
