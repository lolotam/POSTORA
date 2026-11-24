/**
 * The Stage 4 journey server: a loopback API on 127.0.0.1:65438 that serves
 * the REAL comment-manager route (captured from its Deno.serve registration)
 * against the REAL SQL functions on the disposable harness database, through
 * a REAL PostgREST — with a counting fake YouTube provider as the only
 * synthetic piece.
 *
 * Everything the browser sees is produced by production code paths: the app,
 * the supabase client, the edge route, the receipt state machine in SQL.
 * Only Google is faked, and every provider call is counted.
 *
 * Run by scripts/stage4-e2e.mjs; see e2e/youtube-stage4.spec.ts.
 */

const API_PORT = Number(Deno.env.get("STAGE4_API_PORT") ?? 65438);
const APP_URL = Deno.env.get("STAGE4_APP_URL") ?? "http://localhost:8080";
const PGREST = Deno.env.get("STAGE4_PGREST_URL") ?? "http://127.0.0.1:54324";
const SERVICE_KEY = Deno.env.get("STAGE4_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("STAGE4_ANON_KEY") ?? "";
const OWNER_ID = Deno.env.get("STAGE4_OWNER_ID")!;
const OWNER_EMAIL = Deno.env.get("STAGE4_OWNER_EMAIL") ?? "stage4-journey@example.invalid";
const OWNER_PASSWORD = Deno.env.get("STAGE4_OWNER_PASSWORD")!; // generated per run by scripts/stage4-e2e.mjs
const ACCOUNT_ID = Deno.env.get("STAGE4_ACCOUNT_ID")!;
const CHANNEL_ID = Deno.env.get("STAGE4_CHANNEL_ID") ?? "UC-s4-journey";
const API_URL = `http://127.0.0.1:${API_PORT}`;

for (const [key, value] of Object.entries({
  SUPABASE_URL: API_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SUPABASE_ANON_KEY: ANON_KEY,
})) {
  Deno.env.set(key, value);
}

// ---- the counting fake provider --------------------------------------------

const THREAD_ID = "th-journey-1";
const TOP_ID = "cmt-journey-top";
const OWN_REPLY_ID = "cmt-journey-own-reply";
const FOREIGN_REPLY_ID = "cmt-journey-foreign";
const HELD_TOP_ID = "cmt-journey-held";
const VIEWER_THREAD_ID = "th-journey-viewer";
const VIEWER_TOP_ID = "cmt-journey-viewer";

export interface ProviderWrite {
  path: string;
  method: string;
  query: string;
  body?: unknown;
}

const state = {
  writes: [] as ProviderWrite[],
  reads: 0,
  failReplyPageOnce: false,
  indeterminateNextCreate: false,
  dropNextResponse: false,
};

function envelope(reason: string) {
  return { error: { errors: [{ reason, message: reason }], message: reason } };
}

function threadFixture(
  top: { id: string; text: string; author: string; status?: string },
  options: { threadId?: string; withReplies?: boolean } = {},
) {
  return {
    id: options.threadId ?? THREAD_ID,
    snippet: {
      videoId: "vid-journey",
      channelId: CHANNEL_ID,
      topLevelComment: {
        id: top.id,
        snippet: {
          authorChannelId: { value: top.author },
          authorDisplayName: top.author === CHANNEL_ID ? "Journey Channel" : "A Viewer",
          textOriginal: top.text,
          moderationStatus: top.status ?? "published",
          publishedAt: "2026-11-20T10:00:00Z",
        },
      },
    },
    replies: {
      comments: options.withReplies === false ? [] : [{
        id: OWN_REPLY_ID,
        snippet: {
          parentId: top.id,
          authorChannelId: { value: CHANNEL_ID },
          authorDisplayName: "Journey Channel",
          textOriginal: "the channel's own reply",
          moderationStatus: "published",
          publishedAt: "2026-11-20T10:05:00Z",
        },
      }],
    },
  };
}

function replyPageItem(id: string, text: string, author = "UC-viewer-2") {
  return {
    id,
    snippet: {
      parentId: TOP_ID,
      authorChannelId: { value: author },
      authorDisplayName: "Another Viewer",
      textOriginal: text,
      moderationStatus: "published",
      publishedAt: "2026-11-20T11:00:00Z",
    },
  };
}

function provider(request: Request, bodyText: string | null): { status: number; body: unknown } {
  const url = new URL(request.url);
  const path = url.pathname.replace("/youtube/v3/", "");
  const method = request.method;
  const isWrite = method === "POST" || method === "PUT" || method === "DELETE";
  if (isWrite) {
    state.writes.push({
      path,
      method,
      query: url.search,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    });
  } else {
    state.reads += 1;
  }

  if (path === "playlistItems") {
    return {
      status: 200,
      body: {
        items: [
          {
            snippet: {
              resourceId: { videoId: "vid-journey" },
              title: "Journey video",
              publishedAt: "2026-11-19T00:00:00Z",
            },
          },
          {
            snippet: {
              resourceId: { videoId: "vid-empty" },
              title: "Empty upload",
              publishedAt: "2026-11-18T00:00:00Z",
            },
          },
        ],
      },
    };
  }
  if (path === "videos") {
    const id = url.searchParams.get("id");
    return { status: 200, body: { items: [{ id, snippet: { channelId: CHANNEL_ID } }] } };
  }
  if (path === "commentThreads" && method === "GET") {
    const status = url.searchParams.get("moderationStatus");
    if (url.searchParams.get("videoId") === "vid-empty") {
      return { status: 200, body: { items: [] } }; // a real upload with zero comments
    }
    if (status === "heldForReview") {
      return { status: 200, body: { items: [threadFixture({ id: HELD_TOP_ID, text: "held by the moderator", author: "UC-viewer-held", status: "heldForReview" })] } };
    }
    return {
      status: 200,
      body: {
        items: [
          threadFixture({ id: TOP_ID, text: "the channel's own comment", author: CHANNEL_ID }),
          // A viewer's comment: the only kind a ban can target (the author must
          // not be the channel itself).
          threadFixture(
            { id: VIEWER_TOP_ID, text: "a viewer's comment", author: "UC-viewer-1" },
            { threadId: VIEWER_THREAD_ID, withReplies: false },
          ),
        ],
      },
    };
  }
  if (path === "comments" && method === "GET" && url.searchParams.get("id")) {
    const id = url.searchParams.get("id");
    const own = id === TOP_ID || id === OWN_REPLY_ID;
    const viewerTop = id === VIEWER_TOP_ID;
    return {
      status: 200,
      body: {
        items: [{
          id,
          snippet: {
            authorChannelId: { value: own ? CHANNEL_ID : viewerTop ? "UC-viewer-1" : "UC-viewer-2" },
            authorDisplayName: own ? "Journey Channel" : viewerTop ? "A Viewer" : "Another Viewer",
            textOriginal: own
              ? (id === TOP_ID ? "the channel's own comment" : "the channel's own reply")
              : viewerTop ? "a viewer's comment" : "a foreign reply",
          },
        }],
      },
    };
  }
  if (path === "comments" && method === "GET") {
    // Reply pages for the top-level comment: three pages, the middle one can
    // be made to fail once to exercise the retry-this-page journey.
    if (state.failReplyPageOnce && url.searchParams.get("pageToken") === "page-2") {
      state.failReplyPageOnce = false;
      return { status: 500, body: envelope("backendError") };
    }
    const token = url.searchParams.get("pageToken");
    if (!token) {
      return { status: 200, body: { items: [replyPageItem("r-1", "reply page one"), replyPageItem("r-2", "reply page one b")], nextPageToken: "page-2" } };
    }
    if (token === "page-2") {
      return { status: 200, body: { items: [replyPageItem("r-3", "reply page two"), replyPageItem("r-4", "reply page two b")], nextPageToken: "page-3" } };
    }
    return { status: 200, body: { items: [replyPageItem("r-5", "reply page three")] } };
  }
  if (path === "commentThreads" && method === "POST") {
    if (state.indeterminateNextCreate) {
      state.indeterminateNextCreate = false;
      return { status: 200, body: { id: null, snippet: {} } }; // a 2xx missing ids
    }
    const requested = bodyText ? JSON.parse(bodyText) as { snippet?: { videoId?: string } } : {};
    return {
      status: 200,
      body: {
        id: "th-created-journey",
        snippet: {
          videoId: requested.snippet?.videoId ?? "vid-journey",
          channelId: CHANNEL_ID,
          topLevelComment: { id: "cmt-created-journey", snippet: { textOriginal: "created" } },
        },
      },
    };
  }
  if (path === "comments" && (method === "POST" || method === "PUT")) {
    // YouTube semantics: comments.insert (reply) is POST with snippet.parentId;
    // comments.update (edit) is PUT with the comment id. A wrong verb is a 405,
    // so a regression to POST-for-edit fails the journey instead of passing.
    const body = bodyText ? JSON.parse(bodyText) as { id?: string; snippet?: { parentId?: string } } : {};
    if (method === "POST" && body?.snippet?.parentId && !body.id) {
      return { status: 200, body: { id: "cmt-created-reply", snippet: { parentId: body.snippet.parentId } } };
    }
    if (method === "PUT" && body?.id && !body?.snippet?.parentId) {
      return { status: 200, body: { id: body.id, snippet: { textOriginal: "edited" } } };
    }
    return { status: 405, body: envelope("methodNotAllowed") };
  }
  if (path === "comments/setModerationStatus") {
    return { status: method === "POST" ? 204 : 405, body: method === "POST" ? null : envelope("methodNotAllowed") };
  }
  if (path === "comments" && method === "DELETE") {
    return { status: 204, body: null }; // comments.delete (the existing owner-delete path)
  }
  return { status: 404, body: envelope("notFound") };
}

// ---- fetch routing -----------------------------------------------------------

const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "www.googleapis.com") {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const answer = provider(request, bodyText);
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.origin === API_URL) {
    // Self-calls (the handler's admin client) re-enter the router directly.
    return await route(await detached(request, request.url));
  }
  if (url.origin === PGREST) {
    return await nativeFetch(request);
  }
  throw new Error(`unexpected external request: ${request.url}`);
};

