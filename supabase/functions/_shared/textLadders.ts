import { z } from "npm:zod@3.23.8";

export const textCategorySchema = z.enum(["caption", "hashtags"]);
export type TextCategory = z.infer<typeof textCategorySchema>;
export const textTierSchema = z.object({ provider_code: z.string().trim().min(1), model_id: z.string().trim().min(1), auth_method: z.enum(["api_key", "oauth"]).optional() }).passthrough();
export type TextTier = z.infer<typeof textTierSchema>;
export const textTierKeys = (category: string) => [`default_ai_model_${category}`, `default_ai_model_${category}_fallback`, `default_ai_model_${category}_fallback_2`];

export class TextLadderError extends Error {
  constructor(public readonly code: "invalid_text_chain" | "ai_output_cap_unsupported") { super(code); }
}

/** Only absence of every row means inheritance. Never fill an orphan from Chat. */
export function parseTextLadder(rows: Array<{ key: string; value: unknown }>, category: string): TextTier[] | null {
  const keys = textTierKeys(category);
  if (!rows.some(row => keys.includes(row.key))) return null;
  const tiers: TextTier[] = [];
  let gap = false;
  for (const key of keys) {
    let stored = rows.find(row => row.key === key)?.value;
    if (typeof stored === "string") {
      try { stored = JSON.parse(stored); } catch { throw new TextLadderError("invalid_text_chain"); }
    }
    if (stored == null) { gap = true; continue; }
    const parsed = textTierSchema.safeParse(stored);
    if (gap || !parsed.success) throw new TextLadderError("invalid_text_chain");
    tiers.push(parsed.data);
  }
  if (!tiers.length) throw new TextLadderError("invalid_text_chain");
  return tiers;
}

export function supportsOutputCap(tier: { provider: string; authMethod?: string; credentialSource?: string }): boolean {
  return tier.credentialSource === "user" || tier.authMethod !== "oauth" || tier.provider !== "openai";
}

/** Same Chat floor policy, explicitly shared by both new text categories. */
export const TEXT_LAST_RESORT = { provider: "google", model: "gemini-3-flash-preview" };
