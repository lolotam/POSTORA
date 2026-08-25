// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  EvolutionFetcher,
  MediaFetchError,
  type InboundMediaFetcher,
  type MediaRef,
} from "./inboundMediaFetchers.ts";
import {
  inboundCachePath,
  isUnusableProviderId,
  MEDIA_UNAVAILABLE,
  ownedStoragePath,
  resolveWhatsAppMedia,
} from "./whatsappMediaResolver.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

const OWNER = "owner-1";
const ACCOUNT = "acc-1";

function access(overrides: Partial<WhatsAppAccountAccess> = {}): WhatsAppAccountAccess {
  return {
    accountId: ACCOUNT,
    ownerId: OWNER,
    workspaceId: "ws-1",
    role: "viewer",
    platformUserId: "1555",
    platformUsername: "Shop",
    accessToken: "tok",
    connectionMode: "evolution_qr",
    accountMetadata: {},
    ...overrides,
  };
}

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    message_id: "BAILEYS-1",
    media_url: null,
    media_type: "image",
    media_metadata: { mime_type: "image/jpeg" },
    social_account_id: ACCOUNT,
    ...overrides,
  };
}

function fakeAdmin(opts: {
  rows?: Record<string, unknown>[];
  cached?: string[];
  failUpload?: boolean;
  failUpdate?: boolean;
} = {}) {
  const uploaded = new Set<string>(opts.cached ?? []);
  const signed: string[] = [];
  const updates: unknown[] = [];
  const tables: string[] = [];

  class Query {
    private table: string;
    private filters: Array<[string, unknown]> = [];
    private inIds: unknown[] | null = null;
    private patch: unknown = null;

    constructor(table: string) {
      this.table = table;
    }

    select(_columns: string) {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }

    in(column: string, values: unknown[]) {
      this.inIds = values;
      this.filters.push([column, values]);
      return this;
    }

    update(patch: unknown) {
      this.patch = patch;
      return this;
    }

    maybeSingle() {
      return this.execute().then(({ data }) => ({
        data: Array.isArray(data) ? data[0] ?? null : data,
        error: null,
      }));
    }

    then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
      return this.execute().then(resolve, reject);
    }

    private execute() {
      if (this.patch) {
        if (opts.failUpdate) return Promise.resolve({ data: null, error: { message: "update failed" } });
        updates.push(this.patch);
        return Promise.resolve({ data: null, error: null });
      }
      if (this.table === "whatsapp_messages") {
        const accountId = this.filters.find(([column]) => column === "social_account_id")?.[1];
        const ids = new Set((this.inIds ?? []).map(String));
        const rows = (opts.rows ?? []).filter((row) =>
          row.social_account_id === accountId && ids.has(String(row.id))
        );
        return Promise.resolve({ data: rows, error: null });
      }
      if (this.table === "whatsapp_evolution_instances") {
        return Promise.resolve({ data: { instance_name: "postora_acc-1" }, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }
  }

  return {
    signed,
    uploaded,
    updates,
    tables,
    from(table: string) {
      tables.push(table);
      return new Query(table);
    },
    storage: {
      from() {
        return {
          createSignedUrl: (path: string, _ttl: number) => {
            signed.push(path);
            if (!uploaded.has(path)) {
              return Promise.resolve({ data: null, error: { message: "not found" } });
            }
            return Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?s=1` }, error: null });
          },
          upload: (path: string, _bytes: Uint8Array, _opts: unknown) => {
            if (opts.failUpload) return Promise.resolve({ error: { message: "upload failed" } });
            uploaded.add(path);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

function bodyResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes.slice().buffer, { status: 200, headers });
}

const realFetchers = (): InboundMediaFetcher[] => [
  new CloudGraphFetcher(),
  new EvolutionFetcher("https://evo.example", "key", "inst"),
  new DirectUrlFetcher(),
];

Deno.test("a cached object is signed without calling any fetcher", async () => {
  const path = inboundCachePath(OWNER, "row-1", "jpg");
  const admin = fakeAdmin({ rows: [mediaRow()], cached: [path] });
  let fetched = false;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    fetchers: realFetchers(),
    httpFetch: () => {
      fetched = true;
      return Promise.resolve(bodyResponse(new Uint8Array([1])));
    },
  });
  assertEquals(fetched, false);
  assertEquals(media[0]?.url, `https://storage.test/${path}?s=1`);
  assertEquals(media[0]?.expires_in, 3600);
  assertEquals(media[0]?.kind, "image");
  assertEquals(media[0]?.error, undefined);
});

Deno.test("a miss selects EvolutionFetcher for evolution_qr", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  const urls: string[] = [];
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    fetchers: realFetchers(),
    httpFetch: (url) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ base64: btoa("img"), mimetype: "image/jpeg" }), { status: 200 }),
      );
    },
  });
  assert(urls.some((url) => url.includes("/chat/getBase64FromMediaMessage/inst")));
  assertEquals(media[0]?.url?.includes(`${OWNER}/whatsapp/inbound/row-1.jpg`), true);
  assertEquals(admin.updates[0], { media_url: inboundCachePath(OWNER, "row-1", "jpg") });
});

