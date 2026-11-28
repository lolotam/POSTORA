import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createConnectedEditPort, type EditWriteAuthorizationResult } from "./editComposition.ts";
import { EditFailure, type ProviderVideo } from "./editLifecycle.ts";
import type { EditWriteResult } from "./editProvider.ts";

const ACCOUNT = "13a7bda5-e24f-4caa-8917-aa17f57e1671";
const OWNER = "owner-1";
const CHANNEL = "UCfixturechannel000000001";
const VIDEO = "AbcD1234eFg";

const baseVideo = (
  title = "Original",
  statusOverrides: Partial<ProviderVideo["status"]> = {},
): ProviderVideo => ({
  id: VIDEO,
  etag: "etag-1",
  snippet: { channelId: CHANNEL, title, description: "Description", tags: [], categoryId: "22" },
  status: {
    privacyStatus: "private",
    embeddable: false,
    license: "youtube",
    publicStatsViewable: false,
    ...statusOverrides,
  },
});

function composition(
  writeGuard: {
    authorizeWrite(): Promise<EditWriteAuthorizationResult>;
    stillBound(): Promise<boolean>;
  },
  counts: { reads: number; catalog: number; writes: number },
  options?: {
    updateResult?: EditWriteResult;
    initialStatus?: Partial<ProviderVideo["status"]>;
    ignoreStatusWriteOnReread?: boolean;
  },
) {
  let currentTitle = "Original";
  let currentPrivacy: ProviderVideo["status"]["privacyStatus"] =
    options?.initialStatus?.privacyStatus ?? "private";
  return createConnectedEditPort({
    enabled: true,
    provider: {
      getVideo: () => {
        counts.reads += 1;
        return Promise.resolve({
          ok: true as const,
          value: baseVideo(currentTitle, {
            ...options?.initialStatus,
            privacyStatus: currentPrivacy,
          }),
        });
      },
      updateVideo: (_token, input) => {
        counts.writes += 1;
        if (options?.updateResult && !options.updateResult.ok) {
          return Promise.resolve(options.updateResult);
        }
        const snippet = input.plan.body.snippet as { title?: string } | undefined;
        if (snippet?.title) currentTitle = snippet.title;
        const status = input.plan.body.status as { privacyStatus?: ProviderVideo["status"]["privacyStatus"] } | undefined;
        if (status?.privacyStatus && !options?.ignoreStatusWriteOnReread) {
          currentPrivacy = status.privacyStatus;
        }
        return Promise.resolve(options?.updateResult ?? { ok: true as const, id: VIDEO });
      },
    },
    categories: {
      list: () => {
        counts.catalog += 1;
        return Promise.resolve({
          ok: true as const,
          region: "US",
          locale: "en" as const,
          value: [{ id: "22", name: "People & Blogs", label: "22 (People & Blogs)", assignable: true }],
        });
      },
    },
    tokens: { get: () => Promise.resolve({ ok: true as const, accessToken: "yt-access", minted: false }) },
    accounts: {
      load: ({ accountId, userId }) => Promise.resolve({
        id: accountId, userId, channelId: CHANNEL, authProvider: null, needsReauth: false,
        accessToken: "yt-access", refreshToken: null, tokenExpiresAt: null, accountMetadata: { country: "DE" },
      }),
    },
    clock: { now: () => new Date("2026-11-22T10:00:00.000Z") },
    writeGuard,
  });
}

