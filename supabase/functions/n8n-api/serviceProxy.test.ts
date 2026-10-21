import { assertEquals } from "jsr:@std/assert@1";
import {
  createFunctionInvoker,
  handleGenerateCaption,
  handleGenerateHashtags,
  handleGenerateImage,
  handleGetPostAnalytics,
  handleListComments,
  handleListMessages,
  supabaseAccountLoader,
  type InvokeResult,
  type ProxyAccount,
  type ServiceProxyDeps,
  type StoredImage,
} from "./serviceProxy.ts";

const OWNER = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const OTHER = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const ACCOUNT_ID = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";

interface InvokeCall {
  functionName: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}

interface StoreCall {
  userId: string;
  dataUrl: string;
}

interface FakeCalls {
  invokes: InvokeCall[];
  stores: StoreCall[];
  loads: string[];
  quotaChecks: string[];
}

interface FakeDepsOptions {
  account?: ProxyAccount | null;
  failed?: boolean;
  upstream?: InvokeResult;
  stored?: StoredImage;
  storeError?: Error;
  quotaBlocked?: { limit: number } | null;
}

const DEFAULT_ACCOUNT: ProxyAccount = {
  id: ACCOUNT_ID,
  user_id: OWNER,
  platform: "facebook",
  platform_user_id: "page-1",
  is_active: true,
};

const DEFAULT_STORED: StoredImage = { id: "media-1", file_path: "https://cdn.example/x.png" };

/** Fakes for every dependency the proxy takes: no env, no network, no Supabase. */
function fakeDeps(options: FakeDepsOptions = {}): { deps: ServiceProxyDeps; calls: FakeCalls } {
  const calls: FakeCalls = { invokes: [], stores: [], loads: [], quotaChecks: [] };
  const account = options.account === undefined ? DEFAULT_ACCOUNT : options.account;
  const upstream = options.upstream ?? { status: 200, data: {} };
  const stored = options.stored ?? DEFAULT_STORED;
  const deps: ServiceProxyDeps = {
    loadAccount: async (accountId) => {
      calls.loads.push(accountId);
      return { account, failed: options.failed === true };
    },
    invoke: async (functionName, body, timeoutMs) => {
      calls.invokes.push({ functionName, body, timeoutMs });
      return upstream;
    },
    storeImage: async (userId, dataUrl) => {
      calls.stores.push({ userId, dataUrl });
      if (options.storeError) throw options.storeError;
      return stored;
    },
    mediaQuotaBlocked: async (userId) => {
      calls.quotaChecks.push(userId);
      return options.quotaBlocked ?? null;
    },
  };
  return { deps, calls };
}

const params = (entries: Record<string, string>) => new URLSearchParams(entries);

function bodyOf(result: { body: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

function errorOf(result: { body: unknown }): { code: string; message: string } {
  return (result.body as { error: { code: string; message: string } }).error;
}

Deno.test("a missing account answers exactly like an account owned by someone else", async () => {
  const owned = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OTHER, platform: "facebook", platform_user_id: "page-1", is_active: true },
  });
  const missing = fakeDeps({ account: null });
  const ownedResult = await handleListComments(owned.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  const missingResult = await handleListComments(missing.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(missingResult.status, 404);
  assertEquals(errorOf(missingResult).code, "ACCOUNT_NOT_FOUND");
  assertEquals(missingResult.body, ownedResult.body);
  assertEquals(ownedResult.status, 404);
  assertEquals(owned.calls.invokes.length, 0);
  assertEquals(missing.calls.invokes.length, 0);
});

Deno.test("a failed account lookup is a 500, never a missing account", async () => {
  const { deps, calls } = fakeDeps({ failed: true });
  const result = await handleListComments(deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(result.status, 500);
  assertEquals(errorOf(result).code, "INTERNAL_ERROR");
  assertEquals(calls.invokes.length, 0);
});

Deno.test("a social_account_id that is not a UUID never reaches the database", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleListComments(deps, OWNER, params({ social_account_id: "not-a-uuid" }));
  assertEquals(result.status, 400);
  assertEquals(errorOf(result).code, "INVALID_ACCOUNT_ID");
  assertEquals(calls.loads.length, 0);
  assertEquals(calls.invokes.length, 0);
});

Deno.test("facebook comments are read through comment-manager with the caller's own account", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleListComments(deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(result.status, 200);
  assertEquals(calls.invokes.length, 1);
  assertEquals(calls.invokes[0].functionName, "comment-manager");
  assertEquals(calls.invokes[0].body, {
    action: "get_page_comments",
    page_id: "page-1",
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });
  assertEquals(calls.invokes[0].timeoutMs, 45000);
});

Deno.test("instagram and youtube ask the comment manager for their own listing", async () => {
  const instagram = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "instagram", platform_user_id: "ig-1", is_active: true },
  });
  const instagramResult = await handleListComments(instagram.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(instagramResult.status, 200);
  assertEquals(instagram.calls.invokes[0].body, {
    action: "get_ig_comments",
    ig_user_id: "ig-1",
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });

  const youtube = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "youtube", platform_user_id: null, is_active: true },
  });
  const youtubeResult = await handleListComments(youtube.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(youtubeResult.status, 200);
  assertEquals(youtube.calls.invokes[0].body, {
    action: "get_youtube_comments",
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });
});

