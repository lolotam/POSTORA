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

export type BusinessIndustry =
  | "ecommerce"
  | "clinic"
  | "b2b_services"
  | "restaurant"
  | "other";

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
}

/** Kept in step with INDUSTRY_LABELS in the server module. */
const INDUSTRY_LABELS: Record<BusinessIndustry, string> = {
  ecommerce: "E-commerce store",
  clinic: "Clinic or medical practice",
  b2b_services: "B2B services",
  restaurant: "Restaurant or cafe",
  other: "Other",
};

export const INDUSTRY_OPTIONS: { value: BusinessIndustry; label: string }[] = (
  Object.keys(INDUSTRY_LABELS) as BusinessIndustry[]
).map((value) => ({ value, label: INDUSTRY_LABELS[value] }));

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
  addSection("Returns policy", profile.policies?.returns);
  addSection("Shipping policy", profile.policies?.shipping);
  addSection("Warranty policy", profile.policies?.warranty);
  for (const faq of profile.faqs ?? []) {
    const question = faq.q.trim();
    const answer = faq.a.trim();
    if (question && answer) sections.push(`FAQ: ${question}\n${answer}`);
  }
  addSection("Additional notes", profile.notes);

  return sections.join("\n\n");
}