// ---- the real route, captured -----------------------------------------------

type Handler = (request: Request) => Response | Promise<Response>;

async function captureRoute(load: () => Promise<unknown>): Promise<Handler> {
  const nativeServe = Deno.serve;
  let captured: Handler | undefined;
  try {
    Deno.serve = ((handler: Handler) => {
      if (captured) throw new Error("route registered more than once");
      captured = handler;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    }) as typeof Deno.serve;
    await load();
  } finally {
    Deno.serve = nativeServe;
  }
  if (!captured) throw new Error("the production comment-manager route did not register");
  return captured;
}

const commentManager = await captureRoute(() => import("../../supabase/functions/comment-manager/index.ts"));

// ---- auth shim + control ------------------------------------------------------

function sessionBody() {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: ANON_KEY ? signedUserToken() : "",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expires,
    refresh_token: "journey-refresh-token",
    user: {
      id: OWNER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: OWNER_EMAIL,
    },
  };
}

/** The owner's JWT, signed with the PostgREST secret by the orchestrator. */
function signedUserToken(): string {
  // The orchestrator hands us a ready user token; the shim only replays it.
  return Deno.env.get("STAGE4_USER_TOKEN") ?? "";
}

async function setCapabilities(on: boolean): Promise<void> {
  const response = await nativeFetch(`${PGREST}/app_settings?key=eq.youtube_comments_stage4_rollout`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      value: {
        version: 1,
        accounts: on
          ? { [ACCOUNT_ID]: { read: true, held: true, write: true, ban: true } }
          : { [ACCOUNT_ID]: { read: false, held: false, write: false, ban: false } },
      },
    }),
  });
  if (!response.ok) throw new Error(`capability flip failed: ${response.status}`);
}