Deno.test("burst, daily, unreadable counter, and budget refusals stop before any catalog read or provider write", async () => {
  const cases: Array<{
    name: string;
    authResult: EditWriteAuthorizationResult;
    expectedCode: string;
    expectedRetryAfter?: number;
  }> = [
    { name: "burst refusal", authResult: { ok: false, code: "rate_limited", retryAfterSeconds: 42 }, expectedCode: "rate_limited", expectedRetryAfter: 42 },
    { name: "daily refusal", authResult: { ok: false, code: "rate_limited", retryAfterSeconds: 3600 }, expectedCode: "rate_limited", expectedRetryAfter: 3600 },
    { name: "unreadable counter", authResult: { ok: false, code: "upstream_unavailable" }, expectedCode: "upstream_unavailable" },
    { name: "budget refusal", authResult: { ok: false, code: "quota_exceeded", retryAfterSeconds: 7200 }, expectedCode: "quota_exceeded", expectedRetryAfter: 7200 },
  ];

  for (const testCase of cases) {
    const counts = { reads: 0, catalog: 0, writes: 0 };
    const port = composition({
      authorizeWrite: () => Promise.resolve(testCase.authResult),
      stillBound: () => Promise.resolve(true),
    }, counts);
    const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });
    let caught: unknown;
    try {
      await port!.update({
        accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
        baseRevision: snapshot.revision, changes: { title: "Renamed" }, privacyConfirmation: null,
      });
    } catch (error) {
      caught = error;
    }
    assertEquals(caught instanceof EditFailure, true, testCase.name);
    assertEquals((caught as EditFailure).code, testCase.expectedCode, testCase.name);
    assertEquals((caught as EditFailure).retryAfterSeconds, testCase.expectedRetryAfter, testCase.name);
    assertEquals(counts.catalog, 0, `${testCase.name}: zero catalog calls`);
    assertEquals(counts.writes, 0, `${testCase.name}: zero provider writes`);
  }
});

Deno.test("a lost channel rebinding refuses before any provider write", async () => {
  const counts = { reads: 0, catalog: 0, writes: 0 };
  const port = composition({
    authorizeWrite: () => Promise.resolve({ ok: true }),
    stillBound: () => Promise.resolve(false),
  }, counts);
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
  assertEquals(counts.writes, 0);
});

Deno.test("provider outcome_unknown surfaces as EditFailure('outcome_unknown') with no verification re-read", async () => {
  const counts = { reads: 0, catalog: 0, writes: 0 };
  const port = composition(
    {
      authorizeWrite: () => Promise.resolve({ ok: true }),
      stillBound: () => Promise.resolve(true),
    },
    counts,
    { updateResult: { ok: false, code: "outcome_unknown" } },
  );
  const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });
  counts.reads = 0;

  let caught: unknown;
  try {
    await port!.update({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
      baseRevision: snapshot.revision, changes: { title: "Renamed" }, privacyConfirmation: null,
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof EditFailure, true);
  assertEquals((caught as EditFailure).code, "outcome_unknown");
  assertEquals(counts.writes, 1);
  assertEquals(counts.reads, 1, "only pre-write getVideo should run; no verification re-read after outcome_unknown");
});

Deno.test("invalid draft changes and unconfirmed privacy changes refuse before authorizeWrite spends any quota", async () => {
  let authorizeCalls = 0;
  const counts = { reads: 0, catalog: 0, writes: 0 };
  const port = composition({
    authorizeWrite: () => {
      authorizeCalls += 1;
      return Promise.resolve({ ok: true });
    },
    stillBound: () => Promise.resolve(true),
  }, counts);
  const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });

  for (const invalidChanges of [
    { title: "   " },
    { title: "bad <title>" },
    { tags: [" untrimmed "] },
  ]) {
    let caught: unknown;
    try {
      await port!.update({
        accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
        baseRevision: snapshot.revision, changes: invalidChanges, privacyConfirmation: null,
      });
    } catch (error) {
      caught = error;
    }
    assertEquals(caught instanceof EditFailure, true);
    assertEquals((caught as EditFailure).code, "invalid_request");
  }
  assertEquals(authorizeCalls, 0);
  assertEquals(counts.catalog, 0);
  assertEquals(counts.writes, 0);
});

Deno.test("successful update returns the post-write snapshot revision built from the verified re-read", async () => {
  const counts = { reads: 0, catalog: 0, writes: 0 };
  const port = composition(
    {
      authorizeWrite: () => Promise.resolve({ ok: true }),
      stillBound: () => Promise.resolve(true),
    },
    counts,
  );
  const snapshot = await port!.snapshot({ accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL });
  const result = await port!.update({
    accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
    baseRevision: snapshot.revision, changes: { title: "Renamed" }, privacyConfirmation: null,
  });
  assertEquals(result.verified, true);
  assertEquals(result.snapshot.values.title, "Renamed");
  assertEquals(result.snapshot.revision !== snapshot.revision, true);
});

