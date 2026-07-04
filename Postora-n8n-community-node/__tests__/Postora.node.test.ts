import { Postora } from "../nodes/Postora/Postora.node";

// ── Helpers ──────────────────────────────────────────────────────────────
// Build a fake IExecuteFunctions with controllable getNodeParameter /
// helpers.httpRequestWithAuthentication / helpers.assertBinaryData behavior.
type ParamMap = Record<string, any>;

function makeExecute(overrides: {
  params: ParamMap;
  credentials?: { baseUrl: string };
  binaryData?: Record<string, { fileName: string; mimeType: string; buffer: Buffer }>;
  http?: (opts: any) => any | Promise<any>;
  continueOnFail?: boolean;
}) {
  const { params, credentials = { baseUrl: "https://example.test" }, binaryData = {}, http, continueOnFail = false } = overrides;

  const callLog: any[] = [];
  const httpImpl = http || (() => ({ success: true }));

  const fake = {
    getInputData: () => [{}],
    getNodeParameter: (name: string, _i: number, fallback?: any) => {
      if (name in params) return params[name];
      return fallback;
    },
    getCredentials: async () => credentials,
    getNode: () => ({ name: "Postora" }),
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: function (this: any, _cred: string, opts: any) {
        callLog.push(opts);
        return httpImpl(opts);
      },
      assertBinaryData: (_i: number, prop: string) => {
        const b = binaryData[prop];
        if (!b) throw new Error(`no binary data on ${prop}`);
        return { fileName: b.fileName, mimeType: b.mimeType };
      },
      getBinaryDataBuffer: async (_i: number, prop: string) => binaryData[prop]?.buffer || Buffer.alloc(0),
    },
  } as any;

  return { fake, callLog };
}

async function run(overrides: Parameters<typeof makeExecute>[0]) {
  const { fake, callLog } = makeExecute(overrides);
  const node = new Postora();
  const out = await (node as any).execute.call(fake) as any[][];
  // execute returns [returnData] where returnData is INodeExecutionData[]
  const items = out[0] || [];
  return { result: items, callLog };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Postora node — Instagram/Facebook Story caption fix (regression)", () => {
  it("does not offer text-only media source for Facebook/Instagram stories", () => {
    const node = new Postora();
    const storyMediaSource = node.description.properties.find(
      (property: any) =>
        property.name === "mediaSource" &&
        property.displayOptions?.show?.platform?.includes("instagram") &&
        property.displayOptions?.show?.postType?.includes("story"),
    ) as any;

    expect(storyMediaSource).toBeDefined();
    expect(storyMediaSource.options.map((option: any) => option.value)).not.toContain("none");
  });

  it("does not throw 'Could not get parameter' when caption is hidden (IG story)", async () => {
    // caption intentionally absent from params (hidden field → getNodeParameter returns fallback)
    const { result } = await run({
      params: {
        resource: "post",
        operation: "create",
        platform: "instagram",
        socialAccounts_instagram: ["acc-1"],
        mediaSource: "url",
        mediaUrls: "https://example.com/photo.jpg",
        postType: "story",
        // caption omitted on purpose
      },
      http: () => ({ success: true, post_id: "p1" }),
    });
    expect(result[0].json.success).toBe(true);
  });

  it("throws a clear error when socialAccounts is empty (not a generic 'Could not get parameter')", async () => {
    await expect(
      run({
        params: {
          resource: "post",
          operation: "create",
          platform: "facebook",
          socialAccounts_facebook: [],
          mediaSource: "none",
        },
      }),
    ).rejects.toThrow(/Required parameter 'Social Accounts/i);
  });

  it("throws a clear error when Media File ID source receives a URL", async () => {
    await expect(
      run({
        params: {
          resource: "post",
          operation: "create",
          platform: "instagram",
          socialAccounts_instagram: ["acc-1"],
          mediaSource: "mediafileid",
          mediaFileIds: "https://res.cloudinary.com/demo/image/upload/file.png",
          postType: "story",
        },
      }),
    ).rejects.toThrow(/Invalid Media File ID.*looks like a URL/i);
  });
});

