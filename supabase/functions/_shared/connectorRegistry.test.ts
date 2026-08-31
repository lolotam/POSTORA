import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { CONNECTOR_TYPES, connectorDefinition } from "./connectorRegistry.ts";

Deno.test("every declared connector type has credentials and a usage guide", () => {
  for (const type of CONNECTOR_TYPES) {
    const definition = connectorDefinition(type);

    assertEquals(definition.type, type);
    assertEquals(typeof definition.label, "string");
    assert(Array.isArray(definition.credentials));

    for (const field of definition.credentials) {
      assertEquals(typeof field.key, "string");
      assertEquals(typeof field.label, "string");
      assert(["text", "secret", "url"].includes(field.kind));
      assertEquals(typeof field.required, "boolean");
      assertEquals(typeof field.help, "string");
    }

    if (type === "custom_rest") {
      assertEquals(definition.usageGuide, undefined);
    } else {
      assertEquals(typeof definition.usageGuide?.whenToUse, "string");
      assert(Array.isArray(definition.usageGuide?.requestExamples));
      assertEquals(typeof definition.usageGuide?.limits, "string");
    }
  }
});

Deno.test("an unknown connector type throws and names itself", () => {
  const error = assertThrows(
    () => connectorDefinition("stripe_v2" as never),
    Error,
  );

  assert(error.message.includes("stripe_v2"));
});
