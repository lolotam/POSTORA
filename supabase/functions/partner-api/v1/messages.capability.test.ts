// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// Phase 9 — 9.2 (the capability matrix decided AT THE DOOR) and 9.3 (the
// scan-state substrate) exercised through POST /v1/messages.
//
// THE LOAD-BEARING ASSERTIONS HERE ARE THE ZEROES. C1 is the whole point of
// 9.2: a media send to a QR-mode account used to, IN ORDER, load the media
// row, MINT A SIGNED STORAGE URL (a live read capability), claim an
// idempotency key, and record a dispatch intent — and only THEN did
// sendMedia throw `unsupported_direct_qr`. A request that was always going
// to be refused had already produced a URL and consumed a key. The route now
// consults the matrix before any of those side effects, so the stub below
// records every one of them and the test asserts each counter is ZERO.
//
// Written to fail against the pre-9.2 order: run it on the branch before the
// matrix lands and C1/C1b/C3/C4 go red on exactly those counters.
//
// The stub is the media.test.ts one: it APPLIES the recorded .eq() filters
// to its seeded rows, because a stub that ignored them could not tell a
// workspace-scoped query from an unscoped one, and C3/C4's rows must only be
// reachable through the scoped lookup. It also records every rpc call by
// name, so the idempotency CLAIM is assertable rather than assumed.
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PENDING = "11111111-1111-4111-8111-111111111111";
const REJECTED = "22222222-2222-4222-8222-222222222222";

// The REAL digest of the key the tests present — the stub applies filters
// faithfully, so a fixture without this 401s.
const KEY_HASH = await hashPartnerKey("pk_live_test");

