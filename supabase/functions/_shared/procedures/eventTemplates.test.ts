import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ensureEventTemplate,
  eventTemplateDefinition,
  templateSendComponents,
  type GraphTemplate,
  type TemplateGraph,
} from "./eventTemplates.ts";
import { EVENT_PROCEDURE_KEYS } from "./templates.ts";

Deno.test("every template variable has an example", () => {
  for (const flow of EVENT_PROCEDURE_KEYS) {
    for (const language of ["ar", "en"] as const) {
      const definition = eventTemplateDefinition(flow, language);
      const variables = definition.body.match(/\{\{\d+\}\}/g) ?? [];
      assertEquals(definition.examples.length, variables.length);
      assertEquals(definition.name, `postora_${flow}_v1`);
    }
  }
  const cod = eventTemplateDefinition("cod_confirm", "ar");
  assertEquals(cod.category, "UTILITY");
  assertEquals(cod.buttons, ["تأكيد", "إلغاء"]);
  assertEquals(eventTemplateDefinition("back_in_stock", "en").category, "MARKETING");
});

function graph(list: GraphTemplate[], created: string[] = []): TemplateGraph & { created: string[] } {
  return {
    created,
    list: (name) => Promise.resolve(list.filter((row) => row.name === name)),
    create: (body) => {
      created.push(String(body.name));
      return Promise.resolve({ id: "new" });
    },
  };
}

Deno.test("an approved template is reused and not created", async () => {
  const fake = graph([{ name: "postora_cod_confirm_v1", status: "APPROVED", language: "ar", category: "UTILITY" }]);
  const result = await ensureEventTemplate(fake, "cod_confirm", "ar", { create: true });
  assertEquals(result.status, "approved");
  assertEquals(result.name, "postora_cod_confirm_v1");
  assertEquals(fake.created, []);
});

Deno.test("a pending template is reported without a create", async () => {
  const fake = graph([{ name: "postora_review_request_v1", status: "PENDING", language: "en", category: "UTILITY" }]);
  const result = await ensureEventTemplate(fake, "review_request", "en");
  assertEquals(result, { status: "pending", name: "postora_review_request_v1", language: "en", category: "UTILITY" });
  assertEquals(fake.created, []);
});

Deno.test("a rejected v1 creates v2", async () => {
  const fake = graph([{ name: "postora_cod_confirm_v1", status: "REJECTED", language: "ar", category: "UTILITY" }]);
  const result = await ensureEventTemplate(fake, "cod_confirm", "ar", { create: true });
  assertEquals(fake.created, ["postora_cod_confirm_v2"]);
  assertEquals(result.name, "postora_cod_confirm_v2");
  assertEquals(result.status, "pending");
});

Deno.test("a duplicate-name error means the template already exists", async () => {
  const created: string[] = [];
  const fake: TemplateGraph = {
    list: (name) => Promise.resolve(name.endsWith("_v1") ? [] : [{ name, status: "PENDING", language: "ar", category: "MARKETING" }]),
    create: (body) => {
      created.push(String(body.name));
      if (created.length === 1) return Promise.resolve({ error: { message: "template name already exists", code: 100 } });
      return Promise.resolve({ id: "new" });
    },
  };
  const result = await ensureEventTemplate(fake, "back_in_stock", "ar", { create: true });
  assertEquals(created, ["postora_back_in_stock_v1"]);
  assertEquals(result.status, "pending");
  assertEquals(result.name, "postora_back_in_stock_v1");
});

Deno.test("COD send components carry the event decision payloads", () => {
  const components = templateSendComponents("cod_confirm", "en", { first_name: "Sara", order_number: "9", total: "1", currency: "KWD" }, "evt-1");
  assertEquals(components[1], {
    type: "button",
    sub_type: "quick_reply",
    index: "0",
    parameters: [{ type: "payload", payload: "cod:evt-1:confirm" }],
  });
  assertEquals(components[2], {
    type: "button",
    sub_type: "quick_reply",
    index: "1",
    parameters: [{ type: "payload", payload: "cod:evt-1:cancel" }],
  });
});
