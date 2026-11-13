import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { catalogEvidenceFromOutput, catalogGrounded } from "./catalogEvidence.ts";

Deno.test("sandbox catalog evidence exposes identity fields and distinguishes unrelated answers", () => {
  const rows = catalogEvidenceFromOutput('Connector "Catalog" returned: ' + JSON.stringify({ rows: [{
    id: "fixture-product", name_en: "Heel Cream", product_url: "https://example.invalid/heel",
    internal_notes: "private vendor field", price_kwd: 7,
  }] }));
  assertEquals(rows, [{ id: "fixture-product", name_en: "Heel Cream", product_url: "https://example.invalid/heel" }]);
  assertEquals(catalogGrounded("Heel Cream: https://example.invalid/heel", rows), true);
  assertEquals(catalogGrounded("An unrelated medicine is available", rows), false);
  assertEquals(catalogGrounded("Heel Creamery", rows), false);
  assertEquals(catalogEvidenceFromOutput('Connector "Catalog" failed'), []);
  assertEquals(catalogEvidenceFromOutput('Connector "Catalog" returned: truncated {'), []);
});
