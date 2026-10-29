/**
 * The canonical Meta OAuth attempt adapter.
 *
 * These tests cover three things:
 *
 *   1. the strict driver-envelope discipline: a malformed, thrown, inherited
 *      or non-null-error read is a typed failure and never an empty success;
 *   2. the accepted payload whitelists and the actual SQL result shapes;
 *   3. the alignment between this adapter and the two accepted migrations.
 *
 * The alignment test reads the migration files from the repository. It is the
 * reason the contract version exists: when the database changes, this test
 * fails instead of the wire silently changing.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  META_OAUTH_BEGIN_PAYLOAD_KEYS,
  META_OAUTH_CANDIDATE_KEYS,
  META_OAUTH_CONTRACT_VERSION,
  META_OAUTH_RPC,
  META_OAUTH_STASH_KEYS,
  MetaOAuthStoreError,
  buildBeginPayload,
  buildStash,
  createMetaOAuthAttemptStore,
  parseBeginResult,
  parseClaimResult,
  parseCompleteResult,
  parsePickerResult,
  parseReceipt,
  type MetaOAuthAttemptStore,
} from "./metaOAuthAttemptStore.ts";

const testFilePath = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(dirname(testFilePath))));
const LIFECYCLE_MIGRATION = join(
  REPO_ROOT,
  "supabase/migrations/20261027110000_meta_oauth_attempt_lifecycle.sql",
);
const ALIAS_MIGRATION = join(
  REPO_ROOT,
  "supabase/migrations/20261028100000_meta_oauth_identity_alias.sql",
);

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "c0000000-0000-4000-8000-000000000001";
const PENDING_ID = "d0000000-0000-4000-8000-000000000001";
const SELECTION_KEY = "facebook_page:page:page-1";
const CLAIM_TOKEN = "claim-token-must-not-leak";
const PROVIDER_TOKEN = "provider-token-must-not-leak";

function rpcCaller(response: unknown, calls: string[] = []) {
  return async (name: string) => {
    calls.push(name);
    return response;
  };
}

function storeWith(response: unknown, calls: string[] = []): MetaOAuthAttemptStore {
  return createMetaOAuthAttemptStore(rpcCaller(response, calls));
}

Deno.test("the adapter refuses a driver envelope that is not a plain object", async () => {
  const store = storeWith("not-an-envelope");
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "malformed response",
  );
});

Deno.test("the adapter refuses a driver envelope without an own error property", async () => {
  const store = storeWith({ data: { attempt_id: ATTEMPT_ID } });
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "malformed response",
  );
});

Deno.test("the adapter refuses an inherited error property", async () => {
  const envelope = Object.create({ data: { attempt_id: ATTEMPT_ID }, error: null });
  const store = storeWith(envelope);
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "malformed response",
  );
});

Deno.test("the adapter refuses an undefined error property", async () => {
  const store = storeWith({ data: { attempt_id: ATTEMPT_ID }, error: undefined });
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "malformed response",
  );
});

Deno.test("the adapter refuses a null data payload", async () => {
  const store = storeWith({ data: null, error: null });
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "empty response",
  );
});

Deno.test("a thrown rpc call is a typed failure, never an empty success", async () => {
  const store = createMetaOAuthAttemptStore(async () => {
    throw new Error(`transport failed ${PROVIDER_TOKEN}`);
  });
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "could not be read",
  );
});

Deno.test("a missing function is reported as an unavailable schema", async () => {
  const store = storeWith({
    data: null,
    error: { message: `Could not find the function public.${META_OAUTH_RPC.begin}`, code: "PGRST202" },
  });
  await assertRejects(
    () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
    MetaOAuthStoreError,
    "is not available in this deployment",
  );
});

Deno.test("the sqlstate taxonomy is mapped without keeping the driver message", async () => {
  const cases: Array<[string, string]> = [
    ["MOA01", "refused the payload"],
    ["MOA02", "refused the request"],
    ["MOA03", "refused a conflicting request"],
    ["MOA04", "refused the request"],
    ["MOA07", "refused a stale capture"],
    ["MOA08", "refused an expired attempt"],
    ["MOA09", "is busy"],
    ["MOA10", "refused the request"],
    ["MOA11", "refused the request"],
    ["P0001", "refused the request"],
  ];
  for (const [code, message] of cases) {
    const store = storeWith({
      data: null,
      error: { message: `driver text ${PROVIDER_TOKEN}`, code },
    });
    const error = await assertRejects(
      () => store.begin({ userId: USER_ID, payload: { flow: "facebook_page", intent: "connect_new" } }),
      MetaOAuthStoreError,
    );
    assertEquals(error.message.includes(PROVIDER_TOKEN), false);
    assertStringIncludes(error.message, message);
    assertEquals(error.sqlstate, code);
  }
});

Deno.test("the begin payload omits absent keys instead of sending a json null", () => {
  const payload = buildBeginPayload({
    flow: "instagram_direct",
    intent: "reconnect",
    target_social_account_id: ATTEMPT_ID,
  });
  assertEquals(Object.keys(payload).sort(), ["flow", "intent", "target_social_account_id"]);
  assertEquals(Object.hasOwn(payload, "source_social_account_id"), false);
});

Deno.test("the stash omits absent keys and keeps the candidate whitelist", () => {
  const stash = buildStash({
    candidates: [
      {
        ig_user_id: "ig-1",
        ig_igid: "igid-1",
        unknown_field: "not-allowed",
      } as never,
    ],
    user_token: PROVIDER_TOKEN,
    direct_token_expires_in: 3600,
  });
  assertEquals(Object.keys(stash).sort(), ["candidates", "direct_token_expires_in", "user_token"]);
  const candidate = (stash.candidates as Record<string, unknown>[])[0];
  assertEquals(Object.keys(candidate).sort(), ["ig_igid", "ig_user_id"]);
});

Deno.test("a begin result that does not match the contract is a typed failure", async () => {
  await assertRejects(
    async () => {
      parseBeginResult("begin", { attempt_id: ATTEMPT_ID });
    },
    MetaOAuthStoreError,
  );
  await assertRejects(
    async () => {
      parseBeginResult("begin", {
        attempt_id: ATTEMPT_ID,
        flow: "not_a_flow",
        intent: "connect_new",
        user_id: USER_ID,
        capture_version: 1,
        nonce: "n",
        state: { attempt_id: ATTEMPT_ID, nonce: "n", flow: "not_a_flow" },
      });
    },
    MetaOAuthStoreError,
  );
});

Deno.test("the claim result keeps the claim token inside the service boundary", () => {
  const parsed = parseClaimResult("claim", {
    attempt_id: ATTEMPT_ID,
    flow: "facebook_page",
    claim_token: CLAIM_TOKEN,
    claimed_at: "2026-10-28T10:00:00+00:00",
    callback_deadline: "2026-10-28T10:10:00+00:00",
    picker_deadline: "2026-10-28T10:15:00+00:00",
  });
  assertEquals(parsed.claimToken, CLAIM_TOKEN);
  assertEquals(parsed.flow, "facebook_page");
});

Deno.test("the normal picker result does not require an expired flag", () => {
  const parsed = parsePickerResult("read", {
    attempt_id: ATTEMPT_ID,
    flow: "instagram_page_linked",
    intent: "connect_new",
    social_profile_id: null,
    picker_deadline: "2026-10-28T10:15:00+00:00",
    expires_at: "2026-10-28T10:15:00+00:00",
    committed_selection_keys: [],
    candidates: [
      {
        selection_key: "instagram_page_linked:ig:ig-1",
        ig_user_id: "ig-1",
        ig_username: "shop",
        ig_profile_picture_url: null,
        facebook_page_id: "page-1",
        facebook_page_name: "Shop",
      },
    ],
  });
  assertEquals(parsed.expired, false);
  assertEquals(parsed.status, null);
  assertEquals(parsed.candidates.length, 1);
  assertEquals(parsed.candidates[0].selectionKey, "instagram_page_linked:ig:ig-1");
});

Deno.test("the expired picker result carries the expired status and no candidates", () => {
  const parsed = parsePickerResult("read", {
    attempt_id: ATTEMPT_ID,
    flow: "instagram_page_linked",
    intent: "connect_new",
    social_profile_id: null,
    picker_deadline: "2026-10-28T10:15:00+00:00",
    expires_at: "2026-10-28T10:15:00+00:00",
    status: "expired",
    expired: true,
    committed_selection_keys: ["instagram_page_linked:ig:ig-1"],
    candidates: [],
  });
  assertEquals(parsed.expired, true);
  assertEquals(parsed.status, "expired");
  assertEquals(parsed.candidates, []);
});

Deno.test("a picker result that claims expiry without the expired status is a typed failure", async () => {
  await assertRejects(
    async () => {
      parsePickerResult("read", {
        attempt_id: ATTEMPT_ID,
        flow: "instagram_page_linked",
        intent: "connect_new",
        social_profile_id: null,
        picker_deadline: null,
        expires_at: null,
        expired: true,
        committed_selection_keys: [],
        candidates: [],
      });
    },
    MetaOAuthStoreError,
  );
});

Deno.test("the receipt carries no token and rejects an unknown platform", async () => {
  const receipt = parseReceipt("commit", {
    attempt_id: ATTEMPT_ID,
    selection_key: SELECTION_KEY,
    flow: "facebook_page",
    intent: "connect_new",
    platform: "facebook",
    platform_user_id: "page-1",
    instagram_user_id: null,
    facebook_page_id: "page-1",
    facebook_user_id: "fb-1",
    social_account_id: "acct-1",
    companion_social_account_id: null,
    username: "Shop",
    operation: "created",
    login_kind: null,
    credential_id: "cred-1",
    credential_revision: 1,
    connection_version: 1,
    capability_generation: 2,
    committed_at: "2026-10-28T10:05:00+00:00",
  });
  assertEquals(receipt.platform, "facebook");
  assertEquals(JSON.stringify(receipt).includes("token"), false);

  await assertRejects(
    async () => {
      parseReceipt("commit", {
        attempt_id: ATTEMPT_ID,
        selection_key: SELECTION_KEY,
        flow: "facebook_page",
        intent: "connect_new",
        platform: "tiktok",
      });
    },
    MetaOAuthStoreError,
  );
});

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    selection_key: SELECTION_KEY,
    flow: "facebook_page",
    intent: "connect_new",
    platform: "facebook",
    platform_user_id: "page-1",
    instagram_user_id: null,
    facebook_page_id: "page-1",
    facebook_user_id: "fb-1",
    social_account_id: "acct-1",
    companion_social_account_id: null,
    login_kind: null,
    credential_id: null,
    ...overrides,
  };
}

Deno.test("a committed receipt keeps the three accepted shapes and refuses a broken one", async () => {
  assertEquals(parseReceipt("commit", receiptRow()).socialAccountId, "acct-1");
  assertEquals(parseReceipt("commit", receiptRow({
    flow: "instagram_direct",
    platform: "instagram",
    platform_user_id: "ig-canonical",
    instagram_user_id: "ig-canonical",
    facebook_page_id: null,
    facebook_user_id: null,
    login_kind: "direct",
    credential_id: null,
    credential_revision: null,
    connection_version: null,
  })).loginKind, "direct");
  assertEquals(parseReceipt("commit", receiptRow({
    flow: "instagram_page_linked",
    platform: "instagram",
    platform_user_id: "ig-1",
    instagram_user_id: "ig-1",
    facebook_page_id: "page-1",
    facebook_user_id: "fb-1",
    login_kind: "page_linked",
  })).platform, "instagram");
  const linkedPage = parseReceipt("commit", receiptRow({
    instagram_user_id: "ig-1",
    companion_social_account_id: "acct-2",
    login_kind: "page_linked",
  }));
  assertEquals(linkedPage.companionSocialAccountId, "acct-2");

  for (const broken of [
    receiptRow({ social_account_id: null }),
    (() => {
      const { social_account_id: _omitted, ...missing } = receiptRow();
      return missing;
    })(),
    receiptRow({ platform: "instagram" }),
    receiptRow({ platform_user_id: "page\u0000id" }),
    receiptRow({
      instagram_user_id: "ig-1",
      companion_social_account_id: null,
      login_kind: null,
    }),
  ]) {
    const error = await assertRejects(
      async () => {
        parseReceipt("commit", broken);
      },
      MetaOAuthStoreError,
    );
    assertEquals((error as MetaOAuthStoreError).code, "invalid_contract");
  }
});

Deno.test("complete agrees with the requested flow and does not send flow to sql", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const direct = createMetaOAuthAttemptStore(async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    return {
      data: {
        attempt_id: ATTEMPT_ID,
        flow: "instagram_direct",
        pending_selection_id: PENDING_ID,
        login_kind: "direct",
        picker_deadline: null,
        candidates: [{
          selection_key: "instagram_direct:ig:ig-canonical",
          ig_user_id: "ig-canonical",
          ig_username: "shop",
          ig_profile_picture_url: null,
          facebook_page_id: null,
          facebook_page_name: null,
        }],
      },
      error: null,
    };
  });
  const matched = await direct.complete({
    userId: USER_ID,
    attemptId: ATTEMPT_ID,
    flow: "instagram_direct",
    claimToken: CLAIM_TOKEN,
    stash: { user_token: PROVIDER_TOKEN, candidates: [] },
  });
  assertEquals(matched.flow, "instagram_direct");
  const payload = calls[0].args.p_payload as Record<string, unknown>;
  assertEquals(Object.keys(payload).sort(), ["attempt_id", "claim_token", "stash"]);
  assertEquals(payload.flow, undefined);

  const mismatch = createMetaOAuthAttemptStore(async () => ({
    data: {
      attempt_id: ATTEMPT_ID,
      flow: "facebook_page",
      pending_selection_id: PENDING_ID,
      login_kind: null,
      picker_deadline: null,
      candidates: [{
        selection_key: "facebook_page:page:page-1",
        ig_user_id: null,
        ig_username: null,
        ig_profile_picture_url: null,
        facebook_page_id: "page-1",
        facebook_page_name: "Shop",
      }],
    },
    error: null,
  }));
  const error = await assertRejects(
    () => mismatch.complete({
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
      flow: "instagram_direct",
      claimToken: CLAIM_TOKEN,
      stash: { user_token: PROVIDER_TOKEN, candidates: [] },
    }),
    MetaOAuthStoreError,
  );
  assertEquals((error as MetaOAuthStoreError).code, "invalid_contract");
});

Deno.test("the store calls the accepted rpc names with the accepted arguments", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const store = createMetaOAuthAttemptStore(async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    if (name === META_OAUTH_RPC.begin) {
      return {
        data: {
          attempt_id: ATTEMPT_ID,
          flow: "facebook_page",
          intent: "connect_new",
          user_id: USER_ID,
          target_social_account_id: null,
          linked_target_social_account_id: null,
          source_social_account_id: null,
          intended_social_profile_id: null,
          capture_version: 1,
          captured_at: "2026-10-28T10:00:00+00:00",
          nonce: "nonce-1",
          nonce_digest: "digest",
          state: { attempt_id: ATTEMPT_ID, nonce: "nonce-1", flow: "facebook_page" },
          callback_deadline: "2026-10-28T10:10:00+00:00",
          picker_deadline: "2026-10-28T10:15:00+00:00",
          capture: { capture_version: 1 },
        },
        error: null,
      };
    }
    return { data: null, error: { message: "unexpected call", code: "P0001" } };
  });

  await store.begin({
    userId: USER_ID,
    payload: { flow: "facebook_page", intent: "connect_new" },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "begin_meta_oauth_attempt");
  assertEquals(Object.keys(calls[0].args).sort(), ["p_payload", "p_user_id"]);
});

// ---------------------------------------------------------------------------
// Alignment with the accepted SQL
// ---------------------------------------------------------------------------

Deno.test("the adapter matches the accepted sql signatures", async () => {
  const lifecycle = await Deno.readTextFile(LIFECYCLE_MIGRATION);
  const alias = await Deno.readTextFile(ALIAS_MIGRATION);

  const expected: Array<[string, string[]]> = [
    [META_OAUTH_RPC.begin, ["p_user_id", "p_payload"]],
    [META_OAUTH_RPC.claim, ["p_user_id", "p_payload"]],
    [META_OAUTH_RPC.complete, ["p_user_id", "p_payload"]],
    [META_OAUTH_RPC.read, ["p_user_id", "p_pending_selection_id"]],
    [META_OAUTH_RPC.commit, ["p_user_id", "p_payload"]],
  ];

  for (const [name, parameters] of expected) {
    const signature = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\(\\s*([\\s\\S]*?)\\)\\s*RETURNS JSONB`,
    ).exec(lifecycle);
    assertEquals(signature !== null, true, `${name} is not declared in the lifecycle migration`);
    const declared = (signature as RegExpExecArray)[1]
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((part) => part.length > 0);
    assertEquals(declared, parameters, `${name} declares a different argument list`);
  }

  // The identity-alias migration replaces the callback completion and the
  // selection commit. Both names must still exist there.
  assertEquals(alias.includes(`CREATE OR REPLACE FUNCTION public.${META_OAUTH_RPC.complete}`), true);
  assertEquals(alias.includes(`CREATE OR REPLACE FUNCTION public.${META_OAUTH_RPC.commit}`), true);
});

Deno.test("the accepted payload whitelists match the migration text", async () => {
  const lifecycle = await Deno.readTextFile(LIFECYCLE_MIGRATION);
  const alias = await Deno.readTextFile(ALIAS_MIGRATION);
  const sql = `${lifecycle}\n${alias}`;

  for (const key of META_OAUTH_BEGIN_PAYLOAD_KEYS) {
    assertEquals(sql.includes(`'${key}'`), true, `the begin whitelist lost ${key}`);
  }
  for (const key of META_OAUTH_STASH_KEYS) {
    assertEquals(sql.includes(`'${key}'`), true, `the stash whitelist lost ${key}`);
  }
  for (const key of META_OAUTH_CANDIDATE_KEYS) {
    assertEquals(sql.includes(`'${key}'`), true, `the candidate whitelist lost ${key}`);
  }
});

Deno.test("the contract version names the two accepted migrations", () => {
  assertEquals(META_OAUTH_CONTRACT_VERSION.includes("meta_oauth_attempt_lifecycle"), true);
  assertEquals(META_OAUTH_CONTRACT_VERSION.includes("identity_alias"), true);
});
