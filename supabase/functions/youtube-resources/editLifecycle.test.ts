import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createEditSnapshot,
  EditFailure,
  planEditUpdate,
  verifyEditResult,
  type ProviderVideo,
} from "./editLifecycle.ts";

const CHANNEL = "UCfixturechannel000000001";
const OWNER = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT = "0ee20001-0000-4000-8000-000000000021";
const VIDEO_ID = "AbcD1234eFg";
const FETCHED = "2026-11-22T10:00:00.000Z";

function video(overrides: Partial<ProviderVideo> = {}): ProviderVideo {
  return {
    id: VIDEO_ID,
    etag: '"etag-1"',
    snippet: {
      channelId: CHANNEL,
      title: "Original",
      description: "Body",
      tags: ["one"],
      categoryId: "22",
      defaultLanguage: "ar",
    },
    status: {
      privacyStatus: "private",
      embeddable: false,
      license: "youtube",
      publicStatsViewable: false,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    },
    ...overrides,
  };
}

async function snapshotOf(input: ProviderVideo = video()) {
  return await createEditSnapshot({
    video: input,
    ownerId: OWNER,
    accountId: ACCOUNT,
    expectedChannelId: CHANNEL,
    fetchedAt: FETCHED,
  });
}

Deno.test("a snapshot is owner-bound and keeps explicit false and absence apart", async () => {
  const snapshot = await snapshotOf();
  assertEquals(snapshot.videoId, VIDEO_ID);
  assertEquals(snapshot.restrictions.scheduleProtected, false);
  assertEquals(snapshot.values.embeddable, false);
  assertEquals(snapshot.values.selfDeclaredMadeForKids, false);
  await assertRejects(
    () => createEditSnapshot({
      video: video({ snippet: { ...video().snippet, channelId: "UCsomeone-else" } }),
      ownerId: OWNER,
      accountId: ACCOUNT,
      expectedChannelId: CHANNEL,
      fetchedAt: FETCHED,
    }),
    EditFailure,
    "does not belong",
  );
});

Deno.test("an absent boolean is not invented as false", async () => {
  const withoutDeclaration = video();
  delete withoutDeclaration.status.selfDeclaredMadeForKids;
  const snapshot = await snapshotOf(withoutDeclaration);
  assertEquals(snapshot.values.selfDeclaredMadeForKids, null);
});

Deno.test("a title-only edit never writes the status part", async () => {
  const snapshot = await snapshotOf();
  const plan = await planEditUpdate({
    snapshot,
    changes: { title: "Renamed" },
    freshVideo: video(),
    ownerId: OWNER,
    accountId: ACCOUNT,
    privacyConfirmation: null,
  });
  assertEquals(plan.parts, ["snippet"]);
  assertEquals(plan.body.status, undefined);
  assertEquals(plan.ifMatch, '"etag-1"');
  assertEquals((plan.body.snippet as Record<string, unknown>).title, "Renamed");
  assertEquals((plan.body.snippet as Record<string, unknown>).defaultLanguage, "ar");
});

Deno.test("a status edit carries every writable sibling including explicit false", async () => {
  const snapshot = await snapshotOf();
  const plan = await planEditUpdate({
    snapshot,
    changes: { privacyStatus: "unlisted" },
    freshVideo: video(),
    ownerId: OWNER,
    accountId: ACCOUNT,
    privacyConfirmation: { to: "unlisted" },
  });
  assertEquals(plan.parts, ["status"]);
  const status = plan.body.status as Record<string, unknown>;
  assertEquals(status.privacyStatus, "unlisted");
  assertEquals(status.embeddable, false);
  assertEquals(status.publicStatsViewable, false);
  assertEquals(status.selfDeclaredMadeForKids, false);
  assertEquals(status.containsSyntheticMedia, false);
});