Deno.test("a caller-supplied action parameter is ignored", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleListComments(
    deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, action: "delete_comment" }),
  );
  assertEquals(result.status, 200);
  assertEquals(calls.invokes[0].body.action, "get_page_comments");
});

Deno.test("listing comments on a threads account is refused without a call", async () => {
  const { deps, calls } = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "threads", platform_user_id: "t-1", is_active: true },
  });
  const result = await handleListComments(deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(result.status, 400);
  assertEquals(errorOf(result).code, "UNSUPPORTED_PLATFORM");
  assertEquals(calls.invokes.length, 0);
});

Deno.test("post_id and limit trim the listing the upstream returned", async () => {
  const listing = { data: [{ id: "a" }, { id: "b" }, { id: "c" }], paging: { x: 1 } };

  const limited = fakeDeps({ upstream: { status: 200, data: listing } });
  const limitedResult = await handleListComments(
    limited.deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, limit: "2" }),
  );
  assertEquals(limitedResult.status, 200);
  assertEquals(bodyOf(limitedResult).data, [{ id: "a" }, { id: "b" }]);
  assertEquals(bodyOf(limitedResult).paging, { x: 1 });

  const single = fakeDeps({ upstream: { status: 200, data: listing } });
  const singleResult = await handleListComments(
    single.deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, post_id: "b" }),
  );
  assertEquals(singleResult.status, 200);
  assertEquals(bodyOf(singleResult).data, [{ id: "b" }]);

  const youtube = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "youtube", platform_user_id: null, is_active: true },
    upstream: { status: 200, data: { videos: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
  });
  const youtubeResult = await handleListComments(
    youtube.deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, limit: "2" }),
  );
  assertEquals(youtubeResult.status, 200);
  assertEquals(bodyOf(youtubeResult).videos, [{ id: "a" }, { id: "b" }]);
});