/**
 * A copy of `request` aimed at `target` WITHOUT its abort signal. Deno.serve
 * (legacy abort behaviour) aborts the incoming request's signal as soon as a
 * response is returned, which would truncate a proxied body that is still
 * streaming back to the browser.
 */
async function detached(request: Request, target: string): Promise<Request> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(target, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/__stage4/")) {
    const action = url.pathname.slice("/__stage4/".length);
    if (request.method === "GET" && action === "provider") {
      return Response.json({ writes: state.writes.length, writePaths: state.writes.map((w) => `${w.method} ${w.path}${w.query}`), writeBodies: state.writes.map((w) => w.body ?? null), reads: state.reads });
    }
    if (request.method === "POST") {
      if (action === "fail-reply-page-once") state.failReplyPageOnce = true;
      else if (action === "indeterminate-next-create") state.indeterminateNextCreate = true;
      else if (action === "drop-next-response") state.dropNextResponse = true;
      else if (action === "capabilities") {
        const body = await request.json() as { on: boolean };
        await setCapabilities(body.on === true);
      } else if (action === "reset") {
        state.writes = [];
        state.reads = 0;
        state.failReplyPageOnce = false;
        state.indeterminateNextCreate = false;
        state.dropNextResponse = false;
      } else {
        return new Response(null, { status: 404 });
      }
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 405 });
  }

  if (url.pathname === "/auth/v1/token") {
    return Response.json(sessionBody());
  }
  if (url.pathname === "/auth/v1/user") {
    return Response.json(sessionBody().user);
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    return Response.json({});
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    return await nativeFetch(await detached(request, `${PGREST}${url.pathname.slice("/rest/v1".length)}${url.search}`));
  }
  if (url.pathname === "/functions/v1/comment-manager") {
    // Clone before the handler consumes the body: the drop decision below
    // still needs to read the action.
    const cloned = request.clone();
    const response = request.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : await commentManager(request);
    if (state.dropNextResponse && request.method === "POST") {
      // Only a deliberate WRITE loses its answer; reads keep flowing.
      const body = await cloned.json().catch(() => null) as { action?: string } | null;
      const action = body?.action ?? "";
      if (action.startsWith("youtube_create") || action.startsWith("youtube_reply")
        || action.startsWith("youtube_edit") || action.startsWith("youtube_moderate")) {
        state.dropNextResponse = false;
        // The settlement is already committed inside the handler; the browser
        // loses the answer exactly like a severed connection.
        return new Response(null, { status: 599 });
      }
    }
    return response;
  }
  return Response.json({ error: "fixture_route_not_found", path: url.pathname }, { status: 404 });
}

async function serveRequest(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    // Preflight answered here for every route, echoing the requested headers
    // (the supabase client sends accept-profile/content-profile and more).
    if (origin !== APP_URL) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ?? "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  // A foreign browser origin is refused BEFORE any route runs: a cross-origin
  // request that needs no preflight must not reach the control routes, the
  // rollout settings or the counters.
  if (origin && origin !== APP_URL) return new Response(null, { status: 403 });
  try {
    const response = await route(request);
    const headers = new Headers(response.headers);
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Expose-Headers", "content-range,x-supabase-api-version,content-profile");
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (failure) {
    console.error("journey route failed", { path: new URL(request.url).pathname, name: failure instanceof Error ? failure.name : "unknown" });
    return Response.json({ error: "fixture_route_failed" }, { status: 500 });
  }
}

const server = Deno.serve({ hostname: "127.0.0.1", port: API_PORT }, serveRequest);
const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  Deno.addSignalListener(signal, () => {
    void server.shutdown().catch(() => Deno.exit(1));
  });
}
console.log(`stage4 journey api on ${API_URL}`);
