import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { groupCatalogueRows } from "./aiModelCatalogue.ts";

Deno.test("the catalogue is split by credential kind", () => {
  const grouped = groupCatalogueRows([
    { id: "1", model_id: "gpt-5", auth_method: "api_key" },
    { id: "2", model_id: "gpt-5", auth_method: "oauth" },
    { id: "3", model_id: "claude-sonnet", auth_method: "api_key" },
  ]);
  // The same model_id exists once per credential kind.
  assertEquals(grouped.models.map((r) => r.id), ["1", "3"]);
  assertEquals(grouped.oauthModels.map((r) => r.id), ["2"]);
});

Deno.test("a row with no credential kind is an api-key row", () => {
  const grouped = groupCatalogueRows([
    { id: "1", model_id: "gpt-5" },
    { id: "2", model_id: "gpt-5", auth_method: "oauth" },
  ]);
  // The column did not exist before the catalogue was keyed by credential kind,
  // and an unknown value must not disappear from the list the admin reads.
  assertEquals(grouped.models.map((r) => r.id), ["1"]);
  assertEquals(grouped.oauthModels.map((r) => r.id), ["2"]);
});

Deno.test("an empty catalogue is two empty lists", () => {
  const grouped = groupCatalogueRows([]);
  assertEquals(grouped.models, []);
  assertEquals(grouped.oauthModels, []);
});
