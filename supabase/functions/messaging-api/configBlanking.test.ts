import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { blankedFields } from "./configBlanking.ts";
import { renderBusinessProfileText } from "../_shared/businessProfileText.ts";

const STORED = {
  persona_instructions: "You are the voice of Eltamlawy Chicks.",
  business_profile_text: "We sell day-old chicks and veterinary medicine.",
};

Deno.test("a payload that empties a stored field is reported", () => {
  assertEquals(
    blankedFields({ persona_instructions: "" }, STORED),
    ["persona_instructions"],
  );
});

Deno.test("both guarded fields are checked, not only the persona", () => {
  // The Knowledge tab writes business_profile_text alone. Naming only the
  // persona here is how the same outage returns through the other tab.
  assertEquals(
    blankedFields({ business_profile_text: "   " }, STORED),
    ["business_profile_text"],
  );
  assertEquals(
    blankedFields({ persona_instructions: "", business_profile_text: "" }, STORED),
    ["persona_instructions", "business_profile_text"],
  );
});

Deno.test("a field the payload does not mention is never blanked", () => {
  // ai_upsert_config builds `updates` only from keys present in the request, so
  // an absent key cannot clear anything and must not be reported.
  assertEquals(blankedFields({ is_enabled: true }, STORED), []);
});

Deno.test("writing over an already-empty field is not a blanking", () => {
  assertEquals(
    blankedFields({ persona_instructions: "" }, { persona_instructions: "" }),
    [],
  );
  assertEquals(
    blankedFields({ persona_instructions: "" }, { persona_instructions: null }),
    [],
  );
});

Deno.test("there is nothing to protect when no config exists yet", () => {
  // First-ever save for an account. Refusing this would block config creation
  // exactly as the 2026-08-28 SET NOT NULL did.
  assertEquals(blankedFields({ persona_instructions: "" }, null), []);
});

Deno.test("a non-empty value is never a blanking", () => {
  assertEquals(blankedFields({ persona_instructions: "New voice" }, STORED), []);
});

// --- The structured profile feeds the same guard ---------------------------
//
// business_profile_text is now DERIVED, rendered server-side from
// business_profile. The blanking guard still protects the column, so the
// renderer and the guard have to agree on what "empty" means -- a profile the
// user emptied field by field must be indistinguishable from a cleared
// textarea, or the 2026-08-30 protection quietly stops applying to the new UI.

Deno.test("a structured profile emptied field by field still trips the guard", () => {
  const updates = { business_profile_text: renderBusinessProfileText({ products: "  " }) };
  assertEquals(blankedFields(updates, STORED), ["business_profile_text"]);
});

Deno.test("a filled structured profile is not a blanking", () => {
  const updates = { business_profile_text: renderBusinessProfileText({ products: "shoes" }) };
  assertEquals(blankedFields(updates, STORED), []);
});
