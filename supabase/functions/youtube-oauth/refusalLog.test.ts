import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ALLOWED_SYSTEM_LOG_CATEGORIES,
  buildDisconnectOutcomeLogRow,
  buildRefusalLogRow,
} from "./refusalLog.ts";

Deno.test("buildRefusalLogRow uses a category from the allowed system_logs list", () => {
  const row = buildRefusalLogRow({ action: "callback", reason: "google_oauth_failed", userId: null });
  assert(ALLOWED_SYSTEM_LOG_CATEGORIES.includes(row.category));
});

Deno.test("buildRefusalLogRow always uses the auth category, which is on the allowed list", () => {
  const row = buildRefusalLogRow({ action: "callback", reason: "google_oauth_failed", userId: null });
  assertEquals(row.category, "auth");
  assert(
    ALLOWED_SYSTEM_LOG_CATEGORIES.includes(row.category),
    `"auth" must be an allowed system_logs category`,
  );
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
  assertEquals(Object.keys(row.metadata), ["action", "reason"]);
});

Deno.test("buildDisconnectOutcomeLogRow records a non-revoking outcome without token material", () => {
  const userId = "0ee00001-0000-4000-8000-000000000001";
  const accountId = "0ee20001-0000-4000-8000-000000000021";
  const row = buildDisconnectOutcomeLogRow({
    userId,
    accountId,
    revoked: false,
    reason: "grant_shared",
  });

  assertEquals(row, {
    level: "info",
    category: "auth",
    source: "youtube-oauth",
    message: "YouTube disconnect completed without provider revoke: grant_shared",
    user_id: userId,
    metadata: { action: "disconnect", account_id: accountId, revoked: false, reason: "grant_shared" },
  });
  assert(ALLOWED_SYSTEM_LOG_CATEGORIES.includes(row.category));
  assertEquals(Object.keys(row.metadata), ["action", "account_id", "revoked", "reason"]);
});