describe("Postora node — Media → Upload backward compat (legacy binaryPropertyName)", () => {
  it("uploads from legacy binaryPropertyName when uploadMediaSource is unset", async () => {
    const buf = Buffer.from("hello");
    const calls: any[] = [];
    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        binaryPropertyName: "data", // legacy field, no uploadMediaSource
      },
      binaryData: { data: { fileName: "f.jpg", mimeType: "image/jpeg", buffer: buf } },
      http: (opts: any) => {
        calls.push(opts);
        return { success: true, media_file_id: "mf-1", url: "https://cdn/f.jpg" };
      },
    });
    expect(result[0].json.total).toBe(1);
    expect(result[0].json.uploaded).toBe(1);
    expect(result[0].json.failed).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("POST");
  });
});

describe("Postora node — Upload sources", () => {
  it("binary source: uploads each binary property", async () => {
    const buf1 = Buffer.from("a");
    const buf2 = Buffer.from("b");
    const { result, callLog } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "binary",
        uploadBinaryProperty: "data,data2",
      },
      binaryData: {
        data: { fileName: "1.jpg", mimeType: "image/jpeg", buffer: buf1 },
        data2: { fileName: "2.png", mimeType: "image/png", buffer: buf2 },
      },
      http: () => ({ success: true, media_file_id: "x", url: "u" }),
    });
    expect(result[0].json.total).toBe(2);
    expect(result[0].json.uploaded).toBe(2);
    expect(callLog.every((c) => c.method === "POST")).toBe(true);
  });

  it("throws when url source has no URLs", async () => {
    await expect(
      run({
        params: {
          resource: "media",
          operation: "upload",
          uploadMediaSource: "url",
          uploadMediaUrls: "",
        },
      }),
    ).rejects.toThrow(/no URLs were provided/i);
  });

  it("throws when mediafileid source has no IDs", async () => {
    await expect(
      run({
        params: {
          resource: "media",
          operation: "upload",
          uploadMediaSource: "mediafileid",
          uploadMediaFileIds: "",
        },
      }),
    ).rejects.toThrow(/no IDs were provided/i);
  });

  it("mediafileid source: resolves valid UUIDs and reports invalid ones as per-item failures", async () => {
    const validId = "11111111-1111-4111-8111-111111111111";
    const validId2 = "22222222-2222-4222-8222-222222222222";
    const { result, callLog } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "mediafileid",
        // mix valid + invalid UUID + duplicate (case-different)
        uploadMediaFileIds: `${validId},not-a-uuid,${validId2.toUpperCase()}`,
      },
      http: (opts: any) => {
        if (opts.method === "GET" && opts.url.includes(validId)) {
          return { success: true, media: { id: validId, file_path: "p1" } };
        }
        // validId2 uppercase resolved to a media row
        return { success: true, media: { id: validId2, file_path: "p2" } };
      },
    });
    // 3 inputs: valid, invalid, dup(validId2). Dedupe → 2 unique + 1 invalid = 3 total after... wait dedupe removes dup
    // Actually: validId, not-a-uuid, VALIDID2(upper). Dedup is case-insensitive, but validId and validId2 differ.
    // So 3 distinct: validId(ok), not-a-uuid(fail), validId2(ok)
    expect(result[0].json.total).toBe(3);
    expect(result[0].json.uploaded).toBe(2);
    expect(result[0].json.failed).toBe(1);
    expect(result[0].json.results.find((r: any) => r.success === false).error).toMatch(/not a valid UUID/i);
    // GET calls only for the 2 valid UUIDs (invalid one never hit network)
    const getCalls = callLog.filter((c) => c.method === "GET");
    expect(getCalls.length).toBe(2);
  });

  it("mediafileid source: 404 becomes per-item failure, not a crash", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "mediafileid",
        uploadMediaFileIds: id,
      },
      http: () => {
        const e: any = new Error("404 Not Found");
        throw e;
      },
    });
    expect(result[0].json.failed).toBe(1);
    expect(result[0].json.results[0].error).toMatch(/not found or not owned/i);
  });
});

