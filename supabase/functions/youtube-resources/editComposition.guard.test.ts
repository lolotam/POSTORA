import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createConnectedEditPort } from "./editComposition.ts";

const ACCOUNT = "13a7bda5-e24f-4caa-8917-aa17f57e1671";
const OWNER = "owner-1";
const CHANNEL = "UCfixturechannel000000001";
const VIDEO = "AbcD1234eFg";

const video = () => ({
  id: VIDEO,
  etag: "etag-1",
  snippet: { channelId: CHANNEL, title: "Original", description: "Description", categoryId: "22" },
  status: { privacyStatus: "private", embeddable: false, license: "youtube", publicStatsViewable: false },
});

function composition(writeGuard: {
  authorizeWrite(): Promise<boolean>;
  stillBound(): Promise<boolean>;
}, writes: { count: number }) {
  return createConnectedEditPort({
    enabled: true,
    provider: {
      getVideo: () => Promise.resolve({ ok: true as const, value: video() }),
      updateVideo: () => {
        writes.count += 1;
        return Promise.resolve({ ok: true as const, id: VIDEO });
      },
    },
    categories: {
      list: () => Promise.resolve({
        ok: true as const,
        region: "US",
        locale: "en" as const,
        value: [{ id: "22", name: "People & Blogs", label: "22 (People & Blogs)", assignable: true }],
      }),
    },
    tokens: { get: () => Promise.resolve({ ok: true as const, accessToken: "token", minted: false }) },
    accounts: {
      load: ({ accountId, userId }) => Promise.resolve({
        id: accountId, userId, channelId: CHANNEL, authProvider: null, needsReauth: false,
        accessToken: "token", refreshToken: null, tokenExpiresAt: null, accountMetadata: { country: "DE" },
      }),
    },
    clock: { now: () => new Date("2026-11-22T10:00:00.000Z") },
    writeGuard,
  });
}

Deno.test("a failed write rate/quota gate refuses before any provider write", async () => {
  const writes = { count: 0 };
  const port = composition({
    authorizeWrite: () => Promise.resolve(false),
    stillBound: () => Promise.resolve(true),
  }, writes);
  const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });
  try {
    await port!.update({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
      baseRevision: snapshot.revision, changes: { title: "Renamed" }, privacyConfirmation: null,
    });
    throw new Error("the write should have been refused");
  } catch (error) {
    assertEquals((error as { code?: string }).code, "upstream_unavailable");
  }
  assertEquals(writes.count, 0);
});

Deno.test("a lost channel rebinding refuses before any provider write", async () => {
  const writes = { count: 0 };
  const port = composition({
    authorizeWrite: () => Promise.resolve(true),
    stillBound: () => Promise.resolve(false),
  }, writes);
  const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });
  try {
    await port!.update({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
      baseRevision: snapshot.revision, changes: { title: "Renamed" }, privacyConfirmation: null,
    });
    throw new Error("the write should have been refused");
  } catch (error) {
    assertEquals((error as { code?: string }).code, "reconnect_required");
  }
  assertEquals(writes.count, 0);
});
