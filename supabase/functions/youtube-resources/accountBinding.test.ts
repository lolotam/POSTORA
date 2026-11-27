import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifyAccountStillBound } from "./accountBinding.ts";
import type { YouTubeResourceAccount } from "./handler.ts";

const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const OWNER_ID = "0ee00001-0000-4000-8000-000000000001";
const CHANNEL_ID = "UCfixturechannel000000001";
const BOUND_BEARER = "bound-fixture-123";

function baseAccount(overrides: Partial<YouTubeResourceAccount> = {}): YouTubeResourceAccount {
  return {
    id: ACCOUNT_ID,
    userId: OWNER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken: BOUND_BEARER,
    refreshToken: "refresh-fixture-123",
    tokenExpiresAt: "2026-12-01T00:00:00Z",
    accountMetadata: {},
    ...overrides,
  };
}

Deno.test("verifyAccountStillBound returns true when every binding invariant matches", async () => {
  const seen: Array<{ accountId: string; userId: string }> = [];
  const ok = await verifyAccountStillBound({
    loadAccount: (args) => {
      seen.push(args);
      return Promise.resolve(baseAccount());
    },
    accountId: ACCOUNT_ID,
    ownerId: OWNER_ID,
    channelId: CHANNEL_ID,
    accessToken: BOUND_BEARER,
  });

  assertEquals(ok, true);
  assertEquals(seen, [{ accountId: ACCOUNT_ID, userId: OWNER_ID }]);
});

Deno.test("verifyAccountStillBound returns false on null, throw, or any differing field", async () => {
  const cases: Array<() => Promise<YouTubeResourceAccount | null>> = [
    () => Promise.resolve(null),
    () => Promise.reject(new Error("db outage")),
    () => Promise.resolve(baseAccount({ id: "0ee20001-0000-4000-8000-000000000099" })),
    () => Promise.resolve(baseAccount({ userId: "0ee00001-0000-4000-8000-000000000099" })),
    () => Promise.resolve(baseAccount({ authProvider: "composio" })),
    () => Promise.resolve(baseAccount({ needsReauth: true })),
    () => Promise.resolve(baseAccount({ channelId: "UCotherchannel00000000002" })),
    () => Promise.resolve(baseAccount({ accessToken: "rotated-token" })),
  ];

  for (const loadAccount of cases) {
    const ok = await verifyAccountStillBound({
      loadAccount,
      accountId: ACCOUNT_ID,
      ownerId: OWNER_ID,
      channelId: CHANNEL_ID,
      accessToken: BOUND_BEARER,
    });
    assertEquals(ok, false);
  }
});