const KEY_ROW = {
  id: "key-1",
  key_hash: KEY_HASH,
  workspace_id: WS,
  social_account_id: ACCT,
  key_prefix: "pk_live_abcd",
  scopes: ["media:write", "media:read", "messages:send"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

/** connection_mode 'cloud_api' — a REAL value from the column's CHECK
 *  vocabulary (20260821090000). The older fixtures elsewhere say "cloud",
 *  which that constraint forbids; these tests use the real word because the
 *  matrix reads the mode meaningfully. */
const ACCOUNT_CLOUD = {
  id: ACCT,
  user_id: "user-1",
  workspace_id: WS,
  platform: "whatsapp",
  platform_user_id: "phone-1",
  access_token: "token",
  connection_mode: "cloud_api",
  is_active: true,
  needs_reauth: false,
  token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

/** The refused cell: Direct QR mode, which has no Cloud API phone number id
 *  and can carry none of the six message types. */
const ACCOUNT_QR = { ...ACCOUNT_CLOUD, connection_mode: "evolution_qr" };

function mediaRow(id: string, scanState?: string) {
  return {
    id,
    workspace_id: WS,
    file_path: `${WS}/${id}.jpg`,
    mime_type: "image/jpeg",
    file_type: "image",
    file_size: 1234,
    created_at: "2026-09-01T00:00:00Z",
    storage_bucket: "partner-media",
    metadata: {},
    // Deliberately OMITTED when undefined: a row from before the column
    // existed (and every test stub that predates 9.3) must behave as
    // 'available', which is what NOT NULL DEFAULT 'available' means.
    ...(scanState === undefined ? {} : { scan_state: scanState }),
  };
}

/** Seeded rows: one with no scan_state at all, one pending, one rejected. */
const MEDIA_ROWS = [
  mediaRow(MEDIA),
  mediaRow(PENDING, "pending"),
  mediaRow(REJECTED, "rejected"),
];

interface StubOpts {
  account?: Record<string, unknown>;
  mediaRows?: Record<string, unknown>[];
}

function stub(opts: StubOpts = {}) {
  const intents: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: any }[] = [];
  const signed: string[] = [];
  const { account = ACCOUNT_CLOUD, mediaRows = MEDIA_ROWS } = opts;

  const seeded: Record<string, Record<string, unknown>[]> = {
    partner_api_keys: [KEY_ROW as Record<string, unknown>],
    social_accounts: [account],
    workspaces: [{ id: WS, owner_id: "user-1" }],
    media_files: mediaRows,
    partner_dispatch_intents: [],
  };

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const self: any = {
      select: () => self,
      eq: (col: string, val: unknown) => (filters.push([col, val]), self),
      in: () => self,
      order: () => self,
      limit: () => self,
      not: () => self,
      insert(row: Record<string, unknown>) {
        if (table === "partner_dispatch_intents") {
          intents.push(row);
          (seeded[table] ??= []).push(row);
        }
        const chain: any = {
          select: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
      update: () => ({
        eq: () => ({
          eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
          select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      }),
      maybeSingle() {
        const rows = (seeded[table] ?? []).filter((row) =>
          filters.every(([col, val]) => row[col] === val)
        );
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        const rows = (seeded[table] ?? []).filter((row) =>
          filters.every(([col, val]) => row[col] === val)
        );
        return resolve({ data: rows, error: null });
      },
    };
    return self;
  }

  return {
    intents,
    signed,
    rpcCalls,
    get claims(): number {
      return this.rpcCalls.filter((c: any) => c.name === "claim_partner_idempotency").length;
    },
    rpc(name: string, args?: unknown) {
      rpcCalls.push({ name, args });
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve({
          data: { allowed: true, remaining: 59, reset_seconds: 42 },
          error: null,
        });
      }
      if (name === "claim_partner_idempotency") {
        return Promise.resolve({
          data: { outcome: "claimed", attempt_token: "tok-1" },
          error: null,
        });
      }
      if (name === "reserve_partner_quota") {
        return Promise.resolve({ data: { allowed: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: builder,
    storage: {
      from: (_bucket: string) => ({
        upload: () => Promise.resolve({ error: null }),
        remove: () => Promise.resolve({ error: null }),
        createSignedUrl: (path: string) => {
          signed.push(path);
          return Promise.resolve({
            data: { signedUrl: `https://storage.example/${path}?token=SECRET` },
            error: null,
          });
        },
      }),
    },
  } as any;
}

function send(payload: unknown, key = "idem-1") {
  return new Request("https://partner.example/functions/v1/partner-api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-postora-key": "pk_live_test",
      "idempotency-key": key,
    },
    body: JSON.stringify(payload),
  });
}

async function bodyOf(res: Response): Promise<any> {
  return await res.json().catch(() => ({}));
}

// --- C1 — THE 9.2 test: a refused cell produces ZERO side effects ----------

Deno.test("C1: a media send to a QR account is refused at the door, with zero signed URLs, zero claims, zero intents", async () => {
  const client = stub({ account: ACCOUNT_QR });
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => client,
  );

  assertEquals(res.status, 400);
  const body = await bodyOf(res);
  assertEquals(body.error.code, "unsupported_direct_qr");
  // The refusal names the cell it refused, so a partner can tell WHICH fact
  // about the request was the problem.
  assertEquals(body.error.details.connection_mode, "evolution_qr");
  assertEquals(body.error.details.type, "image");

  // The whole point of 9.2. Each of these is a side effect the pre-9.2 order
  // produced BEFORE the deep sendMedia guard threw.
  assertEquals(client.signed.length, 0, "a refused send must not mint a signed URL");
  assertEquals(client.claims, 0, "a refused send must not consume an idempotency key");
  assertEquals(client.intents.length, 0, "a refused send must not record a dispatch intent");
});

Deno.test("C1b: a TEXT send to a QR account is refused at the door too, with zero claims and zero intents", async () => {
  const client = stub({ account: ACCOUNT_QR });
  const res = await handleRequest(
    send({ type: "text", recipient_phone: "+1", text: { body: "hello" } }),
    () => client,
  );

  assertEquals(res.status, 400);
  assertEquals((await bodyOf(res)).error.code, "unsupported_direct_qr");
  assertEquals(client.claims, 0);
  assertEquals(client.intents.length, 0);
});

Deno.test("C1d: a TEMPLATE send to a QR account is unsupported_direct_qr, NOT temporarily_unavailable (Codex review, PR #127)", async () => {
  // SEND_TEMPLATE_SUSPENDED is on, so before the matrix moved above the
  // suspension check this answered 503/temporarily_unavailable -- telling a
  // partner to wait for a combination that can never work. Permanent facts
  // precede temporary ones, same as the type check.
  const client = stub({ account: ACCOUNT_QR });
  const res = await handleRequest(
    send({ type: "template", recipient_phone: "+1", template: { name: "hello", language: "en" } }),
    () => client,
  );

  assertEquals(res.status, 400);
  assertEquals((await bodyOf(res)).error.code, "unsupported_direct_qr");
  assertEquals(client.claims, 0);
  assertEquals(client.intents.length, 0);
});

Deno.test("C1c: the CONTROL — the same media send to a cloud_api account reaches every side effect", async () => {
  // Without this, C1 would pass just as happily against a route that refuses
  // every media send. The provider call itself fails (bogus token, real
  // fetch — the media.test.ts R2 precedent); what matters is that the door
  // let it THROUGH to signing, claiming and dispatch.
  const client = stub({ account: ACCOUNT_CLOUD });
  await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => client,
  );
  assertEquals(client.signed.length, 1);
  assertEquals(client.claims, 1);
  assertEquals(client.intents.length, 1);
});

// --- C3..C5 — the 9.3 scan-state substrate ---------------------------------

Deno.test("C3: a media id in scan_state pending answers media_pending and produces nothing", async () => {
  const client = stub();
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${PENDING}` }),
    () => client,
  );

  assertEquals(res.status, 409);
  const body = await bodyOf(res);
  assertEquals(body.error.code, "media_pending");
  // Pending is the one state expected to change on its own — the correct
  // partner move is to retry the SAME request shortly.
  assertEquals(body.error.retryable, true);

  assertEquals(client.signed.length, 0, "a pending file must not produce a URL");
  assertEquals(client.claims, 0);
  assertEquals(client.intents.length, 0);
});

Deno.test("C4: a media id in scan_state rejected answers media_rejected and produces nothing", async () => {
  const client = stub();
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${REJECTED}` }),
    () => client,
  );

  assertEquals(res.status, 422);
  const body = await bodyOf(res);
  assertEquals(body.error.code, "media_rejected");
  // Rejected is a permanent fact about these bytes. Retrying the same
  // media_id can never succeed.
  assertEquals(body.error.retryable, false);

  assertEquals(client.signed.length, 0, "a rejected file must not produce a URL");
  assertEquals(client.claims, 0);
  assertEquals(client.intents.length, 0);
});

Deno.test("C5: the CONTROL — a row with no scan_state at all (available by default) still sends", async () => {
  // D10's one-state collapse must survive 9.3: the default is 'available'
  // PRECISELY so existing rows and the app's own uploader are untouched.
  // This row carries no scan_state field at all — a projection from before
  // the column existed — and must dispatch exactly as it did before.
  const client = stub();
  await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => client,
  );
  assertEquals(client.signed.length, 1);
  assertEquals(client.claims, 1);
  assertEquals(client.intents.length, 1);
  assert(true);
});
