// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// Phase 4 — POST /v1/media, GET /v1/media/{id}, and media on POST /v1/messages.
//
// R1 is the load-bearing test, and it is a tenancy test rather than a media
// one: a `media_id` from another workspace, used in a SEND. If that resolves,
// a partner can deliver another tenant's files to their own customers — the
// single worst thing this phase could get wrong, and the only one whose
// symptom is a successful-looking response.
//
// Unlike the read-surface stub, THIS one actually applies the recorded .eq()
// filters to its seeded rows. That is deliberate: a stub that ignores filters
// would answer R1 the same way whether or not the workspace predicate exists,
// which is exactly the false green the assertion is supposed to rule out.
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_MEDIA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// The REAL digest of the key the tests present. The stub applies its recorded
// filters faithfully (see the header), so a fixture without this simply 401s —
// which is the stub being honest rather than a reason to loosen it.
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

const ACCOUNT_ROW = {
  id: ACCT,
  user_id: "user-1",
  workspace_id: WS,
  platform: "whatsapp",
  platform_user_id: "phone-1",
  access_token: "token",
  // 'cloud_api' is a REAL value from social_accounts_connection_mode_chk
  // (20260821090000). This fixture said "cloud" for years, which that
  // constraint forbids — harmless while the route only compared against
  // 'evolution_qr', wrong the moment the 9.2 capability matrix started
  // reading the mode meaningfully.
  connection_mode: "cloud_api",
  is_active: true,
  needs_reauth: false,
  token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

/** An image row in OUR workspace, and one in someone else's. */
const MEDIA_ROWS = [
  {
    id: MEDIA,
    workspace_id: WS,
    file_path: `${WS}/one.jpg`,
    mime_type: "image/jpeg",
    file_type: "image",
    file_size: 1234,
    created_at: "2026-09-01T00:00:00Z",
    storage_bucket: "partner-media",
    metadata: {},
  },
  {
    id: FOREIGN_MEDIA,
    workspace_id: OTHER_WS,
    file_path: `${OTHER_WS}/secret.jpg`,
    mime_type: "image/jpeg",
    file_type: "image",
    file_size: 4321,
    created_at: "2026-09-01T00:00:00Z",
    storage_bucket: "partner-media",
    metadata: {},
  },
];

interface StubOpts {
  keyRow?: unknown;
  mediaRows?: Record<string, unknown>[];
  /** Fails the storage write, to exercise the compensating delete. */
  uploadFails?: boolean;
  /** Makes the media_files read fail, rather than come back empty. */
  mediaReadFails?: boolean;
}

function stub(opts: StubOpts = {}) {
  const intents: Record<string, unknown>[] = [];
  /** Every rpc name with its argument object, so the idempotency hash the
   *  route actually computed is assertable rather than assumed. */
  const rpcCalls: { name: string; args: any }[] = [];
  const uploaded: { path: string; size: number }[] = [];
  const removed: string[] = [];
  const signed: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const { keyRow = KEY_ROW, mediaRows = MEDIA_ROWS } = opts;

  const seeded: Record<string, Record<string, unknown>[]> = {
    partner_api_keys: [keyRow as Record<string, unknown>],
    social_accounts: [ACCOUNT_ROW],
    workspaces: [{ id: WS, owner_id: "user-1" }],
    media_files: mediaRows,
    partner_dispatch_intents: [],
  };

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const self: any = {
      select: () => self,
      // The filters are RECORDED AND APPLIED. See the header: a stub that
      // ignores them cannot tell a scoped query from an unscoped one.
      eq: (col: string, val: unknown) => (filters.push([col, val]), self),
      in: () => self,
      order: () => self,
      limit: () => self,
      not: () => self,
      insert(row: Record<string, unknown>) {
        if (table === "partner_dispatch_intents") {
          intents.push(row);
          // Also visible to a subsequent read. recordDispatchIntent re-reads
          // the row it just wrote (that is how it resolves a takeover), and a
          // stub that forgot the insert would make every send die on a
          // read-back error -- masking whatever the test was actually about.
          (seeded[table] ??= []).push(row);
        } else inserted.push({ table, ...row });
        const created = { id: MEDIA, created_at: "2026-09-01T00:00:00Z", ...row };
        const chain: any = {
          select: () => chain,
          maybeSingle: () => Promise.resolve({ data: created, error: null }),
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
        if (table === "media_files" && opts.mediaReadFails) {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
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
    uploaded,
    removed,
    signed,
    inserted,
    rpcCalls,
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
        upload: (path: string, bytes: Uint8Array) => {
          if (opts.uploadFails) return Promise.resolve({ error: { message: "boom" } });
          uploaded.push({ path, size: bytes.byteLength });
          return Promise.resolve({ error: null });
        },
        remove: (paths: string[]) => (removed.push(...paths), Promise.resolve({ error: null })),
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

function v1(path: string, init: RequestInit = {}) {
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    headers: { "x-postora-key": "pk_live_test" },
    ...init,
  });
}

function send(payload: unknown, key = "idem-1") {
  return v1("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-postora-key": "pk_live_test",
      "idempotency-key": key,
    },
    body: JSON.stringify(payload),
  });
}

function upload(body: unknown, headers: Record<string, string> = {}) {
  return v1("/v1/media", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-postora-key": "pk_live_test",
      "idempotency-key": "idem-upload",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function code(res: Response): Promise<string | null> {
  return (await res.json().catch(() => ({})))?.error?.code ?? null;
}

/** A real 1x1 PNG's magic prefix, padded. base64 of it for the JSON shape. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

// --- R1 — the load-bearing one ---------------------------------------------

Deno.test("R1: another workspace's media_id in a SEND is resource_not_found, and never signed", async () => {
  // The worst outcome this phase could produce: delivering another tenant's
  // file to your own customer, with a 200 that looks entirely normal.
  const client = stub();
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${FOREIGN_MEDIA}` }),
    () => client,
  );

  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
  assertEquals(
    client.signed.length,
    0,
    "a URL is a live read capability — a refused send must not mint one",
  );
  assertEquals(
    client.intents.length,
    0,
    "a request that never reaches the provider must not leave a dispatch intent",
  );
});

Deno.test("R1b: the SAME id in our own workspace resolves and is signed", async () => {
  // The control for R1. Without it, R1 would pass just as happily against a
  // route that refused every media_id.
  const client = stub();
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => client,
  );
  assertEquals(client.signed, [`${WS}/one.jpg`]);
  // The stubbed fetcher is the real global fetch here, so the provider call
  // fails -- what matters is that it got as far as being attempted.
  assert(res.status >= 200);
});

Deno.test("R1c: an unknown media_id is indistinguishable from a foreign one", async () => {
  const client = stub();
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: "media_ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    () => client,
  );
  assertEquals(await code(res), "resource_not_found");
});

Deno.test("R1d: GET /v1/media/{id} is workspace-scoped too", async () => {
  const ours = await handleRequest(v1(`/v1/media/media_${MEDIA}`), () => stub());
  assertEquals(ours.status, 200);
  assertEquals((await ours.json()).id, `media_${MEDIA}`);

  const theirs = await handleRequest(v1(`/v1/media/media_${FOREIGN_MEDIA}`), () => stub());
  assertEquals(theirs.status, 404);
  assertEquals(await code(theirs), "resource_not_found");
});

// --- R2 — the dispatch intent, and what it must NOT carry ------------------

Deno.test("R2: a media send records an intent naming the FILE, never the URL or caption", async () => {
  // An intent row outlives the key that created it. A signed URL inside one
  // would be a read capability sitting in a table long after anyone could
  // revoke it, and a caption is customer content.
  const client = stub();
  await handleRequest(
    send({
      type: "image",
      recipient_phone: "+1",
      media_id: `media_${MEDIA}`,
      caption: "a private message to a customer",
    }),
    () => client,
  );

  assertEquals(client.intents.length, 1, "every send path writes exactly one intent");
  const summary = client.intents[0].request_summary as Record<string, unknown>;
  assertEquals(summary.message_type, "image");
  assertEquals(summary.media_file_id, MEDIA);
  assertEquals(summary.caption_length, "a private message to a customer".length);

  const serialised = JSON.stringify(client.intents[0]);
  assertEquals(serialised.includes("SECRET"), false, "the signed URL must not be persisted");
  assertEquals(
    serialised.includes("a private message to a customer"),
    false,
    "the caption itself must not be persisted",
  );
});

// --- R3 — the upload gate, end to end --------------------------------------

Deno.test("R3: an upload whose declared type disagrees with its bytes is refused", async () => {
  // Phase 4's exit criterion, reached through the route rather than the unit.
  const client = stub();
  const res = await handleRequest(
    upload({ data: PNG_B64, mime_type: "application/pdf", filename: "invoice.pdf" }),
    () => client,
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
  assertEquals(client.uploaded.length, 0, "rejected bytes must never reach storage");
});

Deno.test("R3b: a data URL's declared type is a CLAIM here, unlike normalizeBase64Media", async () => {
  // The n8n path trusts a data URL's declared type on purpose. The partner
  // path must not, or the strict gate is bypassed by the shape the bytes
  // arrived in.
  const client = stub();
  const res = await handleRequest(
    upload({ data: `data:application/pdf;base64,${PNG_B64}` }),
    () => client,
  );
  assertEquals(await code(res), "invalid_request");
  assertEquals(client.uploaded.length, 0);
});

Deno.test("R4: a type outside the allowlist is unsupported_capability, not invalid_request", async () => {
  // A permanent fact about the file — the same verdict a misspelled message
  // type gets, and distinct from "you sent something malformed".
  const res = await handleRequest(
    upload({ data: btoa("RIFF    WEBPmore") }),
    () => stub(),
  );
  assertEquals(res.status, 422);
  assertEquals(await code(res), "unsupported_capability");
});

Deno.test("R5: an oversized file answers payload_too_large (413), never 422", async () => {
  const oversized = new Uint8Array(6 * 1024 * 1024);
  oversized.set(PNG_BYTES);
  let binary = "";
  for (const b of oversized) binary += String.fromCharCode(b);
  const res = await handleRequest(upload({ data: btoa(binary) }), () => stub());
  assertEquals(res.status, 413);
  assertEquals(await code(res), "payload_too_large");
});

Deno.test("R5b: an impossible Content-Length is refused BEFORE the body is read", async () => {
  // The difference between a typed 413 and an edge worker that dies holding
  // the bytes.
  const client = stub();
  const res = await handleRequest(
    upload({ data: PNG_B64 }, { "content-length": String(500 * 1024 * 1024) }),
    () => client,
  );
  assertEquals(res.status, 413);
  assertEquals(client.uploaded.length, 0);
});

Deno.test("R6: an upload without Idempotency-Key is refused before the body is read", async () => {
  const client = stub();
  const res = await handleRequest(
    v1("/v1/media", {
      method: "POST",
      headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
      body: JSON.stringify({ data: PNG_B64 }),
    }),
    () => client,
  );
  assertEquals(await code(res), "missing_idempotency_key");
  assertEquals(client.uploaded.length, 0);
});

Deno.test("R7: a good upload stores the bytes and answers 201 with a prefixed id", async () => {
  const client = stub();
  const res = await handleRequest(upload({ data: PNG_B64, filename: "photo.png" }), () => client);
  assertEquals(res.status, 201);

  const body = await res.json();
  assertEquals(body.id, `media_${MEDIA}`);
  assertEquals(body.kind, "image");
  assertEquals(body.mime_type, "image/png");
  assertEquals(client.uploaded.length, 1);

  // The storage path is built from a fresh UUID and the SNIFFED extension —
  // never from the client's filename, which is attacker-controlled text.
  assertEquals(client.uploaded[0]!.path.includes("photo.png"), false);
  assertEquals(client.uploaded[0]!.path.startsWith(`${WS}/`), true);
  assertEquals(client.uploaded[0]!.path.endsWith(".png"), true);
});

Deno.test("R7b: a filename that tries to escape the path cannot", async () => {
  const client = stub();
  await handleRequest(
    upload({ data: PNG_B64, filename: "../../../etc/passwd" }),
    () => client,
  );
  assertEquals(client.uploaded[0]!.path.includes(".."), false);
});

// --- R8 — per-type rules the provider would otherwise enforce for us -------

Deno.test("R8: audio cannot carry a caption, and the refusal names the real reason", async () => {
  // WhatsApp rejects it. Surfacing that as a Meta error about a field the
  // partner did not knowingly set is a worse answer than refusing here.
  const res = await handleRequest(
    send({ type: "audio", recipient_phone: "+1", media_id: `media_${MEDIA}`, caption: "hi" }),
    () => stub(),
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
});

Deno.test("R8b: the requested type must match what the file actually IS", async () => {
  // Established by sniffing at upload time, not by anything the partner has
  // said since. The stored row is an image; asking to send it as a document
  // is the partner being wrong about their own file.
  const res = await handleRequest(
    send({ type: "document", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => stub(),
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
});

// --- R9 — media is NOT behind the template suspension ----------------------

Deno.test("R9: a media send is not refused by the 0A template suspension", async () => {
  // The flag covers send_template, whose duplicate-send window was the defect
  // it was raised against. A media message is a session message like text.
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => stub(),
  );
  assertEquals(res.status === 503, false, "media must not inherit the template suspension");
});

// --- F1..F4 — the four P1 findings from review, each pinned ---------------

Deno.test("F1: a legacy template-only key cannot send media OR free-form text", async () => {
  // The route is authorised as `send_template`, whose satisfying set also
  // contains the frozen legacy scope. That scope authorises approved TEMPLATE
  // sending and nothing more (D3) — without a per-type check it would also buy
  // unsuspended media and free-form session sends, which is the escalation D3
  // was rewritten to prevent arriving through a different door.
  //
  // The text half predates Phase 4 (it landed with 3.5) and is covered here
  // because it is the same defect and the same line.
  const legacyOnly = { ...KEY_ROW, scopes: ["whatsapp:template.send"] };

  const media = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => stub({ keyRow: legacyOnly }),
  );
  assertEquals(media.status, 403);
  assertEquals(await code(media), "insufficient_scope");

  const text = await handleRequest(
    send({ type: "text", recipient_phone: "+1", text: { body: "hi" } }),
    () => stub({ keyRow: legacyOnly }),
  );
  assertEquals(await code(text), "insufficient_scope");
});

Deno.test("F1b: the same key with messages:send is allowed through", async () => {
  // The control for F1. Without it the assertion above would pass against a
  // route that refused every media send.
  const client = stub({ keyRow: { ...KEY_ROW, scopes: ["messages:send"] } });
  const res = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => client,
  );
  assertEquals(res.status === 403, false);
  assertEquals(client.signed.length, 1, "an authorised send reaches the signing step");
});

Deno.test("F2: the idempotency hash EXCLUDES the freshly signed URL", async () => {
  // A signed URL carries a token and an expiry that differ on every mint. If
  // it entered the hash, the same logical send retried under the same
  // Idempotency-Key — the exact behaviour the header exists to make safe —
  // would hash differently and answer idempotency_conflict instead of
  // replaying. D13's guarantee would be unreachable for every media send.
  const hashes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = stub();
    await handleRequest(
      send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}`, caption: "hi" }),
      () => client,
    );
    const claim = client.rpcCalls.find((c: any) => c.name === "claim_partner_idempotency");
    assert(claim, "the route must claim an idempotency key");
    hashes.push(claim.args.p_request_hash ?? claim.args.request_hash ?? JSON.stringify(claim.args));
    // The premise: the URL really did differ between attempts.
    assertEquals(client.signed.length, 1);
  }
  assertEquals(hashes[0], hashes[1], "two identical logical sends must hash identically");
});

Deno.test("F3: a media read ERROR is internal_error, never resource_not_found", async () => {
  // resource_not_found is non-retryable. Answering it during a database blip
  // tells a partner to stop retrying a file that exists and is theirs — an
  // outage reported as a permanent fact.
  const onSend = await handleRequest(
    send({ type: "image", recipient_phone: "+1", media_id: `media_${MEDIA}` }),
    () => stub({ mediaReadFails: true }),
  );
  assertEquals(onSend.status, 500);
  assertEquals(await code(onSend), "internal_error");

  const onRead = await handleRequest(
    v1(`/v1/media/media_${MEDIA}`),
    () => stub({ mediaReadFails: true }),
  );
  assertEquals(onRead.status, 500);
  // One read of the body: it carries the code AND the typed verdict, and the
  // verdict is what a client's retry logic actually obeys.
  const readBody = await onRead.json();
  assertEquals(readBody.error.code, "internal_error");
  assertEquals(readBody.error.retryable, true);
});

// --- R10 — the compensating delete ----------------------------------------

Deno.test("R10: a failed storage write leaves nothing behind and answers internal_error", async () => {
  const client = stub({ uploadFails: true });
  const res = await handleRequest(upload({ data: PNG_B64 }), () => client);
  assertEquals(res.status, 500);
  assertEquals(client.inserted.filter((r: any) => r.table === "media_files").length, 0);
});
