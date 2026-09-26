/**
 * Client mirror of the structured business profile and agent behavior.
 *
 * THE AUTHORITY IS THE SERVER. `supabase/functions/_shared/businessProfileText.ts`
 * and `_shared/agentBehavior.ts` define these shapes, validate them, and — for
 * the profile — render the text the vector database is built from. Both parsers
 * reject unknown keys by name, so a field added here and not there produces a
 * 400 naming the key rather than a silent drop. That is the intended failure
 * mode, but a confusing one to debug: change both files together.
 */
import type { ProcedureKey, ProcedureSettings } from "./procedureTemplates";

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

/** Kept in step with INDUSTRY_LABELS in the server module. */
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

export const INDUSTRY_OPTIONS: { value: BusinessIndustry; label: string }[] = (
  Object.keys(INDUSTRY_LABELS) as BusinessIndustry[]
).map((value) => ({ value, label: INDUSTRY_LABELS[value] }));

/** Kept in step with POLICY_KEYS in the server module; this is the render order. */
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

/** Kept in step with INDUSTRY_FIELDS in the server module. */
const INDUSTRY_FIELDS: Record<BusinessIndustry, readonly BusinessPolicyKey[]> = {
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

/**
 * The fields a profile of this type shows, in render order. No type, or
 * "other", shows every field. A field outside the type is kept in the stored
 * profile but neither shown nor indexed until the type shows it again.
 */
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

export type AgentTone = "friendly_professional" | "formal" | "enthusiastic" | "concise";
export type AgentResponseLength = "short" | "medium" | "detailed";
export type AgentGoal =
  | "recommend_products"
  | "answer_pricing"
  | "handle_complaints"
  | "capture_leads";

export interface AgentInstructionBlock {
  title: string;
  body: string;
}

export interface AgentBehavior {
  tone?: AgentTone;
  response_length?: AgentResponseLength;
  goals?: AgentGoal[];
  greeting?: string;
  instruction_blocks?: AgentInstructionBlock[];
  procedures?: Partial<Record<ProcedureKey, ProcedureSettings>>;
}

export const TONE_OPTIONS: { value: AgentTone; label: string; hint: string }[] = [
  {
    value: "friendly_professional",
    label: "Friendly and professional",
    hint: "Warm, but never careless.",
  },
  { value: "formal", label: "Formal", hint: "Courteous. No slang, no emoji." },
  { value: "enthusiastic", label: "Enthusiastic", hint: "Energetic about the products." },
  { value: "concise", label: "Concise", hint: "Straight to the point, no filler." },
];

export const RESPONSE_LENGTH_OPTIONS: { value: AgentResponseLength; label: string; hint: string }[] = [
  { value: "short", label: "Short", hint: "One or two sentences." },
  { value: "medium", label: "Medium", hint: "A short paragraph." },
  { value: "detailed", label: "Detailed", hint: "A full answer, with steps when useful." },
];

export const GOAL_OPTIONS: { value: AgentGoal; label: string }[] = [
  { value: "recommend_products", label: "Recommend products and help customers choose" },
  { value: "answer_pricing", label: "Answer price, stock and availability questions" },
  { value: "handle_complaints", label: "Handle complaints and objections" },
  { value: "capture_leads", label: "Capture names and contact details of interested customers" },
];

/**
 * A LOCAL PREVIEW of the text the server will store and index.
 *
 * This is not decoration. The Knowledge tab has to decide whether a save would
 * blank a stored profile, and it must reach the same verdict the server will:
 * if the client under-reports "this renders to empty", it omits `confirm_clear`,
 * the server renders "" anyway and refuses with a 409 — and the user can then
 * never clear their profile, retrying forever.
 *
 * So this is a verbatim port of `renderBusinessProfileText` in
 * `supabase/functions/_shared/businessProfileText.ts`, not an approximation.
 * The two must produce identical output for identical input; the vitest suite
 * copies the server's own "blank-only fields render to empty" fixture to pin it.
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
    if (question && answer) sections.push(`FAQ: ${question}\n${answer}`);
  }
  addSection("Additional notes", profile.notes);

  return sections.join("\n\n");
}