Deno.test("a miss selects CloudGraphFetcher for coexistence", async () => {
  const admin = fakeAdmin({
    rows: [mediaRow({
      media_url: "https://lookaside.fbsbx.com/x",
      message_id: "wamid.ABC",
    })],
  });
  const auths: string[] = [];
  const media = await resolveWhatsAppMedia(
    admin,
    access({ connectionMode: "coexistence" }),
    { messageRowIds: ["row-1"] },
    {
      fetchers: realFetchers(),
      httpFetch: (_url, init) => {
        auths.push(String((init?.headers as Record<string, string>)?.Authorization));
        return Promise.resolve(bodyResponse(new Uint8Array([9, 8, 7]), { "content-type": "image/jpeg" }));
      },
    },
  );
  assertEquals(auths, ["Bearer tok"]);
  assertEquals(media[0]?.error, undefined);
  assert(media[0]?.url);
});

Deno.test("a row on another account is refused", async () => {
  const admin = fakeAdmin({
    rows: [mediaRow({ id: "foreign", social_account_id: "other-account" })],
  });
  let fetched = false;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["foreign"] }, {
    fetchers: realFetchers(),
    httpFetch: () => {
      fetched = true;
      return Promise.resolve(bodyResponse(new Uint8Array([1])));
    },
  });
  assertEquals(fetched, false);
  assertEquals(media, [{
    message_row_id: "foreign",
    kind: "document",
    url: null,
    error: MEDIA_UNAVAILABLE,
  }]);
});

Deno.test("a fetcher failure yields MEDIA_UNAVAILABLE and never leaks the provider message", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    fetchers: [{
      name: "boom",
      canHandle: () => true,
      fetchMediaBytes: () => Promise.reject(new MediaFetchError("evolution media 500: token xyz leaked", "transport_failed")),
    }],
  });
  assertEquals(media[0]?.url, null);
  assertEquals(media[0]?.error, MEDIA_UNAVAILABLE);
  assertEquals(JSON.stringify(media).includes("leaked"), false);
  assertEquals(JSON.stringify(media).includes("evolution media"), false);
});

Deno.test("a null message_id is refused without calling the provider", async () => {
  const admin = fakeAdmin({ rows: [mediaRow({ message_id: null })] });
  let fetched = false;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    fetchers: realFetchers(),
    httpFetch: () => {
      fetched = true;
      return Promise.resolve(bodyResponse(new Uint8Array([1])));
    },
  });
  assertEquals(fetched, false);
  assertEquals(media[0]?.error, MEDIA_UNAVAILABLE);
});

Deno.test("a sched_-prefixed message_id is refused without calling the provider", async () => {
  assertEquals(isUnusableProviderId("sched_abc"), true);
  const admin = fakeAdmin({ rows: [mediaRow({ message_id: "sched_abc" })] });
  let fetched = false;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    fetchers: realFetchers(),
    httpFetch: () => {
      fetched = true;
      return Promise.resolve(bodyResponse(new Uint8Array([1])));
    },
  });
  assertEquals(fetched, false);
  assertEquals(media[0]?.error, MEDIA_UNAVAILABLE);
});

