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

/** Reject short/numeric identities that can match quantities or generic prose. */
function specificIdentities(row: CatalogEvidence): string[] {
  const identifiers = [row.id, row.sku].filter((value): value is string =>
    Boolean(value && value.trim().length >= 6 && /\p{L}/u.test(value))
  );
  const names = [row.name_ar, row.name_en].filter((value): value is string =>
    Boolean(value && (value.match(/\p{L}/gu)?.length ?? 0) >= 8)
  );
  return [...identifiers, ...names];
}

/** URL objects preserve path case and reject another origin sharing a host prefix. */
function catalogUrlInReply(reply: string, productUrl: string | undefined): boolean {
  try {
    const expected = new URL(productUrl ?? "");
    if (expected.protocol !== "https:" && expected.protocol !== "http:") return false;
    const tokens = reply.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
    return tokens.some((token) => {
      const spellings = [token, token.replace(/[.,;!?)}\]]+$/u, "")];
      return spellings.some((spelling) => {
        try { return new URL(spelling).href === expected.href; } catch { return false; }
      });
    });
  } catch {
    return false;
  }
}

/** Identity-match score, not a verification of every factual claim in the reply. */
export function catalogGrounded(reply: string, rows: readonly CatalogEvidence[]): boolean {
  const text = reply.normalize("NFKC").toLowerCase();
  return rows.some((row) => catalogUrlInReply(reply, row.product_url) || specificIdentities(row).some((value) => {
    const identity = value.normalize("NFKC").toLowerCase();
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
  }));
}
