import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AVATAR_NEGATIVE_CACHE_MS,
  BACKFILL_MAX,
  backfillWhatsAppParticipantAvatars,
  contactNumberFromConversationId,
  enrichWhatsAppParticipantAvatar,
  isDurableCloudinaryUrl,
} from "./whatsappAvatarEnrichment.ts";

const USER = "user-1";
const WORKSPACE = "ws-1";
const ACCOUNT = "acc-1";
const INSTANCE = "postora-acc-1";
const CONVERSATION = "wa_96597950350_96550000000";
const NUMBER = "96550000000";
const SOURCE = "https://pps.whatsapp.net/v/pic.jpg";
const CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/avatars/user-1/whatsapp_abc.jpg";

interface CacheRow {
  user_id: string;
  workspace_id: string;
  social_account_id: string;
  platform: string;
  conversation_id: string;
  participant_avatar: string | null;
  participant_avatar_checked_at: string | null;
}

function row(overrides: Partial<CacheRow> = {}): CacheRow {
  return {
    user_id: USER,
    workspace_id: WORKSPACE,
    social_account_id: ACCOUNT,
    platform: "whatsapp",
    conversation_id: CONVERSATION,
    participant_avatar: null,
    participant_avatar_checked_at: null,
    ...overrides,
  };
}