Deno.test("privacy edit order-pinning: schedule-protected, missing, and mismatched confirmation fail before authorizeWrite; confirmed writes once; differing re-read fails with outcome_unknown", async () => {
  // 1. Schedule-protected video (`status.publishAt` set): refused with zero authorizeWrite, catalog, or provider writes
  {
    let authorizeCalls = 0;
    const counts = { reads: 0, catalog: 0, writes: 0 };
    const scheduledPort = composition(
      {
        authorizeWrite: () => {
          authorizeCalls += 1;
          return Promise.resolve({ ok: true });
        },
        stillBound: () => Promise.resolve(true),
      },
      counts,
      { initialStatus: { publishAt: "2026-12-01T10:00:00Z" } },
    );
    const scheduledSnap = await scheduledPort!.snapshot({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
    });
    assertEquals(scheduledSnap.restrictions.scheduleProtected, true);
    let caught: unknown;
    try {
      await scheduledPort!.update({
        accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
        baseRevision: scheduledSnap.revision,
        changes: { privacyStatus: "public" },
        privacyConfirmation: { to: "public" },
      });
    } catch (error) {
      caught = error;
    }
    assertEquals(caught instanceof EditFailure, true);
    assertEquals((caught as EditFailure).code, "invalid_request");
    assertEquals(authorizeCalls, 0);
    assertEquals(counts.catalog, 0);
    assertEquals(counts.writes, 0);
  }

  // 2. Missing confirmation and mismatched confirmation: refused with zero authorizeWrite, catalog, or provider writes
  {
    let authorizeCalls = 0;
    const counts = { reads: 0, catalog: 0, writes: 0 };
    const port = composition(
      {
        authorizeWrite: () => {
          authorizeCalls += 1;
          return Promise.resolve({ ok: true });
        },
        stillBound: () => Promise.resolve(true),
      },
      counts,
    );
    const snapshot = await port!.snapshot({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
    });

    for (const badConfirmation of [null, { to: "unlisted" as const }]) {
      let caught: unknown;
      try {
        await port!.update({
          accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
          baseRevision: snapshot.revision,
          changes: { privacyStatus: "public" },
          privacyConfirmation: badConfirmation,
        });
      } catch (error) {
        caught = error;
      }
      assertEquals(caught instanceof EditFailure, true);
      assertEquals((caught as EditFailure).code, "invalid_request");
    }
    assertEquals(authorizeCalls, 0);
    assertEquals(counts.catalog, 0);
    assertEquals(counts.writes, 0);
  }

  // 3. Confirmed privacy change: calls authorizeWrite once, writes once, returns verified re-read with privacyStatus === "unlisted"
  {
    let authorizeCalls = 0;
    const counts = { reads: 0, catalog: 0, writes: 0 };
    const port = composition(
      {
        authorizeWrite: () => {
          authorizeCalls += 1;
          return Promise.resolve({ ok: true });
        },
        stillBound: () => Promise.resolve(true),
      },
      counts,
    );
    const snapshot = await port!.snapshot({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
    });
    const result = await port!.update({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
      baseRevision: snapshot.revision,
      changes: { privacyStatus: "unlisted" },
      privacyConfirmation: { to: "unlisted" },
    });
    assertEquals(authorizeCalls, 1);
    assertEquals(counts.writes, 1);
    assertEquals(result.verified, true);
    assertEquals(result.snapshot.values.privacyStatus, "unlisted");
  }

  // 4. Differing provider re-read after a confirmed privacy change: rejects with EditFailure("outcome_unknown")
  {
    let authorizeCalls = 0;
    const counts = { reads: 0, catalog: 0, writes: 0 };
    const port = composition(
      {
        authorizeWrite: () => {
          authorizeCalls += 1;
          return Promise.resolve({ ok: true });
        },
        stillBound: () => Promise.resolve(true),
      },
      counts,
      { ignoreStatusWriteOnReread: true },
    );
    const snapshot = await port!.snapshot({
      accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
    });
    let caught: unknown;
    try {
      await port!.update({
        accountId: ACCOUNT, videoId: VIDEO, ownerId: OWNER, channelId: CHANNEL,
        baseRevision: snapshot.revision,
        changes: { privacyStatus: "unlisted" },
        privacyConfirmation: { to: "unlisted" },
      });
    } catch (error) {
      caught = error;
    }
    assertEquals(authorizeCalls, 1);
    assertEquals(counts.writes, 1);
    assertEquals(caught instanceof EditFailure, true);
    assertEquals((caught as EditFailure).code, "outcome_unknown");
  }
});