describe("Postora node — Media → Upload URL source SSRF protections", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function fakeResponse(opts: { status?: number; headers?: Record<string, string>; body?: string }): Response {
    const status = opts.status ?? 200;
    const headerMap = new Map(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      arrayBuffer: async () => new Uint8Array(Buffer.from(opts.body || "fake-bytes")).buffer,
    } as any;
  }

  it("regression: never contacts the redirect target when it's a private host (previously the check was dead code)", async () => {
    const requestedUrls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      requestedUrls.push(String(url));
      return fakeResponse({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as any;

    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "url",
        uploadMediaUrls: "http://example.com/redirect-me",
      },
    });

    // Only the first hop was ever requested — the private redirect target was never fetched.
    expect(requestedUrls).toEqual(["http://example.com/redirect-me"]);
    expect(result[0].json.failed).toBe(1);
    expect(result[0].json.results[0].error).toMatch(/not allowed/i);
  });

  it("regression: rejects an IPv6 loopback host, brackets and all (URL.hostname keeps the [ ])", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "url",
        uploadMediaUrls: "http://[::1]/admin",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result[0].json.failed).toBe(1);
    expect(result[0].json.results[0].error).toMatch(/not allowed/i);
  });

  it("rejects a direct private/loopback host without calling fetch at all", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "url",
        uploadMediaUrls: "http://169.254.169.254/latest/meta-data/",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result[0].json.failed).toBe(1);
    expect(result[0].json.results[0].error).toMatch(/not allowed/i);
  });

  it("allows a public 169.x host that is not in the 169.254.0.0/16 link-local range", async () => {
    global.fetch = jest.fn(async () =>
      fakeResponse({ status: 200, headers: { "content-type": "image/png" } }),
    ) as any;

    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "url",
        uploadMediaUrls: "http://169.45.12.3/photo.png",
      },
    });

    expect(result[0].json.uploaded).toBe(1);
    expect(result[0].json.failed).toBe(0);
  });

  it("downloads and uploads a normal public image URL with no redirects", async () => {
    global.fetch = jest.fn(async () =>
      fakeResponse({ status: 200, headers: { "content-type": "image/jpeg" } }),
    ) as any;

    const { result } = await run({
      params: {
        resource: "media",
        operation: "upload",
        uploadMediaSource: "url",
        uploadMediaUrls: "https://example.com/photo.jpg",
      },
      http: () => ({ success: true, media_file_id: "m1" }),
    });

    expect(result[0].json.uploaded).toBe(1);
    expect(result[0].json.failed).toBe(0);
  });
});

describe("Postora node — output shape is identical across sources", () => {
  const shape = (o: any) => ({
    total: typeof o.total,
    uploaded: typeof o.uploaded,
    failed: typeof o.failed,
    resultsIsArray: Array.isArray(o.results),
  });

  it("binary + mediafileid produce the same shape keys", async () => {
    const binary = await run({
      params: { resource: "media", operation: "upload", uploadMediaSource: "binary", uploadBinaryProperty: "data" },
      binaryData: { data: { fileName: "f", mimeType: "image/jpeg", buffer: Buffer.from("x") } },
      http: () => ({ success: true }),
    });
    const id = "44444444-4444-4444-8444-444444444444";
    const mfid = await run({
      params: { resource: "media", operation: "upload", uploadMediaSource: "mediafileid", uploadMediaFileIds: id },
      http: () => ({ success: true, media: {} }),
    });
    expect(shape(binary.result[0].json)).toEqual(shape(mfid.result[0].json));
  });
});