Deno.test("graph pagination URLs never reach the caller", async () => {
  const comments = fakeDeps({
    upstream: {
      status: 200,
      data: {
        data: [{
          id: "p1",
          comments: {
            data: [{ id: "c1" }],
            paging: {
              cursors: { after: "A" },
              next: "https://graph.facebook.com/v22.0/x?access_token=SECRET&after=A",
            },
          },
        }],
        paging: {
          cursors: { before: "B" },
          previous: "https://graph.facebook.com/v22.0/y?access_token=SECRET",
        },
      },
    },
  });
  const commentsResult = await handleListComments(comments.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(commentsResult.status, 200);
  const commentsJson = JSON.stringify(commentsResult.body);
  assertEquals(commentsJson.includes("SECRET"), false);
  assertEquals(commentsJson.includes("access_token"), false);
  const commentsBody = bodyOf(commentsResult);
  const posts = commentsBody.data as { comments: { paging: { cursors: { after: string } } } }[];
  assertEquals(posts[0].comments.paging.cursors.after, "A");
  const topPaging = commentsBody.paging as { cursors: { before: string } };
  assertEquals(topPaging.cursors.before, "B");

  const messages = fakeDeps({
    upstream: {
      status: 200,
      data: { messages: [{ id: "m1" }], paging: { next: "https://graph.facebook.com/z?access_token=SECRET" } },
    },
  });
  const messagesResult = await handleListMessages(messages.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(messagesResult.status, 200);
  assertEquals(JSON.stringify(messagesResult.body).includes("SECRET"), false);
});

Deno.test("a limit outside 1..50 is refused before anything is called", async () => {
  for (const bad of ["0", "51", "abc"]) {
    const { deps, calls } = fakeDeps();
    const result = await handleListComments(deps, OWNER, params({ social_account_id: ACCOUNT_ID, limit: bad }));
    assertEquals(result.status, 400);
    assertEquals(errorOf(result).code, "INVALID_LIMIT");
    assertEquals(calls.invokes.length, 0);
  }
});

Deno.test("list_messages without conversation_id lists the conversations", async () => {
  const conversations = fakeDeps();
  const conversationsResult = await handleListMessages(conversations.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(conversationsResult.status, 200);
  assertEquals(conversations.calls.invokes[0].functionName, "messaging-api");
  assertEquals(conversations.calls.invokes[0].body, {
    action: "list_conversations",
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });
});

Deno.test("list_messages with conversation_id reads that conversation", async () => {
  const messages = fakeDeps();
  const messagesResult = await handleListMessages(
    messages.deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, conversation_id: "c1" }),
  );
  assertEquals(messagesResult.status, 200);
  assertEquals(messages.calls.invokes[0].body, {
    action: "get_messages",
    conversation_id: "c1",
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });
});

Deno.test("list_messages refuses a whatsapp account without a call", async () => {
  const whatsapp = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "whatsapp", platform_user_id: "wa-1", is_active: true },
  });
  const whatsappResult = await handleListMessages(whatsapp.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(whatsappResult.status, 400);
  assertEquals(errorOf(whatsappResult).code, "UNSUPPORTED_PLATFORM");
  assertEquals(whatsapp.calls.invokes.length, 0);
});

Deno.test("a conversation_id with URL characters is refused before any call", async () => {
  for (const bad of ["c1/../me", "c1?fields=access_token", "c1#x", "a".repeat(201)]) {
    const { deps, calls } = fakeDeps();
    const result = await handleListMessages(
      deps,
      OWNER,
      params({ social_account_id: ACCOUNT_ID, conversation_id: bad }),
    );
    assertEquals(result.status, 400);
    assertEquals(errorOf(result).code, "INVALID_CONVERSATION_ID");
    assertEquals(calls.invokes.length, 0);
  }
});

Deno.test("threads analytics sends the requested or default period", async () => {
  const cases: { period: string | undefined; expected: number }[] = [
    { period: "30", expected: 30 },
    { period: undefined, expected: 7 },
  ];
  for (const { period, expected } of cases) {
    const threads = fakeDeps({
      account: { id: ACCOUNT_ID, user_id: OWNER, platform: "threads", platform_user_id: "t-1", is_active: true },
    });
    const query: Record<string, string> = { social_account_id: ACCOUNT_ID };
    if (period) query.period_days = period;
    const threadsResult = await handleGetPostAnalytics(threads.deps, OWNER, params(query));
    assertEquals(threadsResult.status, 200);
    assertEquals(threads.calls.invokes[0].functionName, "threads-insights");
    assertEquals(threads.calls.invokes[0].body, {
      user_id: OWNER,
      accountId: ACCOUNT_ID,
      periodDays: expected,
    });
  }
});

Deno.test("a period outside 7, 14, 30, 90 is refused before any call", async () => {
  const badPeriod = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "threads", platform_user_id: "t-1", is_active: true },
  });
  const badPeriodResult = await handleGetPostAnalytics(
    badPeriod.deps,
    OWNER,
    params({ social_account_id: ACCOUNT_ID, period_days: "8" }),
  );
  assertEquals(badPeriodResult.status, 400);
  assertEquals(errorOf(badPeriodResult).code, "INVALID_PERIOD");
  assertEquals(badPeriod.calls.invokes.length, 0);
});

