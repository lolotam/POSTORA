import {
  type BusinessProfile,
  parseBusinessProfile,
  renderBusinessProfileText,
} from "../_shared/businessProfileText.ts";
import {
  type AgentBehavior,
  parseAgentBehavior,
} from "../_shared/agentBehavior.ts";

export const SETUP_FIELDS = [
  "business_profile.industry",
  "business_profile.products",
  "business_profile.policies.returns",
  "business_profile.policies.shipping",
  "business_profile.policies.warranty",
  "business_profile.faqs",
  "business_profile.notes",
  "agent_behavior.tone",
  "agent_behavior.response_length",
  "agent_behavior.goals",
  "agent_behavior.greeting",
  "agent_behavior.instruction_blocks",
] as const;
export interface WebsiteSetupDraft {
  business_profile: BusinessProfile;
  agent_behavior: AgentBehavior;
  evidence: Record<string, string[]>;
  coverage: { mode: "page" | "site"; pages: number; truncated: boolean };
}
export function fieldValue(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) =>
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined,
    input,
  );
}
export function parseDraft(
  input: unknown,
  urls: readonly string[],
  coverage: WebsiteSetupDraft["coverage"],
): WebsiteSetupDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid setup draft");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      !["business_profile", "agent_behavior", "evidence"].includes(key)
    )
  ) {
    throw new Error("Unexpected setup draft field");
  }
  const business_profile = parseBusinessProfile(value.business_profile);
  const agent_behavior = parseAgentBehavior(value.agent_behavior);
  if (
    business_profile.industry &&
    !["ecommerce", "clinic", "b2b_services", "restaurant", "other"].includes(
      business_profile.industry,
    )
  ) {
    throw new Error("Invalid business industry");
  }
  if (
    JSON.stringify(business_profile).length > 16000 ||
    JSON.stringify(agent_behavior).length > 12000
  ) {
    throw new Error("Setup draft is too long");
  }
  const evidence: Record<string, string[]> = {};
  const refs = value.evidence;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) {
    throw new Error("Missing source attribution");
  }
  for (const [path, references] of Object.entries(refs)) {
    if (
      !SETUP_FIELDS.includes(path as typeof SETUP_FIELDS[number]) ||
      !path.startsWith("business_profile.")
    ) {
      throw new Error("Invalid source attribution field");
    }
    if (
      !Array.isArray(references) || references.length > 20 ||
      references.some((url) => typeof url !== "string" || !urls.includes(url))
    ) {
      throw new Error("Source attribution is outside the crawled pages");
    }
    evidence[path] = [...new Set(references)];
  }
  for (
    const path of SETUP_FIELDS.filter((field) =>
      field.startsWith("business_profile.")
    )
  ) {
    const fact = fieldValue({ business_profile }, path);
    if (
      fact !== undefined &&
      (typeof fact === "string"
        ? !fact.trim()
        : Array.isArray(fact) && !fact.length)
    ) {
      throw new Error("Unknown facts must be omitted");
    }
    if (fact !== undefined && !evidence[path]?.length) {
      throw new Error("Business facts require source attribution");
    }
  }
  if (business_profile.faqs?.some((faq) => !faq.q.trim() || !faq.a.trim())) {
    throw new Error("Incomplete FAQ");
  }
  return { business_profile, agent_behavior, evidence, coverage };
}

export interface ConfigSnapshot {
  business_profile?: unknown;
  business_profile_text?: string | null;
  agent_behavior?: unknown;
  updated_at?: string | null;
}
export function mergeDraft(
  config: ConfigSnapshot | null,
  draft: WebsiteSetupDraft,
  fields: string[],
) {
  if (
    !fields.length || fields.length > SETUP_FIELDS.length ||
    new Set(fields).size !== fields.length
  ) {
    throw new Error("Select at least one unique setup field");
  }
  let profile = parseBusinessProfile(config?.business_profile);
  const legacy = config?.business_profile_text ?? "";
  if (renderBusinessProfileText(profile).trim() !== legacy.trim()) {
    profile = { notes: legacy };
  }
  const merged = {
    business_profile: structuredClone(profile),
    agent_behavior: parseAgentBehavior(config?.agent_behavior),
  };
  for (const path of fields) {
    if (!SETUP_FIELDS.includes(path as typeof SETUP_FIELDS[number])) {
      throw new Error("Unsupported setup field");
    }
    const value = fieldValue(draft, path);
    if (value === undefined) {
      throw new Error("Selected field is missing from the draft");
    }
    const parts = path.split(".");
    let target = merged as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts.at(-1)!] = structuredClone(value);
  }
  return {
    business_profile: parseBusinessProfile(merged.business_profile),
    agent_behavior: parseAgentBehavior(merged.agent_behavior),
    // Behavior-only applications must not rewrite a legacy profile.
    business_profile_text:
      fields.some((path) => path.startsWith("business_profile."))
        ? renderBusinessProfileText(merged.business_profile)
        : config?.business_profile_text ?? null,
  };
}
