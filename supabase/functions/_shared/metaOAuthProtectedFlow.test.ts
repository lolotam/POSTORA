/**
 * The protected Meta OAuth flow: pending-reference classification, the
 * explicit intent, the signed-state context, the safe picker projection and
 * the post-commit subscription.
 *
 * These are the decisions that decide whether a request may reach a provider
 * call, a mutation, a secret read or a deletion. They are tested on their
 * own so the actual-handler suite can stay about the routes.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  PROTECTED_ATTEMPT_STATE_KEY,
  ProtectedOAuthError,
  assertDirectIdentityEvidence,
  assertWebhookSubscription,
  classifyPendingReference,
  inspectDirectCandidateReadiness,
  protectedCloseOutcome,
  projectProtectedPicker,
  readProtectedAttemptContext,
  resolveProtectedIntent,
  type PendingLinkageReader,
  type PendingLinkageRow,
} from "./metaOAuthProtectedFlow.ts";
import type { MetaOAuthReceipt } from "./metaOAuthAttemptStore.ts";

const USER_ID = "b0000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "b0000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "c0000000-0000-4000-8000-000000000001";
const PENDING_ID = "d0000000-0000-4000-8000-000000000001";
const TARGET_ID = "e0000000-0000-4000-8000-000000000001";
const SOURCE_ID = "e0000000-0000-4000-8000-000000000002";
const TOKEN = "provider-token-must-not-leak";

function reader(rows: {
  instagram?: PendingLinkageRow | null;
  facebook?: PendingLinkageRow | null;
  instagramError?: boolean;
  facebookError?: boolean;
}): PendingLinkageReader {
  return {
    async readInstagramStash() {
      if (rows.instagramError) throw new Error("read failed");
      return rows.instagram ?? null;
    },
    async readFacebookStash() {
      if (rows.facebookError) throw new Error("read failed");
      return rows.facebook ?? null;
    },
  };
}

function protectedRow(overrides: Partial<PendingLinkageRow> = {}): PendingLinkageRow {
  return {
    id: PENDING_ID,
    userId: USER_ID,
    attemptId: ATTEMPT_ID,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  };
}

Deno.test("a provider token with a pending reference is ambiguous", async () => {
  const outcome = await classifyPendingReference(reader({}), {
    userId: USER_ID,
    selectionId: PENDING_ID,
    attemptId: null,
    providerTokenPresent: true,
  });
  assertEquals(outcome.kind, "ambiguous");
});

Deno.test("a provider token with an attempt reference is ambiguous", async () => {
  const outcome = await classifyPendingReference(reader({}), {
    userId: USER_ID,
    selectionId: null,
    attemptId: ATTEMPT_ID,
    providerTokenPresent: true,
  });
  assertEquals(outcome.kind, "ambiguous");
});

Deno.test("a request without any reference classifies as none", async () => {
  const outcome = await classifyPendingReference(reader({}), {
    userId: USER_ID,
    selectionId: null,
    attemptId: null,
    providerTokenPresent: false,
  });
  assertEquals(outcome.kind, "none");
});

Deno.test("an attempt-scoped reference without a stash row is protected", async () => {
  const outcome = await classifyPendingReference(reader({}), {
    userId: USER_ID,
    selectionId: null,
    attemptId: ATTEMPT_ID,
    providerTokenPresent: false,
  });
  assertEquals(outcome.kind, "protected");
  if (outcome.kind !== "protected") return;
  assertEquals(outcome.attemptId, ATTEMPT_ID);
});

Deno.test("a row with an attempt linkage is protected and unexpired", async () => {
  const outcome = await classifyPendingReference(reader({ instagram: protectedRow() }), {
    userId: USER_ID,
    selectionId: PENDING_ID,
    attemptId: null,
    providerTokenPresent: false,
  });
  assertEquals(outcome.kind, "protected");
  if (outcome.kind !== "protected") return;
  assertEquals(outcome.attemptId, ATTEMPT_ID);
  assertEquals(outcome.expired, false);
});

Deno.test("a protected Facebook candidate resolves in the existing Instagram stash", async () => {
  const outcome = await classifyPendingReference(
    reader({ instagram: protectedRow() }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: null,
      providerTokenPresent: false,
    },
  );
  assertEquals(outcome.kind, "protected");
});

Deno.test("a row without an attempt linkage is legacy", async () => {
  const outcome = await classifyPendingReference(
    reader({ instagram: protectedRow({ attemptId: null }) }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: null,
      providerTokenPresent: false,
    },
  );
  assertEquals(outcome.kind, "legacy");
});

Deno.test("an expired row is distinguished from a live one", async () => {
  const outcome = await classifyPendingReference(
    reader({ instagram: protectedRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }) }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: null,
      providerTokenPresent: false,
    },
  );
  assertEquals(outcome.kind, "protected");
  if (outcome.kind !== "protected") return;
  assertEquals(outcome.expired, true);
});

Deno.test("a missing row is not a foreign row", async () => {
  const missing = await classifyPendingReference(reader({}), {
    userId: USER_ID,
    selectionId: PENDING_ID,
    attemptId: null,
    providerTokenPresent: false,
  });
  assertEquals(missing.kind, "missing");

  const foreign = await classifyPendingReference(
    reader({ instagram: protectedRow({ userId: OTHER_USER_ID }) }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: null,
      providerTokenPresent: false,
    },
  );
  assertEquals(foreign.kind, "foreign");
});

Deno.test("a failed read is never a missing row", async () => {
  const outcome = await classifyPendingReference(reader({ instagramError: true }), {
    userId: USER_ID,
    selectionId: PENDING_ID,
    attemptId: null,
    providerTokenPresent: false,
  });
  assertEquals(outcome.kind, "read_failed");
});

Deno.test("a reference that resolves to two rows is conflicting", async () => {
  const outcome = await classifyPendingReference(
    reader({ instagram: protectedRow(), facebook: protectedRow() }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: null,
      providerTokenPresent: false,
    },
  );
  assertEquals(outcome.kind, "conflicting");
});

Deno.test("a row and an attempt that disagree are conflicting", async () => {
  const outcome = await classifyPendingReference(reader({ instagram: protectedRow() }), {
    userId: USER_ID,
    selectionId: PENDING_ID,
    attemptId: "c0000000-0000-4000-8000-000000000009",
    providerTokenPresent: false,
  });
  assertEquals(outcome.kind, "conflicting");
});

Deno.test("a legacy row cannot carry an attempt reference", async () => {
  const outcome = await classifyPendingReference(
    reader({ instagram: protectedRow({ attemptId: null }) }),
    {
      userId: USER_ID,
      selectionId: PENDING_ID,
      attemptId: ATTEMPT_ID,
      providerTokenPresent: false,
    },
  );
  assertEquals(outcome.kind, "conflicting");
});

// ---------------------------------------------------------------------------
// Explicit intent
// ---------------------------------------------------------------------------

Deno.test("a request without a target or a source is a new connection", () => {
  assertEquals(resolveProtectedIntent({}).intent, "connect_new");
});

Deno.test("a request that names a target is a reconnect of that target", () => {
  const intent = resolveProtectedIntent({ targetSocialAccountId: TARGET_ID });
  assertEquals(intent.intent, "reconnect");
  assertEquals(intent.targetSocialAccountId, TARGET_ID);
});

Deno.test("a request that names a source extends that source's grant", () => {
  const intent = resolveProtectedIntent({ sourceSocialAccountId: SOURCE_ID });
  assertEquals(intent.intent, "add_to_existing_grant");
  assertEquals(intent.sourceSocialAccountId, SOURCE_ID);
});

Deno.test("an explicit intent wins over the derived one", () => {
  const intent = resolveProtectedIntent({
    intent: "rebind",
    targetSocialAccountId: TARGET_ID,
  });
  assertEquals(intent.intent, "rebind");
  assertEquals(intent.targetSocialAccountId, TARGET_ID);
});

Deno.test("an unknown intent is refused", async () => {
  await assertRejects(
    async () => resolveProtectedIntent({ intent: "adopt_whatever" }),
    ProtectedOAuthError,
    "not accepted",
  );
});

Deno.test("a reconnect without a target is refused", async () => {
  await assertRejects(
    async () => resolveProtectedIntent({ intent: "reconnect" }),
    ProtectedOAuthError,
    "explicit target account",
  );
});

Deno.test("a reconnect that also names a source is refused", async () => {
  await assertRejects(
    async () =>
      resolveProtectedIntent({
        intent: "reconnect",
        targetSocialAccountId: TARGET_ID,
        sourceSocialAccountId: SOURCE_ID,
      }),
    ProtectedOAuthError,
    "must not name a source account",
  );
});

Deno.test("a new connection that names a target is refused", async () => {
  await assertRejects(
    async () =>
      resolveProtectedIntent({ intent: "connect_new", targetSocialAccountId: TARGET_ID }),
    ProtectedOAuthError,
    "must not name a target or a source account",
  );
});

Deno.test("a malformed account id is refused before the attempt is created", async () => {
  await assertRejects(
    async () => resolveProtectedIntent({ targetSocialAccountId: "not-a-uuid" }),
    ProtectedOAuthError,
    "not a valid account id",
  );
});

// ---------------------------------------------------------------------------
// Signed-state context
// ---------------------------------------------------------------------------

Deno.test("a state without a protected context yields no context", () => {
  assertEquals(readProtectedAttemptContext({ platform: "instagram" }), null);
  assertEquals(readProtectedAttemptContext(null), null);
});

Deno.test("a signed protected context is read back", () => {
  const context = readProtectedAttemptContext({
    [PROTECTED_ATTEMPT_STATE_KEY]: {
      attempt_id: ATTEMPT_ID,
      nonce: "nonce-1",
      flow: "instagram_direct",
    },
  });
  assertEquals(context?.attempt_id, ATTEMPT_ID);
  assertEquals(context?.nonce, "nonce-1");
  assertEquals(context?.flow, "instagram_direct");
});

Deno.test("a malformed protected context is a typed refusal", async () => {
  await assertRejects(
    async () => readProtectedAttemptContext({ [PROTECTED_ATTEMPT_STATE_KEY]: { attempt_id: 1 } }),
    ProtectedOAuthError,
    "malformed",
  );
  await assertRejects(
    async () =>
      readProtectedAttemptContext({
        [PROTECTED_ATTEMPT_STATE_KEY]: {
          attempt_id: ATTEMPT_ID,
          nonce: "n",
          flow: "not_a_flow",
        },
      }),
    ProtectedOAuthError,
    "malformed",
  );
});

// ---------------------------------------------------------------------------
// Picker projection
// ---------------------------------------------------------------------------

Deno.test("the picker projection carries no token", () => {
  const projection = projectProtectedPicker({
    attemptId: ATTEMPT_ID,
    flow: "instagram_page_linked",
    intent: "connect_new",
    socialProfileId: null,
    expired: false,
    status: null,
    committedSelectionKeys: [],
    pickerDeadline: null,
    expiresAt: null,
    candidates: [
      {
        selectionKey: "instagram_page_linked:ig:ig-1",
        igUserId: "ig-1",
        igUsername: "shop",
        igProfilePictureUrl: null,
        facebookPageId: "page-1",
        facebookPageName: "Shop",
      },
    ],
  });
  assertEquals(JSON.stringify(projection).includes(TOKEN), false);
  assertEquals(projection.candidates[0].selection_key, "instagram_page_linked:ig:ig-1");
});

// ---------------------------------------------------------------------------
// Direct identity compatibility
// ---------------------------------------------------------------------------

Deno.test("a direct candidate needs both identities", async () => {
  await assertRejects(
    async () => assertDirectIdentityEvidence({ ig_user_id: "ig-1" }),
    ProtectedOAuthError,
    "both identities",
  );
  await assertRejects(
    async () => assertDirectIdentityEvidence({ ig_igid: "igid-1" }),
    ProtectedOAuthError,
    "both identities",
  );
  const evidence = assertDirectIdentityEvidence({ ig_user_id: "ig-1", ig_igid: "igid-1" });
  assertEquals(evidence.canonicalId, "ig-1");
  assertEquals(evidence.igid, "igid-1");
});

Deno.test("the readiness inspection separates a present alias, a missing alias and a missing row", async () => {
  // Named fixture correction: readCandidates returns a discriminated read,
  // not a raw array or null. A raw array used to hide a failed read.
  const unverified = await inspectDirectCandidateReadiness(
    {
      async readCandidates() {
        return { status: "present", candidates: [{ ig_user_id: "ig-1", ig_username: "shop" }] };
      },
    },
    {
      userId: USER_ID,
      pendingSelectionId: PENDING_ID,
      attemptId: ATTEMPT_ID,
      selectionKey: "instagram_direct:ig:ig-1",
    },
  );
  assertEquals(unverified.state, "unverified");

  const verified = await inspectDirectCandidateReadiness(
    {
      async readCandidates() {
        return { status: "present", candidates: [{ ig_user_id: "ig-1", ig_igid: "igid-1" }] };
      },
    },
    {
      userId: USER_ID,
      pendingSelectionId: PENDING_ID,
      attemptId: ATTEMPT_ID,
      selectionKey: "instagram_direct:ig:ig-1",
    },
  );
  assertEquals(verified.state, "verified");

  const absent = await inspectDirectCandidateReadiness(
    {
      async readCandidates() {
        return { status: "missing" };
      },
    },
    {
      userId: USER_ID,
      pendingSelectionId: PENDING_ID,
      attemptId: ATTEMPT_ID,
      selectionKey: "instagram_direct:ig:ig-1",
    },
  );
  assertEquals(absent.state, "absent");
});

Deno.test("a failed readiness read is not reported as absence", async () => {
  await assertRejects(
    () => inspectDirectCandidateReadiness(
      {
        async readCandidates() {
          return { status: "failed", reason: "driver" };
        },
      },
      {
        userId: USER_ID,
        pendingSelectionId: PENDING_ID,
        attemptId: ATTEMPT_ID,
        selectionKey: "instagram_direct:ig:ig-1",
      },
    ),
    ProtectedOAuthError,
    "could not be read",
  );
});

// ---------------------------------------------------------------------------
// Truthful close
// ---------------------------------------------------------------------------

Deno.test("closing an unexpired protected picker retains it until expiry", () => {
  const outcome = protectedCloseOutcome({
    kind: "protected",
    attemptId: ATTEMPT_ID,
    expired: false,
    expiresAt: "2026-10-28T10:15:00+00:00",
  });
  assertEquals(outcome.removed, false);
  assertEquals(outcome.retained_until_expiry, true);
  assertEquals(outcome.expired, false);
  assertEquals(outcome.expires_at, "2026-10-28T10:15:00+00:00");
});

// ---------------------------------------------------------------------------
// Post-commit subscription
// ---------------------------------------------------------------------------

function receipt(overrides: Partial<MetaOAuthReceipt> = {}): MetaOAuthReceipt {
  return {
    attemptId: ATTEMPT_ID,
    selectionKey: "facebook_page:page:page-1",
    flow: "facebook_page",
    intent: "connect_new",
    platform: "facebook",
    platformUserId: "page-1",
    instagramUserId: null,
    facebookPageId: "page-1",
    facebookUserId: "fb-1",
    socialAccountId: "acct-1",
    companionSocialAccountId: null,
    username: "Shop",
    operation: "created",
    loginKind: null,
    credentialId: "cred-1",
    credentialRevision: 1,
    connectionVersion: 1,
    capabilityGeneration: 2,
    committedAt: "2026-10-28T10:05:00+00:00",
    ...overrides,
  };
}

Deno.test("the subscription is asserted after the commit", async () => {
  const calls: string[] = [];
  const outcome = await assertWebhookSubscription({
    receipt: receipt(),
    userId: USER_ID,
    tokens: {
      async readOperationalToken(input) {
        calls.push(`${input.platform}:${input.platformUserId}`);
        return TOKEN;
      },
    },
    subscription: {
      async subscribe() {
        calls.push("subscribe");
      },
    },
  });
  assertEquals(outcome.status, "asserted");
  assertEquals(outcome.policy, "reassert_after_valid_receipt");
  assertEquals("reasserted" in outcome, false);
  assertEquals(calls, ["facebook:page-1", "subscribe"]);
});

Deno.test("a failed subscription is a sanitized warning and not a rollback", async () => {
  const outcome = await assertWebhookSubscription({
    receipt: receipt(),
    userId: USER_ID,
    tokens: {
      async readOperationalToken() {
        return null;
      },
    },
    subscription: {
      async subscribe() {
        throw new Error("provider said no");
      },
    },
  });
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.policy, "reassert_after_valid_receipt");
  assertEquals(outcome.warning?.includes("provider said no"), false);
  assertEquals(outcome.warning?.includes(TOKEN), false);
});

Deno.test("every valid receipt reasserts the subscription, including a second one", async () => {
  // Named contract correction: a receipt is not a freshness bit. The same
  // valid receipt reasserts again. That is not an exactly-once claim.
  const calls: string[] = [];
  const input = {
    receipt: receipt(),
    userId: USER_ID,
    tokens: {
      async readOperationalToken() {
        return TOKEN;
      },
    },
    subscription: {
      async subscribe() {
        calls.push("subscribe");
      },
    },
  };
  const first = await assertWebhookSubscription(input);
  const second = await assertWebhookSubscription(input);
  assertEquals(first.status, "asserted");
  assertEquals(second.status, "asserted");
  assertEquals(first.policy, "reassert_after_valid_receipt");
  assertEquals(calls, ["subscribe", "subscribe"]);
});

Deno.test("the page-linked flow never subscribes", async () => {
  const outcome = await assertWebhookSubscription({
    receipt: receipt({ flow: "instagram_page_linked", platform: "instagram" }),
    userId: USER_ID,
    tokens: {
      async readOperationalToken() {
        throw new Error("must not be read");
      },
    },
    subscription: {
      async subscribe() {
        throw new Error("must not be called");
      },
    },
  });
  assertEquals(outcome.status, "skipped");
  assertEquals(outcome.policy, "reassert_after_valid_receipt");
});