Deno.test("tiktok analytics reads the account's videos", async () => {
  const tiktok = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "tiktok", platform_user_id: "tt-1", is_active: true },
  });
  const tiktokResult = await handleGetPostAnalytics(tiktok.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(tiktokResult.status, 200);
  assertEquals(tiktok.calls.invokes[0].functionName, "tiktok-analytics");
  assertEquals(tiktok.calls.invokes[0].body, {
    user_id: OWNER,
    social_account_id: ACCOUNT_ID,
  });
});

Deno.test("analytics on any other platform says it is not supported yet", async () => {
  const facebook = fakeDeps();
  const facebookResult = await handleGetPostAnalytics(facebook.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(facebookResult.status, 400);
  assertEquals(errorOf(facebookResult).code, "UNSUPPORTED_PLATFORM");
  assertEquals(errorOf(facebookResult).message.includes("not supported yet"), true);
  assertEquals(facebook.calls.invokes.length, 0);
});

Deno.test("an upstream 500 becomes a generic 502 without the upstream text", async () => {
  const broken = fakeDeps({ upstream: { status: 500, data: { error: "relation social_accounts does not exist" } } });
  const brokenResult = await handleListComments(broken.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(brokenResult.status, 502);
  assertEquals(errorOf(brokenResult).code, "UPSTREAM_ERROR");
  assertEquals(JSON.stringify(brokenResult.body).includes("social_accounts"), false);
});

Deno.test("an upstream timeout becomes 504", async () => {
  const slow = fakeDeps({ upstream: { status: 504, data: null } });
  const slowResult = await handleListComments(slow.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(slowResult.status, 504);
  assertEquals(errorOf(slowResult).code, "UPSTREAM_TIMEOUT");
});

Deno.test("a function's own 429 passes through to the caller", async () => {
  const limited = fakeDeps({ upstream: { status: 429, data: { error: "Rate limit exceeded" } } });
  const limitedResult = await handleListComments(limited.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(limitedResult.status, 429);
  assertEquals(bodyOf(limitedResult).error, "Rate limit exceeded");
});

Deno.test("generate_caption forwards the caller's text to the caption function", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleGenerateCaption(deps, OWNER, {
    context: "launch",
    platform: "instagram",
    tone: "fun",
  });
  assertEquals(result.status, 200);
  assertEquals(calls.invokes[0].functionName, "generate-caption");
  assertEquals(calls.invokes[0].body, {
    user_id: OWNER,
    context: "launch",
    platform: "instagram",
    tone: "fun",
  });
  assertEquals("language" in calls.invokes[0].body, false);
  assertEquals(calls.invokes[0].timeoutMs, 60000);

  const missing = fakeDeps();
  const missingResult = await handleGenerateCaption(missing.deps, OWNER, { platform: "instagram" });
  assertEquals(missingResult.status, 400);
  assertEquals(errorOf(missingResult).code, "INVALID_REQUEST");
  assertEquals(missing.calls.invokes.length, 0);

  const tooLong = fakeDeps();
  const tooLongResult = await handleGenerateCaption(tooLong.deps, OWNER, {
    context: "x".repeat(10001),
    platform: "instagram",
  });
  assertEquals(tooLongResult.status, 400);
  assertEquals(errorOf(tooLongResult).code, "INVALID_REQUEST");
  assertEquals(tooLong.calls.invokes.length, 0);
});

Deno.test("generate_hashtags needs a caption and a platform", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleGenerateHashtags(deps, OWNER, { caption: "hello", platform: "instagram" });
  assertEquals(result.status, 200);
  assertEquals(calls.invokes[0].functionName, "generate-hashtags");
  assertEquals(calls.invokes[0].body, { user_id: OWNER, caption: "hello", platform: "instagram" });
  assertEquals(calls.invokes[0].timeoutMs, 60000);

  const missing = fakeDeps();
  const missingResult = await handleGenerateHashtags(missing.deps, OWNER, { platform: "instagram" });
  assertEquals(missingResult.status, 400);
  assertEquals(errorOf(missingResult).code, "INVALID_REQUEST");
  assertEquals(missing.calls.invokes.length, 0);
});

Deno.test("a hosted image is returned as a URL and never written to the media library", async () => {
  const { deps, calls } = fakeDeps({
    upstream: { status: 200, data: { imageUrl: "https://cdn.example/hosted.png", description: "a cat" } },
  });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat", aspect_ratio: "1:1" });
  assertEquals(result.status, 200);
  assertEquals(result.body, {
    success: true,
    image_url: "https://cdn.example/hosted.png",
    description: "a cat",
  });
  assertEquals(calls.stores.length, 0);
  assertEquals(calls.quotaChecks, [OWNER]);
  assertEquals(calls.invokes[0].functionName, "generate-image");
  assertEquals(calls.invokes[0].body, { user_id: OWNER, prompt: "a cat", aspectRatio: "1:1" });
  assertEquals(calls.invokes[0].timeoutMs, 90000);
});

Deno.test("an inline image is stored in the media library and only its id comes back", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const { deps, calls } = fakeDeps({
    upstream: { status: 200, data: { imageUrl: dataUrl, description: "a cat" } },
  });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat" });
  assertEquals(result.status, 201);
  assertEquals(calls.stores, [{ userId: OWNER, dataUrl }]);
  assertEquals(result.body, {
    success: true,
    media_file_id: "media-1",
    url: "https://cdn.example/x.png",
    description: "a cat",
  });
  assertEquals(JSON.stringify(result.body).includes("base64"), false);
});

Deno.test("a generated image that cannot be stored is reported without the image bytes", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const { deps } = fakeDeps({
    upstream: { status: 200, data: { imageUrl: dataUrl } },
    storeError: new Error("storage unavailable"),
  });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat" });
  assertEquals(result.status, 502);
  assertEquals(errorOf(result).code, "IMAGE_STORE_FAILED");
  assertEquals(JSON.stringify(result.body).includes("base64"), false);
});