function fakeCache(initial: CacheRow[], options: { readError?: string } = {}) {
  const rows = initial.map((entry) => ({ ...entry }));
  const updates: Array<{ conversationId: string; patch: Record<string, unknown> }> = [];

  function matching(filters: Record<string, unknown>, nullColumns: string[]) {
    return rows.filter((entry) => {
      for (const [column, value] of Object.entries(filters)) {
        if ((entry as Record<string, unknown>)[column] !== value) return false;
      }
      for (const column of nullColumns) {
        if ((entry as Record<string, unknown>)[column] != null) return false;
      }
      return true;
    });
  }

  return {
    rows,
    updates,
    from(_table: string) {
      const state = {
        filters: {} as Record<string, unknown>,
        nullColumns: [] as string[],
        patch: null as Record<string, unknown> | null,
        limitTo: Infinity,
      };
      const execute = () => {
        if (options.readError && !state.patch) {
          return Promise.resolve({ data: null, error: { message: options.readError } });
        }
        const matched = matching(state.filters, state.nullColumns);
        if (state.patch) {
          for (const entry of matched) {
            Object.assign(entry, state.patch);
            updates.push({ conversationId: entry.conversation_id, patch: { ...state.patch } });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({
          data: matched.slice(0, state.limitTo),
          error: null,
        });
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          state.filters[column] = value;
          return chain;
        },
        is: (column: string) => {
          state.nullColumns.push(column);
          return chain;
        },
        limit: (count: number) => {
          state.limitTo = count;
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          state.patch = patch;
          return chain;
        },
        maybeSingle: () =>
          execute().then(({ data, error }) => ({
            data: Array.isArray(data) ? data[0] ?? null : data,
            error,
          })),
        then: (
          resolve: (value: { data: unknown; error: unknown }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => execute().then(resolve, reject),
      };
      return chain;
    },
  };
}

function target(overrides: Partial<Parameters<typeof enrichWhatsAppParticipantAvatar>[1]> = {}) {
  return {
    userId: USER,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    instanceName: INSTANCE,
    contactNumber: NUMBER,
    ...overrides,
  };
}

function scope() {
  return {
    userId: USER,
    workspaceId: WORKSPACE,
    accountId: ACCOUNT,
    instanceName: INSTANCE,
  };
}

Deno.test("a durable Cloudinary URL is persisted and checked_at is not stamped", async () => {
  const admin = fakeCache([row()]);
  let cachedId = "";
  await enrichWhatsAppParticipantAvatar({
    admin,
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: (_url, _user, _platform, platformUserId) => {
      cachedId = platformUserId;
      return Promise.resolve(CLOUDINARY);
    },
  }, target());

  assertEquals(admin.rows[0].participant_avatar, CLOUDINARY);
  assertEquals(admin.rows[0].participant_avatar_checked_at, null);
  assertEquals(/^[0-9a-f]{64}$/.test(cachedId), true);
  assertEquals(cachedId.includes(NUMBER), false);
});

Deno.test("opaque Cloudinary ids differ across accounts of the same user", async () => {
  const ids: string[] = [];
  for (const accountId of ["acc-1", "acc-2"]) {
    const admin = fakeCache([row({ social_account_id: accountId })]);
    await enrichWhatsAppParticipantAvatar({
      admin,
      fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
      cacheAvatar: (_url, _user, _platform, platformUserId) => {
        ids.push(platformUserId);
        return Promise.resolve(CLOUDINARY);
      },
    }, target({ accountId }));
  }
  assertEquals(ids.length, 2);
  assert(ids[0] !== ids[1]);
});

Deno.test("returning the Evolution source URL is treated as upload failure", async () => {
  const admin = fakeCache([row()]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.resolve(SOURCE),
  }, target());
  assertEquals(admin.rows[0].participant_avatar, null);
  assertEquals(admin.rows[0].participant_avatar_checked_at, null);
  assertEquals(admin.updates.length, 0);
});

Deno.test("a confirmed miss stamps checked_at and leaves the avatar null", async () => {
  const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
  const admin = fakeCache([row()]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    nowMs,
    fetchProfilePictureUrl: () => Promise.resolve(null),
    cacheAvatar: () => {
      throw new Error("cache must not run on a miss");
    },
  }, target());
  assertEquals(admin.rows[0].participant_avatar, null);
  assertEquals(admin.rows[0].participant_avatar_checked_at, new Date(nowMs).toISOString());
});

Deno.test("a fetch error leaves both columns untouched", async () => {
  const admin = fakeCache([row()]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    fetchProfilePictureUrl: () => Promise.reject(new Error("Evolution API request timed out")),
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
  assertEquals(admin.rows[0].participant_avatar, null);
  assertEquals(admin.rows[0].participant_avatar_checked_at, null);
});

Deno.test("a cache throw leaves both columns untouched", async () => {
  const admin = fakeCache([row()]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.reject(new TypeError("network")),
  }, target());
  assertEquals(admin.rows[0].participant_avatar, null);
  assertEquals(admin.rows[0].participant_avatar_checked_at, null);
});

Deno.test("a fresh negative cache does not call Evolution", async () => {
  const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
  const admin = fakeCache([row({
    participant_avatar_checked_at: new Date(nowMs - 60_000).toISOString(),
  })]);
  let fetched = false;
  await enrichWhatsAppParticipantAvatar({
    admin,
    nowMs,
    fetchProfilePictureUrl: () => {
      fetched = true;
      return Promise.resolve(SOURCE);
    },
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
  assertEquals(fetched, false);
  assertEquals(admin.updates.length, 0);
});

Deno.test("a stale checked_at re-fetches", async () => {
  const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
  const admin = fakeCache([row({
    participant_avatar_checked_at: new Date(nowMs - AVATAR_NEGATIVE_CACHE_MS - 1).toISOString(),
  })]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    nowMs,
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
  assertEquals(admin.rows[0].participant_avatar, CLOUDINARY);
});

Deno.test("a failed cache read is not treated as empty and does not fetch", async () => {
  const admin = fakeCache([row()], { readError: "statement timeout" });
  let fetched = false;
  await enrichWhatsAppParticipantAvatar({
    admin,
    fetchProfilePictureUrl: () => {
      fetched = true;
      return Promise.resolve(SOURCE);
    },
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
  assertEquals(fetched, false);
  assertEquals(admin.updates.length, 0);
});

Deno.test("enrichment never throws into the webhook", async () => {
  await enrichWhatsAppParticipantAvatar({
    admin: {
      from: () => {
        throw new Error("boom");
      },
    },
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
});

Deno.test("an elapsed deadline skips without stamping", async () => {
  const admin = fakeCache([row()]);
  await enrichWhatsAppParticipantAvatar({
    admin,
    deadlineAt: Date.now() - 1,
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, target());
  assertEquals(admin.updates.length, 0);
});

Deno.test("backfill fetches at most 25 conversations", async () => {
  const eligible = Array.from({ length: 30 }, (_, index) =>
    row({ conversation_id: `wa_96597950350_9655000${String(index).padStart(4, "0")}` })
  );
  const admin = fakeCache(eligible);
  const fetched: string[] = [];
  await backfillWhatsAppParticipantAvatars({
    admin,
    fetchProfilePictureUrl: (_instance, number) => {
      fetched.push(number);
      return Promise.resolve(null);
    },
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, scope());
  assertEquals(fetched.length, BACKFILL_MAX);
});

Deno.test("backfill skips a fresh negative-cache row inside the page", async () => {
  const nowMs = Date.parse("2026-09-07T12:00:00.000Z");
  const admin = fakeCache([
    row({
      conversation_id: "wa_96597950350_10000000000",
      participant_avatar_checked_at: new Date(nowMs).toISOString(),
    }),
    row({ conversation_id: "wa_96597950350_96550000001" }),
  ]);
  const fetched: string[] = [];
  await backfillWhatsAppParticipantAvatars({
    admin,
    nowMs,
    fetchProfilePictureUrl: (_instance, number) => {
      fetched.push(number);
      return Promise.resolve(null);
    },
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, scope());
  assertEquals(fetched, ["96550000001"]);
});

Deno.test("a failed backfill read does not look empty", async () => {
  const admin = fakeCache([row()], { readError: "timeout" });
  let fetched = false;
  await backfillWhatsAppParticipantAvatars({
    admin,
    fetchProfilePictureUrl: () => {
      fetched = true;
      return Promise.resolve(SOURCE);
    },
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, scope());
  assertEquals(fetched, false);
});

Deno.test("backfill never throws", async () => {
  await backfillWhatsAppParticipantAvatars({
    admin: {
      from: () => {
        throw new Error("boom");
      },
    },
    fetchProfilePictureUrl: () => Promise.resolve(SOURCE),
    cacheAvatar: () => Promise.resolve(CLOUDINARY),
  }, scope());
});

Deno.test("isDurableCloudinaryUrl requires a Cloudinary host that is not the source", () => {
  assertEquals(isDurableCloudinaryUrl(CLOUDINARY, SOURCE), true);
  assertEquals(
    isDurableCloudinaryUrl("https://media.cloudinary.com/x.jpg", SOURCE),
    true,
  );
  assertEquals(isDurableCloudinaryUrl(SOURCE, SOURCE), false);
  assertEquals(isDurableCloudinaryUrl("https://pps.whatsapp.net/other.jpg", SOURCE), false);
  assertEquals(isDurableCloudinaryUrl("not a url", SOURCE), false);
});

Deno.test("contactNumberFromConversationId reads the trailing digits", () => {
  assertEquals(contactNumberFromConversationId(CONVERSATION), NUMBER);
  assertEquals(contactNumberFromConversationId("wa_owner_not-a-number"), null);
});
