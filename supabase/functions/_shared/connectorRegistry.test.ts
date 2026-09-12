import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  CONNECTOR_TYPES,
  PENDING_DB_CONNECTOR_TYPES,
  composioBinding,
  connectorDefinition,
  isComposioType,
  shouldUseAdapter,
} from "./connectorRegistry.ts";

// Empty at HEAD: migration 20260903120000 admitted the seven Composio types
// before the registry commit that added them (see the browser test's note).
const PENDING_TYPES: readonly string[] = [];

Deno.test("every connector declares its strategy, category, and valid Composio binding", () => {
  for (const type of CONNECTOR_TYPES) {
    const definition = connectorDefinition(type);
    assert(["manual_credentials", "composio_oauth"].includes(definition.auth_strategy));
    assert(["ecommerce_payments", "productivity_crm", "databases", "automation"].includes(definition.category));
    const isComposio = definition.auth_strategy === "composio_oauth";
    assertEquals(Boolean(definition.composio), isComposio);
    assertEquals(isComposioType(type), isComposio);
    assertEquals(composioBinding(type), definition.composio);
    if (definition.composio) {
      assertEquals(definition.credentials, []);
      assert(definition.composio.tools.length > 0);
      assertEquals(new Set(definition.composio.tools).size, definition.composio.tools.length);
      assert(definition.composio.mutating.every((slug) => definition.composio?.tools.includes(slug)));
      assert(/^\d{8}_\d{2}$|^latest$/.test(definition.composio.toolkitVersion));
    }
  }
});

Deno.test("the database seam is empty because the Composio migration precedes the registry", () => {
  assertEquals([...PENDING_DB_CONNECTOR_TYPES], [...PENDING_TYPES]);
});

Deno.test("every declared connector type has credentials and a usage guide", () => {
  for (const type of CONNECTOR_TYPES) {
    const definition = connectorDefinition(type);

    assertEquals(definition.type, type);
    assertEquals(typeof definition.label, "string");
    assert(Array.isArray(definition.credentials));

    for (const field of definition.credentials) {
      assertEquals(typeof field.key, "string");
      assertEquals(typeof field.label, "string");
      assert(["text", "secret", "url", "hidden"].includes(field.kind));
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

    if (type === "woocommerce" || type === "supabase") {
      assert((definition.capabilities?.length ?? 0) > 0);
    } else {
      assertEquals(definition.capabilities, undefined);
    }
  }
});

Deno.test("only connector types with live capability adapters opt into adapter routing", () => {
  assertEquals(shouldUseAdapter({ connector_type: "woocommerce" }), true);
  assertEquals(shouldUseAdapter({ connector_type: "supabase" }), true);
  assertEquals(shouldUseAdapter({ connector_type: "custom_rest" }), false);
  assertEquals(shouldUseAdapter({ connector_type: "shopify" }), false);
  assertEquals(shouldUseAdapter({ connector_type: "historical_unknown" }), false);
});

Deno.test("an unknown connector type throws and names itself", () => {
  const error = assertThrows(
    () => connectorDefinition("stripe_v2" as never),
    Error,
  );

  assert(error.message.includes("stripe_v2"));
});