Deno.test("a full media library answers 429 with the quota code, not a retryable 502", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const { deps } = fakeDeps({
    upstream: { status: 200, data: { imageUrl: dataUrl } },
    storeError: new Error("Daily upload limit of 50 reached. Upgrade your plan or try again tomorrow."),
  });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat" });
  assertEquals(result.status, 429);
  assertEquals(errorOf(result).code, "MEDIA_QUOTA_DAILY_EXCEEDED");
  assertEquals(JSON.stringify(result.body).includes("base64"), false);
});

Deno.test("a full media library refuses image generation before the billed call", async () => {
  const { deps, calls } = fakeDeps({ quotaBlocked: { limit: 50 } });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat" });
  assertEquals(result.status, 429);
  assertEquals(errorOf(result).code, "MEDIA_QUOTA_DAILY_EXCEEDED");
  assertEquals(errorOf(result).message.includes("50"), true);
  assertEquals(calls.invokes.length, 0);
});

Deno.test("a timed-out AI generation says not to retry, unlike a read", async () => {
  const timedOut: InvokeResult = { status: 504, data: null };
  const generations: ((deps: ServiceProxyDeps) => Promise<{ status: number; body: unknown }>)[] = [
    (deps) => handleGenerateCaption(deps, OWNER, { context: "launch", platform: "instagram" }),
    (deps) => handleGenerateHashtags(deps, OWNER, { caption: "hello", platform: "instagram" }),
    (deps) => handleGenerateImage(deps, OWNER, { prompt: "a cat" }),
  ];
  for (const generate of generations) {
    const { deps } = fakeDeps({ upstream: timedOut });
    const result = await generate(deps);
    assertEquals(result.status, 504);
    assertEquals(errorOf(result).code, "GENERATION_TIMEOUT");
  }
});

