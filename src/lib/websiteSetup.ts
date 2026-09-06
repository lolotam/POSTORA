import {
  GOAL_OPTIONS, INDUSTRY_OPTIONS, RESPONSE_LENGTH_OPTIONS, TONE_OPTIONS,
  type AgentBehavior, type BusinessProfile,
} from "@/lib/agentProfile";

export interface WebsiteSetupResult {
  business_profile: BusinessProfile;
  agent_behavior: AgentBehavior;
  evidence: Record<string, string[]>;
  coverage: { mode: "page" | "site"; pages: number; truncated: boolean };
}

export interface WebsiteSetupJob {
  id: string;
  source_id: string;
  social_account_id: string;
  platform: string;
  status: "pending" | "processing" | "ready" | "failed" | "applied";
  error: string | null;
  result: WebsiteSetupResult | null;
  created_at: string;
  updated_at: string;
}

interface FieldDefinition {
  path: string;
  label: string;
  suggestion: boolean;
  read: (profile: BusinessProfile, behavior: AgentBehavior) => string;
}

const optionLabel = (options: readonly { value: string; label: string }[], value?: string) =>
  options.find((option) => option.value === value)?.label ?? value ?? "";

// Display and selection use only this explicit contract, never arbitrary model keys.
const FIELD_DEFINITIONS: FieldDefinition[] = [
  { path: "business_profile.industry", label: "Business type", suggestion: false,
    read: (profile) => optionLabel(INDUSTRY_OPTIONS, profile.industry) },
  { path: "business_profile.products", label: "Products and services", suggestion: false,
    read: (profile) => profile.products ?? "" },
  ...(["returns", "shipping", "warranty"] as const).map((policy) => ({
    path: `business_profile.policies.${policy}`,
    label: `${policy[0].toUpperCase()}${policy.slice(1)} policy`, suggestion: false,
    read: (profile: BusinessProfile) => profile.policies?.[policy] ?? "",
  })),
  { path: "business_profile.faqs", label: "Frequently asked questions", suggestion: false,
    read: (profile) => (profile.faqs ?? []).map((faq) => `${faq.q}\n${faq.a}`).join("\n\n") },
  { path: "business_profile.notes", label: "Additional notes", suggestion: false,
    read: (profile) => profile.notes ?? "" },
  { path: "agent_behavior.tone", label: "Tone of voice", suggestion: true,
    read: (_, behavior) => optionLabel(TONE_OPTIONS, behavior.tone) },
  { path: "agent_behavior.response_length", label: "Reply length", suggestion: true,
    read: (_, behavior) => optionLabel(RESPONSE_LENGTH_OPTIONS, behavior.response_length) },
  { path: "agent_behavior.goals", label: "Agent objectives", suggestion: true,
    read: (_, behavior) => (behavior.goals ?? []).map((goal) => optionLabel(GOAL_OPTIONS, goal)).join("\n") },
  { path: "agent_behavior.greeting", label: "Opening message", suggestion: true,
    read: (_, behavior) => behavior.greeting ?? "" },
  { path: "agent_behavior.instruction_blocks", label: "Instruction blocks", suggestion: true,
    read: (_, behavior) => (behavior.instruction_blocks ?? []).map((block) => `${block.title}\n${block.body}`).join("\n\n") },
];

export function draftFields(result: WebsiteSetupResult, profile: BusinessProfile, behavior: AgentBehavior) {
  return FIELD_DEFINITIONS.map((field) => {
    const proposed = field.read(result.business_profile, result.agent_behavior).trim();
    const current = field.read(profile, behavior).trim();
    return {
      path: field.path, label: field.label, suggestion: field.suggestion,
      proposed, current, selected: !!proposed && !current,
      evidence: result.evidence[field.path] ?? [],
    };
  });
}

export function websiteIndexingMessage(response: { queued?: boolean; chunk_count?: number }) {
  if (response.queued) return "Website queued — watch indexing and setup progress below";
  if (typeof response.chunk_count === "number") return "Page indexed";
  return "Website accepted — watch the sources list below";
}

/** A refresh can add extracted fields while the user edits another field. */
export function mergeProfileRefresh(current: BusinessProfile, baseline: BusinessProfile, incoming: BusinessProfile): BusinessProfile {
  const choose = <T,>(local: T, previous: T, next: T): T =>
    JSON.stringify(local) === JSON.stringify(previous) ? next : local;
  const policies = {
    returns: choose(current.policies?.returns, baseline.policies?.returns, incoming.policies?.returns),
    shipping: choose(current.policies?.shipping, baseline.policies?.shipping, incoming.policies?.shipping),
    warranty: choose(current.policies?.warranty, baseline.policies?.warranty, incoming.policies?.warranty),
  };
  return {
    industry: choose(current.industry, baseline.industry, incoming.industry),
    products: choose(current.products, baseline.products, incoming.products),
    faqs: choose(current.faqs, baseline.faqs, incoming.faqs),
    notes: choose(current.notes, baseline.notes, incoming.notes),
    ...(Object.values(policies).some((policy) => policy !== undefined) ? { policies } : {}),
  };
}
