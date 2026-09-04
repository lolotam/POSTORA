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
 */

export type BusinessIndustry =
  | "ecommerce"
  | "clinic"
  | "b2b_services"
  | "restaurant"
  | "other";

const INDUSTRY_LABELS: Record<BusinessIndustry, string> = {
  ecommerce: "E-commerce store",
  clinic: "Clinic or medical practice",
  b2b_services: "B2B services",
  restaurant: "Restaurant or cafe",
  other: "Other",
};

export interface BusinessProfilePolicies {
  returns?: string;
  shipping?: string;
  warranty?: string;
}

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
const POLICY_KEYS = ["returns", "shipping", "warranty"] as const;
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
        `industry must be one of: ${Object.keys(INDUSTRY_LABELS).join(", ")}`,
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
  addSection("Returns policy", profile.policies?.returns);
  addSection("Shipping policy", profile.policies?.shipping);
  addSection("Warranty policy", profile.policies?.warranty);
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