Deno.test("a stale base, an unconfirmed privacy change and an unknown field are refused", async () => {
  const snapshot = await snapshotOf();
  const stale = video({ snippet: { ...video().snippet, title: "Changed elsewhere" } });
  await assertRejects(
    () => planEditUpdate({
      snapshot,
      changes: { title: "New" },
      freshVideo: stale,
      ownerId: OWNER,
      accountId: ACCOUNT,
      privacyConfirmation: null,
    }),
    EditFailure,
    "changed since it was opened",
  );
  await assertRejects(
    () => planEditUpdate({
      snapshot,
      changes: { privacyStatus: "public" },
      freshVideo: video(),
      ownerId: OWNER,
      accountId: ACCOUNT,
      privacyConfirmation: null,
    }),
    EditFailure,
    "not confirmed",
  );
  await assertRejects(
    () => planEditUpdate({
      snapshot,
      changes: { madeForKids: true } as never,
      freshVideo: video(),
      ownerId: OWNER,
      accountId: ACCOUNT,
      privacyConfirmation: null,
    }),
    EditFailure,
    "Unknown field",
  );
});

Deno.test("a category change is refused unless the provider lists it as assignable", async () => {
  const snapshot = await snapshotOf();
  await assertRejects(
    () => planEditUpdate({
      snapshot,
      changes: { categoryId: "30" },
      freshVideo: video(),
      ownerId: OWNER,
      accountId: ACCOUNT,
      privacyConfirmation: null,
      assignableCategoryIds: new Set(["1", "22"]),
    }),
    EditFailure,
    "not assignable",
  );
});

Deno.test("a scheduled video cannot change privacy", async () => {
  const scheduled = video();
  scheduled.status.publishAt = "2026-12-01T10:00:00Z";
  const snapshot = await snapshotOf(scheduled);
  assertEquals(snapshot.restrictions.scheduleProtected, true);
  await assertRejects(
    () => planEditUpdate({
      snapshot,
      changes: { privacyStatus: "public" },
      freshVideo: scheduled,
      ownerId: OWNER,
      accountId: ACCOUNT,
      privacyConfirmation: { to: "public" },
    }),
    EditFailure,
    "protected",
  );
});

Deno.test("verification demands the same video id and the intended field values", async () => {
  const snapshot = await snapshotOf();
  const plan = await planEditUpdate({
    snapshot,
    changes: { title: "Renamed" },
    freshVideo: video(),
    ownerId: OWNER,
    accountId: ACCOUNT,
    privacyConfirmation: null,
  });
  verifyEditResult({
    responseId: VIDEO_ID,
    reread: video({ snippet: { ...video().snippet, title: "Renamed" } }),
    expectedVideoId: VIDEO_ID,
    plan,
  });
  assertThrows(
    () => verifyEditResult({
      responseId: "DifferentId12",
      reread: video(),
      expectedVideoId: VIDEO_ID,
      plan,
    }),
    EditFailure,
    "same video",
  );
  assertThrows(
    () => verifyEditResult({
      responseId: VIDEO_ID,
      reread: video(),
      expectedVideoId: VIDEO_ID,
      plan,
    }),
    EditFailure,
    "title",
  );
});

Deno.test("tags validation accepts valid tags and refuses empty, angle-bracket, or >500 total char tags", async () => {
  const snapshot = await snapshotOf();
  const validPlan = await planEditUpdate({
    snapshot,
    changes: { tags: ["postora", "youtube"] },
    freshVideo: video(),
    ownerId: OWNER,
    accountId: ACCOUNT,
    privacyConfirmation: null,
  });
  assertEquals((validPlan.body.snippet as Record<string, unknown>).tags, ["postora", "youtube"]);

  for (const badTags of [[""], ["   "], ["bad<tag>"], ["a".repeat(250), "b".repeat(251)]]) {
    await assertRejects(
      () => planEditUpdate({
        snapshot,
        changes: { tags: badTags },
        freshVideo: video(),
        ownerId: OWNER,
        accountId: ACCOUNT,
        privacyConfirmation: null,
      }),
      EditFailure,
      "Invalid tags",
    );
  }
});
