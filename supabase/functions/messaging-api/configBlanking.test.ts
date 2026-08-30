import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { blankedFields } from "./configBlanking.ts";

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
