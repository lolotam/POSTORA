import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ALLOWED_SYSTEM_LOG_CATEGORIES,
  buildRefusalLogRow,
} from "./refusalLog.ts";

const ACTIONS = ["callback", "disconnect", "authorize", "request"];
const REASONS = [
  "invalid_request",
  "Unauthorized",
  "google_oauth_failed",
  "account_save_failed",
  "profile_not_owned",
  "google_revoke_failed",
];

Deno.test("buildRefusalLogRow uses a category from the allowed system_logs list", () => {
  const row = buildRefusalLogRow({ action: "callback", reason: "google_oauth_failed", userId: null });
  assert(ALLOWED_SYSTEM_LOG_CATEGORIES.includes(row.category));
});

Deno.test("buildRefusalLogRow never carries a category outside the allowed list", () => {
  for (const action of ACTIONS) {
    for (const reason of REASONS) {
      const row = buildRefusalLogRow({ action, reason, userId: null });
      assert(
        ALLOWED_SYSTEM_LOG_CATEGORIES.includes(row.category),
        `category "${row.category}" for action=${action} reason=${reason} is not allowed`,
      );
    }
  }
});

Deno.test("buildRefusalLogRow shapes the system_logs row correctly", () => {
  const userId = "0ee00001-0000-4000-8000-000000000001";
  const row = buildRefusalLogRow({ action: "disconnect", reason: "account_changed", userId });

  assertEquals(row.level, "warn");
  assertEquals(row.category, "auth");
  assertEquals(row.source, "youtube-oauth");
  assertEquals(row.message, "YouTube OAuth request refused");
  assertEquals(row.user_id, userId);
  assertEquals(row.metadata, { action: "disconnect", reason: "account_changed" });
});

Deno.test("buildRefusalLogRow supports anonymous refusals (null user)", () => {
  const row = buildRefusalLogRow({ action: "request", reason: "invalid_json", userId: null });
  assertEquals(row.user_id, null);
});

Deno.test("buildRefusalLogRow never carries token-like fields", () => {
  const row = buildRefusalLogRow({ action: "callback", reason: "google_oauth_failed", userId: null });
  const forbidden = [
    "access_token",
    "refresh_token",
    "token",
    "authorization",
    "apikey",
    "api_key",
    "password",
    "secret",
  ];
  for (const key of Object.keys(row)) {
    assert(
      !forbidden.includes(key),
      `row carries forbidden token-like field: ${key}`,
    );
  }
});
