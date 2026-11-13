import { z } from "npm:zod@3.23.8";

const boundedText = z.string().max(2048).optional();
export const CatalogEvidenceSchema = z.object({
  id: boundedText,
  sku: boundedText,
  product_url: boundedText,
  name_ar: boundedText,
  name_en: boundedText,
});
export type CatalogEvidence = z.infer<typeof CatalogEvidenceSchema>;

/** Expose only product identity fields already returned to the authenticated sandbox. */
export function catalogEvidenceFromOutput(output: string): CatalogEvidence[] {
  const prefix = output.indexOf(" returned: ");
  if (prefix < 0) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(output.slice(prefix + " returned: ".length));
  } catch {
    return [];
  }
  const parsed = z.object({ rows: z.array(z.unknown()) }).safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.rows.slice(0, 100).flatMap((row) => {
    const evidence = CatalogEvidenceSchema.safeParse(row);
    return evidence.success && Object.values(evidence.data).some(Boolean) ? [evidence.data] : [];
  });
}

/** Identity-match score, not a verification of every factual claim in the reply. */
export function catalogGrounded(reply: string, rows: readonly CatalogEvidence[]): boolean {
  const text = reply.normalize("NFKC").toLowerCase();
  return rows.some((row) => Object.values(row).some((value) => {
    if (!value?.trim()) return false;
    const identity = value.normalize("NFKC").toLowerCase();
    // A boundary prevents a short SKU or name matching the middle of an unrelated word.
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
  }));
}
