import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isOwnComment } from "./commentAuthor.ts";

const fb = { platform: "facebook", platform_user_id: "page-1", platform_username: "My Page", account_metadata: {} };
const ig = {
  platform: "instagram",
  platform_user_id: "app-scoped-1",
  platform_username: "mybrand",
  account_metadata: { ig_igid: "igid-1", ig_user_id: "ig-user-1" },
};
const th = { platform: "threads", platform_user_id: "th-1", platform_username: "mybrand", account_metadata: null };

Deno.test("facebook: only the page id counts as own", () => {
  assertEquals(isOwnComment(fb, { id: "page-1", username: null }), true);
  assertEquals(isOwnComment(fb, { id: "someone", username: null }), false);
});

Deno.test("instagram: any of the three stored ids counts as own", () => {
  for (const id of ["app-scoped-1", "igid-1", "ig-user-1"]) {
    assertEquals(isOwnComment(ig, { id, username: null }), true);
  }
  assertEquals(isOwnComment(ig, { id: "fan-1", username: "fan" }), false);
});

Deno.test("threads: matches by user id or username, case-insensitively", () => {
  assertEquals(isOwnComment(th, { id: "th-1", username: null }), true);
  assertEquals(isOwnComment(th, { id: null, username: "MyBrand" }), true);
  assertEquals(isOwnComment(th, { id: "x", username: "other" }), false);
});

Deno.test("missing author never counts as own", () => {
  assertEquals(isOwnComment(fb, { id: null, username: null }), false);
});
