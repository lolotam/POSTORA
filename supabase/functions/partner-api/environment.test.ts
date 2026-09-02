// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  authenticatePartnerKey,
  doorEnvironment,
  generatePartnerKey,
  PartnerAuthError,
} from "../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// Phase 10.5 — a staging key must never authenticate against production
// (PRD §45), and the reverse. Staging will be a RESTORED PRODUCTION DUMP, so
// "the hash is not in the table" is not a control anyone gets to rely on:
// every case below that reaches the lookup has the stub RETURN a row, and the
// door must still refuse. The refusal is the unknown-key answer, byte for
// byte, so neither door confirms the other's keys exist.
// ---------------------------------------------------------------------------

const PROD_ROW = {
  id: "key-prod",
  workspace_id: "ws-a",
  social_account_id: "acct-a",
  key_prefix: "pk_live_aaaa",
  scopes: ["messages:send"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
  environment: "production",
};

const STAGING_ROW = { ...PROD_ROW, id: "key-staging", key_prefix: "pk_test_bbbb", environment: "staging" };

/** A stub whose lookup always answers `row`, counting how often it is asked. */
function lookupStub(row: unknown) {
  let lookups = 0;
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          lookups += 1;
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  };
  return { client, lookups: () => lookups };
}

async function refusal(client: unknown, key: string, door: "staging" | "production") {
  return await assertRejects(
    () => authenticatePartnerKey(client, key, new Date(), door),
    PartnerAuthError,
  );
}

const PROD_KEY = "pk_live_0123456789abcdef";
const STAGING_KEY = "pk_test_0123456789abcdef";

Deno.test("a staging key at a production door is refused before any lookup, as an unknown key would be", async () => {
  const unknown = lookupStub(null);
  const unknownErr = await refusal(unknown.client, PROD_KEY, "production");

  const staging = lookupStub(STAGING_ROW);
  const err = await refusal(staging.client, STAGING_KEY, "production");

  assertEquals([err.code, err.status, err.message], [unknownErr.code, unknownErr.status, unknownErr.message]);
  assertEquals(err.code, "invalid_key");
  assertEquals(staging.lookups(), 0);
  assertEquals(unknown.lookups(), 1);
});

Deno.test("a production key at a staging door is refused before any lookup, as an unknown key would be", async () => {
  const unknown = lookupStub(null);
  const unknownErr = await refusal(unknown.client, STAGING_KEY, "staging");

  const prod = lookupStub(PROD_ROW);
  const err = await refusal(prod.client, PROD_KEY, "staging");

  assertEquals([err.code, err.status, err.message], [unknownErr.code, unknownErr.status, unknownErr.message]);
  assertEquals(prod.lookups(), 0);
});

Deno.test("a row whose environment disagrees with the door is refused after the lookup, with the unknown-key answer", async () => {
  // Only a hand-inserted row can carry a production prefix and a staging
  // environment — the mint refuses the combination. The column layer must
  // hold anyway: the prefix layer is the cheap check, not the proof.
  const lying = lookupStub({ ...PROD_ROW, environment: "staging" });
  const err = await refusal(lying.client, PROD_KEY, "production");
  assertEquals(err.code, "invalid_key");
  assertEquals(err.status, 401);
  assertEquals(lying.lookups(), 1);

  const reverse = lookupStub({ ...STAGING_ROW, environment: "production" });
  const reverseErr = await refusal(reverse.client, STAGING_KEY, "staging");
  assertEquals(reverseErr.code, "invalid_key");
  assertEquals(reverse.lookups(), 1);
});

Deno.test("a key in the door's own environment authenticates (both doors)", async () => {
  const prod = lookupStub(PROD_ROW);
  assertEquals((await authenticatePartnerKey(prod.client, PROD_KEY, new Date(), "production")).id, "key-prod");

  const staging = lookupStub(STAGING_ROW);
  assertEquals((await authenticatePartnerKey(staging.client, STAGING_KEY, new Date(), "staging")).id, "key-staging");
});

Deno.test("a row without the environment field is treated as production — the column's NOT NULL default", async () => {
  // Every deployed row has the column. Fixtures written before 10.5 do not,
  // and they must keep meaning what they meant: a production key.
  const { environment: _dropped, ...legacyRow } = PROD_ROW;
  const legacy = lookupStub(legacyRow);
  assertEquals((await authenticatePartnerKey(legacy.client, PROD_KEY, new Date(), "production")).id, "key-prod");
});

Deno.test("an unrecognised PARTNER_API_ENVIRONMENT refuses every key with internal_error and no lookup", async () => {
  const err = assertThrows(() => doorEnvironment("prod"), PartnerAuthError);
  assertEquals([err.code, err.status], ["internal_error", 500]);

  // The default parameter is evaluated before the body runs, so a valid
  // production key is refused before its hash is ever computed.
  const prod = lookupStub(PROD_ROW);
  const doorErr = await assertRejects(
    async () => await authenticatePartnerKey(prod.client, PROD_KEY, new Date(), doorEnvironment("prod")),
    PartnerAuthError,
  );
  assertEquals(doorErr.code, "internal_error");
  assertEquals(prod.lookups(), 0);
});

Deno.test("an unset or empty PARTNER_API_ENVIRONMENT means production — the live deployment has it unset", () => {
  assertEquals(doorEnvironment(undefined), "production");
  assertEquals(doorEnvironment(""), "production");
  assertEquals(doorEnvironment("staging"), "staging");
});

Deno.test("generatePartnerKey mints the prefix of the environment it is asked for", async () => {
  assertEquals((await generatePartnerKey("production")).key.startsWith("pk_live_"), true);
  assertEquals((await generatePartnerKey("staging")).key.startsWith("pk_test_"), true);
  // The stored prefix is the first 12 characters for both, so a staging key's
  // prefix shows its environment in the audit trail.
  assertEquals((await generatePartnerKey("staging")).prefix.length, 12);
});