Deno.test("the aggregate budget admits only one unknown-size fetch at a time, then reconciles", async () => {
  const admin = fakeAdmin({
    rows: [mediaRow({ id: "a" }), mediaRow({ id: "b", message_id: "BAILEYS-2" })],
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["a", "b"] }, {
    perItemMaxBytes: 100,
    aggregateBudgetBytes: 150,
    maxConcurrent: 2,
    fetchers: [{
      name: "slow",
      canHandle: () => true,
      fetchMediaBytes: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { bytes: new Uint8Array(10), mimeType: "image/jpeg" };
      },
    }],
  });
  assertEquals(maxInFlight, 1);
  assertEquals(media.every((item) => item.url !== null), true);
});

Deno.test("known sizes can run two fetches in parallel under the aggregate budget", async () => {
  const admin = fakeAdmin({
    rows: [
      mediaRow({ id: "a", media_metadata: { mime_type: "image/jpeg", size: 40 } }),
      mediaRow({ id: "b", message_id: "BAILEYS-2", media_metadata: { mime_type: "image/jpeg", size: 40 } }),
    ],
  });
  let inFlight = 0;
  let maxInFlight = 0;
  await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["a", "b"] }, {
    perItemMaxBytes: 100,
    aggregateBudgetBytes: 150,
    maxConcurrent: 2,
    fetchers: [{
      name: "slow",
      canHandle: () => true,
      fetchMediaBytes: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { bytes: new Uint8Array(40), mimeType: "image/jpeg" };
      },
    }],
  });
  assertEquals(maxInFlight, 2);
});

Deno.test("the batch deadline delivers a real AbortError to an in-flight fetch", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  let sawAbort = false;
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
    deadlineMs: 30,
    fetchers: [{
      name: "hang",
      canHandle: () => true,
      fetchMediaBytes: (_ref: MediaRef, _limits, _fetcher, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }],
  });
  assertEquals(sawAbort, true);
  assertEquals(media[0]?.error, MEDIA_UNAVAILABLE);
  assertEquals(media[0]?.url, null);
});

Deno.test("ownedStoragePath accepts the caller's uid and rejects traversal, URLs, and a foreign uid", () => {
  const uid = "11111111-1111-1111-1111-111111111111";
  assertEquals(
    ownedStoragePath(`${uid}/whatsapp/outbound/file.jpg`, uid),
    `${uid}/whatsapp/outbound/file.jpg`,
  );
  assertRejectsPath("../etc/passwd", uid);
  assertRejectsPath("https://evil.test/x", uid);
  assertRejectsPath("/absolute/path", uid);
  assertRejectsPath(`other-user/whatsapp/outbound/file.jpg`, uid);
  assertRejectsPath(`${uid}/../secret`, uid);
});

function assertRejectsPath(path: string, uid: string) {
  try {
    ownedStoragePath(path, uid);
    throw new Error(`expected reject: ${path}`);
  } catch (error) {
    assertEquals((error as Error).message, "media_path is invalid");
  }
}

// Regression, 2026-08-25: the budget charged bytes on acquire and reconciled them to the real
// size, but the SUCCESS path never released them -- so every resolved row held its bytes for
// the life of the batch and later rows starved until the deadline. Each row here fits the
// per-item cap comfortably; only the missing release makes their sum exceed the aggregate.
Deno.test("a completed row hands its bytes back so a long batch does not starve", async () => {
  const rows = ["a", "b", "c", "d", "e"].map((id, index) =>
    mediaRow({ id, message_id: `BAILEYS-${index}` })
  );
  const admin = fakeAdmin({ rows });
  const media = await resolveWhatsAppMedia(admin, access(), {
    messageRowIds: rows.map((row) => row.id),
  }, {
    perItemMaxBytes: 100,
    aggregateBudgetBytes: 150,
    maxConcurrent: 1,
    deadlineMs: 3_000,
    fetchers: [{
      name: "steady",
      canHandle: () => true,
      fetchMediaBytes: async () => ({ bytes: new Uint8Array(60), mimeType: "image/jpeg" }),
    }],
  });
  assertEquals(media.length, 5);
  assertEquals(media.filter((item) => item.url !== null).length, 5);
});