Deno.test("an inactive account is refused before any call", async () => {
  const comments = fakeDeps({
    account: { ...DEFAULT_ACCOUNT, is_active: false },
  });
  const commentsResult = await handleListComments(comments.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(commentsResult.status, 409);
  assertEquals(errorOf(commentsResult).code, "ACCOUNT_INACTIVE");
  assertEquals(comments.calls.invokes.length, 0);

  const analytics = fakeDeps({
    account: { id: ACCOUNT_ID, user_id: OWNER, platform: "threads", platform_user_id: "t-1", is_active: false },
  });
  const analyticsResult = await handleGetPostAnalytics(analytics.deps, OWNER, params({ social_account_id: ACCOUNT_ID }));
  assertEquals(analyticsResult.status, 409);
  assertEquals(errorOf(analyticsResult).code, "ACCOUNT_INACTIVE");
  assertEquals(analytics.calls.invokes.length, 0);
});

Deno.test("an image the provider refused is reported as a failed generation", async () => {
  const { deps, calls } = fakeDeps({
    upstream: {
      status: 200,
      data: { success: false, error_code: "ai_error", message: "Image generation failed: boom" },
    },
  });
  const result = await handleGenerateImage(deps, OWNER, { prompt: "a cat" });
  assertEquals(result.status, 422);
  assertEquals(errorOf(result).code, "IMAGE_GENERATION_FAILED");
  assertEquals(calls.stores.length, 0);
});

Deno.test("the production invoker posts to the function with the service role and a timeout", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  const invoke = createFunctionInvoker("https://fn.test/functions/v1", "svc-key", fakeFetch);
  const result = await invoke("generate-caption", { user_id: OWNER }, 1000);
  assertEquals(result, { status: 200, data: { ok: true } });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "https://fn.test/functions/v1/generate-caption");
  assertEquals(seen[0].init.method, "POST");
  assertEquals(new Headers(seen[0].init.headers).get("authorization"), "Bearer svc-key");
  assertEquals(JSON.parse(String(seen[0].init.body)), { user_id: OWNER });
  assertEquals(seen[0].init.signal instanceof AbortSignal, true);

  const timeoutFetch = () => Promise.reject(new DOMException("t", "TimeoutError"));
  const timedOut = await createFunctionInvoker("https://fn.test/functions/v1", "svc-key", timeoutFetch)(
    "generate-caption",
    { user_id: OWNER },
    1000,
  );
  assertEquals(timedOut, { status: 504, data: null });

  const brokenFetch = () => Promise.reject(new TypeError("net"));
  const broken = await createFunctionInvoker("https://fn.test/functions/v1", "svc-key", brokenFetch)(
    "generate-caption",
    { user_id: OWNER },
    1000,
  );
  assertEquals(broken, { status: 502, data: null });
});

Deno.test("a body that is not JSON is a 502, not an empty success", async () => {
  const fakeFetch = () => Promise.resolve(new Response("<html>oops</html>", { status: 200 }));
  const invoke = createFunctionInvoker("https://fn.test/functions/v1", "svc-key", fakeFetch);
  const result = await invoke("comment-manager", { user_id: OWNER }, 1000);
  assertEquals(result, { status: 502, data: null });
});

Deno.test("the account loader reads one account and tells a failed read from a missing row", async () => {
  const seen: { table: string; column: string; value: string }[] = [];
  const fakeSupabase = (result: { data: unknown; error: unknown }) => ({
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            eq(column: string, value: string) {
              seen.push({ table, column, value });
              return { maybeSingle: () => Promise.resolve(result) };
            },
          };
        },
      };
    },
  });

  const failed = supabaseAccountLoader(fakeSupabase({ data: null, error: { message: "x" } }));
  assertEquals(await failed(ACCOUNT_ID), { account: null, failed: true });

  const account: ProxyAccount = {
    id: ACCOUNT_ID,
    user_id: OWNER,
    platform: "facebook",
    platform_user_id: "page-1",
    is_active: true,
  };
  const found = supabaseAccountLoader(fakeSupabase({ data: account, error: null }));
  assertEquals(await found(ACCOUNT_ID), { account, failed: false });

  assertEquals(seen.length, 2);
  assertEquals(seen[0].table, "social_accounts");
  assertEquals(seen[0].column, "id");
  assertEquals(seen[0].value, ACCOUNT_ID);
});
