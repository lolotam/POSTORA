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
  failSignAfterUpload?: boolean;
  slowSignMs?: number;
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
          createSignedUrl: async (path: string, _ttl: number) => {
            if (opts.slowSignMs) await new Promise((resolve) => setTimeout(resolve, opts.slowSignMs));
            signed.push(path);
            if (opts.failSignAfterUpload && uploaded.has(path)) {
              return { data: null, error: { message: "not found" } };
            }
            if (!uploaded.has(path)) {
              return { data: null, error: { message: "not found" } };
            }
            return { data: { signedUrl: `https://storage.test/${path}?s=1` }, error: null };
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

Deno.test("an oversized video is unavailable without uploading and other batch rows resolve", async () => {
  const admin = fakeAdmin({ rows: [
    mediaRow({ id: "video", message_id: "large", media_type: "video" }),
    mediaRow({ id: "image", message_id: "small" }),
  ] });
  const media = await resolveWhatsAppMedia(admin, access(), { messageRowIds: ["video", "image"] }, {
    fetchers: [{
      name: "size-limited",
      canHandle: () => true,
      fetchMediaBytes: async (ref) => {
        if (ref.mediaId === "large") throw new MediaFetchError("exceeds cap", "too_large");
        return { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
      },
    }],
  });
  assertEquals(media[0], { message_row_id: "video", kind: "video", url: null, error: MEDIA_UNAVAILABLE, reason: "too_large" });
  assert(media[1].url);
  assertEquals([...admin.uploaded], [inboundCachePath(OWNER, "image", "jpg")]);
});

for (const connectionMode of ["evolution_qr", "cloud_api"] as const) {
  Deno.test(`${connectionMode} applies its media ceiling before fetching known oversized rows`, async () => {
    const admin = fakeAdmin({ rows: [mediaRow({ media_metadata: { size: 11 * 1024 * 1024 } })] });
    let fetched = false;
    const media = await resolveWhatsAppMedia(admin, access({ connectionMode }), { messageRowIds: ["row-1"] }, {
      fetchers: [{
        name: "bounded",
        canHandle: () => true,
        fetchMediaBytes: async () => {
          fetched = true;
          return { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
        },
      }],
    });
    assertEquals(fetched, connectionMode === "cloud_api");
    assertEquals(media[0].reason, connectionMode === "evolution_qr" ? "too_large" : undefined);
  });
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

async function captureErrors(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
    return lines;
  } finally {
    console.error = original;
  }
}

function assertSanitised(lines: string[]) {
  const joined = lines.join("\n");
  assertEquals(/https?:\/\//.test(joined), false);
  assertEquals(joined.includes("pps.whatsapp"), false);
  assertEquals(joined.includes("BAILEYS"), false);
}

Deno.test("deadline before fetch logs deadline and a batch summary", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()], slowSignMs: 80 });
  let fetched = false;
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      deadlineMs: 30,
      fetchers: [{
        name: "should-not-run",
        canHandle: () => true,
        fetchMediaBytes: async () => {
          fetched = true;
          return { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
        },
      }],
    })
  );
  assertEquals(fetched, false);
  assert(lines.some((line) => line === "[whatsapp-media] row-1 deadline"));
  assert(lines.some((line) => line === "[whatsapp-media] batch deadline=1"));
  assertSanitised(lines);
});

Deno.test("an unusable provider id logs unusable_id", async () => {
  const admin = fakeAdmin({ rows: [mediaRow({ message_id: null })] });
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      fetchers: realFetchers(),
    })
  );
  assert(lines.some((line) => line === "[whatsapp-media] row-1 unusable_id"));
  assert(lines.some((line) => line === "[whatsapp-media] batch unusable_id=1"));
  assertSanitised(lines);
});

Deno.test("a budget that never admits logs budget", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      perItemMaxBytes: 100,
      aggregateBudgetBytes: 1,
      deadlineMs: 50,
      fetchers: [{
        name: "unused",
        canHandle: () => true,
        fetchMediaBytes: async () => ({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" }),
      }],
    })
  );
  assert(lines.some((line) => line === "[whatsapp-media] row-1 budget"));
  assert(lines.some((line) => line === "[whatsapp-media] batch budget=1"));
  assertSanitised(lines);
});

Deno.test("no matching fetcher logs no_fetcher", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      fetchers: [],
    })
  );
  assert(lines.some((line) => line === "[whatsapp-media] row-1 no_fetcher"));
  assert(lines.some((line) => line === "[whatsapp-media] batch no_fetcher=1"));
  assertSanitised(lines);
});

Deno.test("a fetcher that returns null logs fetch_null", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()] });
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      fetchers: [{
        name: "empty",
        canHandle: () => true,
        fetchMediaBytes: () => Promise.resolve(null as never),
      }],
    })
  );
  assert(lines.some((line) => line === "[whatsapp-media] row-1 fetch_null"));
  assert(lines.some((line) => line === "[whatsapp-media] batch fetch_null=1"));
  assertSanitised(lines);
});

Deno.test("a post-upload sign failure logs sign_failed", async () => {
  const admin = fakeAdmin({ rows: [mediaRow()], failSignAfterUpload: true });
  const lines = await captureErrors(() =>
    resolveWhatsAppMedia(admin, access(), { messageRowIds: ["row-1"] }, {
      fetchers: [{
        name: "bytes",
        canHandle: () => true,
        fetchMediaBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" }),
      }],
    })
  );
  assert(lines.some((line) => line === "[whatsapp-media] row-1 sign_failed"));
  assert(lines.some((line) => line === "[whatsapp-media] batch sign_failed=1"));
  assertSanitised(lines);
});
