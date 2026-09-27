import { assertEquals } from "jsr:@std/assert@1";
import { TEMPLATES } from "./templates.ts";

const validator = (key: "cod_confirm" | "review_request" | "back_in_stock", name: string) =>
  TEMPLATES[key].fields.find((field) => field.name === name)!.validate;

for (const [key, name, raw, expected] of [
  ["cod_confirm", "decision", " Confirm ", "confirm"],
  ["cod_confirm", "decision", "نعم", "confirm"],
  ["cod_confirm", "decision", "تأكيد", "confirm"],
  ["cod_confirm", "decision", "CANCEL", "cancel"],
  ["cod_confirm", "decision", "إلغاء", "cancel"],
  ["cod_confirm", "decision", "لا", "cancel"],
  ["cod_confirm", "decision", "maybe", null],
  ["review_request", "rating", "5", "5"],
  ["review_request", "rating", "٣", "3"],
  ["review_request", "rating", "۲", "2"],
  ["review_request", "rating", "0", null],
  ["review_request", "rating", "6", null],
  ["review_request", "rating", "4.5", null],
  ["back_in_stock", "interest", "Yes", "yes"],
  ["back_in_stock", "interest", "نعم", "yes"],
  ["back_in_stock", "interest", "لا", "no"],
  ["back_in_stock", "interest", "later", null],
] as const) {
  Deno.test(`${key}.${name} validates ${JSON.stringify(raw)} → ${expected}`, () => {
    assertEquals(validator(key, name)(raw), expected);
  });
}

Deno.test("review_request.problem is asked only for a rating of 3 or less", () => {
  const problem = TEMPLATES.review_request.fields.find((field) => field.name === "problem")!;
  assertEquals(problem.when?.({ rating: "3" }), true);
  assertEquals(problem.when?.({ rating: "4" }), false);
});
