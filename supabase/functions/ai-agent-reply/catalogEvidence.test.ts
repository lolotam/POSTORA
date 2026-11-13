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

Deno.test("quantities and short generic catalog identities cannot score grounding", () => {
  for (const identity of [{ id: "1" }, { sku: "2" }, { name_en: "Cream" }, { name_ar: "????" }]) {
    assertEquals(catalogGrounded("Take 1 tablet, use 2 Cream ????", [identity]), false);
  }
  assertEquals(catalogGrounded("Heel Cream is listed", [{ name_en: "Heel Cream" }]), true);
  assertEquals(catalogGrounded("Use TEST-HEEL-01", [{ sku: "TEST-HEEL-01" }]), true);
});

Deno.test("specific single-token names and root product URLs can score grounding", () => {
  assertEquals(catalogGrounded("Augmentin is listed", [{ name_en: "Augmentin" }]), true);
  assertEquals(catalogGrounded("Augmentination", [{ name_en: "Augmentin" }]), false);
  assertEquals(catalogGrounded("See https://brand.example/", [{ product_url: "https://brand.example/" }]), true);
  assertEquals(catalogGrounded("See https://other.example/", [{ product_url: "https://brand.example/" }]), false);
  assertEquals(catalogGrounded("javascript:alert(1)", [{ product_url: "javascript:alert(1)" }]), false);
});
