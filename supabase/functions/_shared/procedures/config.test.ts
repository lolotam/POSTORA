// supabase/functions/_shared/procedures/config.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { enabledProcedures, parseProcedureConfig, readProcedureConfig, reviewDelayDays } from "./config.ts";
import { AgentBehaviorError } from "../agentBehaviorError.ts";

const valid = {
  order_status: { enabled: true, prompts: { order_number: "Ask for the order number" }, closing: "" },
  product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "For whom?"] },
};

Deno.test("a valid config round-trips and lists enabled flows in key order", () => {
  const parsed = parseProcedureConfig(valid);
  assertEquals(parsed.order_status?.prompts, { order_number: "Ask for the order number" });
  assertEquals(enabledProcedures(parsed), ["order_status", "product_finder"]);
});

for (const [label, input] of [
  ["unknown procedure key", { weather: { enabled: true, prompts: {}, closing: "" } }],
  ["prompt longer than 300 characters", { lead_capture: { enabled: true, prompts: { name: "x".repeat(301) }, closing: "" } }],
  ["product finder with one question", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] } }],
  ["product finder with four questions", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["a", "b", "c", "d"] } }],
  ["21 booking services", { booking: { enabled: true, prompts: {}, closing: "", services: Array(21).fill("s") } }],
  ["prompt for a field the template lacks", { booking: { enabled: true, prompts: { colour: "x" }, closing: "" } }],
  ["a blank product finder question", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "  "] } }],
  ["a blank booking service", { booking: { enabled: true, prompts: {}, closing: "", services: ["Haircut", ""] } }],
] as const) {
  Deno.test(`parseProcedureConfig rejects ${label}`, () => {
    assertThrows(() => parseProcedureConfig(input), AgentBehaviorError);
  });
}

const CONSENT = "2026-09-01T00:00:00Z";
const QR = "2026-09-02T00:00:00.000Z";

Deno.test("event flows save only with their required settings", () => {
  const parsed = parseProcedureConfig({
    cod_confirm: { enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT, qr_risk_acknowledged_at: QR },
    review_request: {
      enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT,
      review_url: "https://shop.example/reviews",
    },
    back_in_stock: { enabled: true, prompts: {}, closing: "", qr_risk_acknowledged_at: QR },
  });
  assertEquals(parsed.cod_confirm?.consent_attested_at, CONSENT);
  assertEquals(parsed.cod_confirm?.qr_risk_acknowledged_at, QR);
  assertEquals(parsed.review_request?.delay_days, 3);
  assertEquals(parsed.review_request?.review_url, "https://shop.example/reviews");
  assertEquals(parsed.back_in_stock?.qr_risk_acknowledged_at, QR);
  assertEquals(enabledProcedures(parsed), ["cod_confirm", "review_request", "back_in_stock"]);
});

Deno.test("enabling cod_confirm or review_request without consent is rejected", () => {
  assertThrows(
    () => parseProcedureConfig({ cod_confirm: { enabled: true, prompts: {}, closing: "" } }),
    AgentBehaviorError,
  );
  assertThrows(
    () => parseProcedureConfig({
      review_request: { enabled: true, prompts: {}, closing: "", review_url: "https://shop.example/reviews" },
    }),
    AgentBehaviorError,
  );
  assertThrows(
    () => parseProcedureConfig({
      review_request: { enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT, review_url: "http://shop.example/reviews" },
    }),
    AgentBehaviorError,
  );
  assertThrows(
    () => parseProcedureConfig({
      review_request: { enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT, review_url: "https://shop.example/reviews", delay_days: 15 },
    }),
    AgentBehaviorError,
  );
  assertThrows(
    () => parseProcedureConfig({ back_in_stock: { enabled: true, prompts: {}, closing: "", qr_risk_acknowledged_at: "yesterday" } }),
    AgentBehaviorError,
  );
});

Deno.test("readProcedureConfig drops only the invalid flow and never throws", () => {
  const read = readProcedureConfig({
    ...valid,
    product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] },
  });
  assertEquals(enabledProcedures(read), ["order_status"]);
  assertEquals(readProcedureConfig("garbage"), {});
  assertEquals(readProcedureConfig({ ...valid, review_request: { enabled: true, prompts: {}, closing: "" } }).review_request, undefined);
  const kept = readProcedureConfig({
    cod_confirm: { enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT },
    review_request: {
      enabled: true, prompts: {}, closing: "", consent_attested_at: CONSENT,
      delay_days: 7, review_url: "https://shop.example/reviews",
    },
    back_in_stock: { enabled: false, prompts: {}, closing: "" },
  });
  assertEquals(kept.cod_confirm?.enabled, true);
  assertEquals(kept.review_request?.delay_days, 7);
  assertEquals(kept.back_in_stock?.enabled, false);
  assertEquals(reviewDelayDays(kept), 7);
  assertEquals(reviewDelayDays({ review_request: { enabled: true, prompts: {}, closing: "" } }), 3);
  assertEquals(readProcedureConfig(undefined), {});
});

Deno.test("a switched-off product finder with unfinished questions saves without them", () => {
  const parsed = parseProcedureConfig({
    product_finder: { enabled: false, prompts: {}, closing: "", questions: ["", ""] },
  });
  assertEquals(parsed.product_finder, { enabled: false, prompts: {}, closing: "" });
});
