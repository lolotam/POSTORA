import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createPageReconciliationBudget,
  createMetaPageReconciliationProvider,
  DEFAULT_FACEBOOK_GRAPH_API_VERSION,
  PAGE_MAX_TOTAL_REQUESTS,
  resolveGraphApiVersion,
  type PageReconciliationBudget,
} from "./metaPageReconciliationProvider.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const USER_TOKEN = "captured-user-secret-must-not-leak";
const PAGE_TOKEN = "derived-page-token-must-not-leak";
const PROVIDER_USER_ID = "fb-user-9001";
const PAGE_ID = "page-7001";
const INSTAGRAM_ID = "ig-page-7001";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetcher(
  handler: (url: string, index: number) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return await handler(url, calls.length - 1);
  }) as typeof fetch;
  return { fetcher, calls };
}

function budget(totalMs = 24_000): PageReconciliationBudget {
  const clock = 0;
  return createPageReconciliationBudget(totalMs, () => clock);
}

// ---------------------------------------------------------------------------
// The Graph version
// ---------------------------------------------------------------------------

Deno.test("the configured Graph version wins and a malformed one refuses", () => {
  assertEquals(resolveGraphApiVersion(undefined), DEFAULT_FACEBOOK_GRAPH_API_VERSION);
  assertEquals(resolveGraphApiVersion(null), DEFAULT_FACEBOOK_GRAPH_API_VERSION);
  assertEquals(resolveGraphApiVersion(""), DEFAULT_FACEBOOK_GRAPH_API_VERSION);
  assertEquals(resolveGraphApiVersion("v26.0"), "v26.0");
  assertEquals(resolveGraphApiVersion("v22.0"), "v22.0");
  // A malformed value never selects another version.
  assertEquals(resolveGraphApiVersion("26.0"), null);
  assertEquals(resolveGraphApiVersion("v22"), null);
  assertEquals(resolveGraphApiVersion("v22.0 "), null);
  assertEquals(resolveGraphApiVersion("latest"), null);
});

Deno.test("a malformed configured version makes every call refuse", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ id: PROVIDER_USER_ID }));
  const provider = createMetaPageReconciliationProvider({ graphVersion: "nope", fetcher });
  const outcome = await provider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The captured User identity
// ---------------------------------------------------------------------------

Deno.test("the captured User token must belong to the captured subject", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ id: PROVIDER_USER_ID }));
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "verified");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url.startsWith("https://graph.facebook.com/v22.0/me?"), true);
  assertEquals(calls[0].url.includes(`access_token=${encodeURIComponent(USER_TOKEN)}`), true);
});

Deno.test("a different User identity is an ambiguity and not a revoked grant", async () => {
  const { fetcher } = recordingFetcher(() => jsonResponse({ id: "fb-user-other" }));
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "user_subject_mismatch");
  }
});

Deno.test("a structured provider error is classified and an unknown one is not", async () => {
  const revoked = recordingFetcher(() =>
    jsonResponse({ error: { type: "OAuthException", code: 190, message: "revoked" } }, 400)
  );
  const revokedProvider = createMetaPageReconciliationProvider({ fetcher: revoked.fetcher });
  const revokedOutcome = await revokedProvider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(revokedOutcome.kind, "classified_failure");
  if (revokedOutcome.kind === "classified_failure") {
    assertEquals(revokedOutcome.category, "provider_invalid_grant");
  }

  const unknown = recordingFetcher(() => jsonResponse({ error: { type: "Other", code: 7 } }, 400));
  const unknownProvider = createMetaPageReconciliationProvider({ fetcher: unknown.fetcher });
  const unknownOutcome = await unknownProvider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(unknownOutcome.kind, "unclassified_failure");
});

Deno.test("a rate limit and a server error stay transient", async () => {
  const limited = recordingFetcher(() => jsonResponse({}, 429));
  const limitedProvider = createMetaPageReconciliationProvider({ fetcher: limited.fetcher });
  const limitedOutcome = await limitedProvider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(limitedOutcome.kind, "classified_failure");
  if (limitedOutcome.kind === "classified_failure") {
    assertEquals(limitedOutcome.category, "provider_rate_limited");
  }

  const unavailable = recordingFetcher(() => jsonResponse({}, 503));
  const unavailableProvider = createMetaPageReconciliationProvider({ fetcher: unavailable.fetcher });
  const unavailableOutcome = await unavailableProvider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(unavailableOutcome.kind, "classified_failure");
  if (unavailableOutcome.kind === "classified_failure") {
    assertEquals(unavailableOutcome.category, "provider_unavailable");
  }
});

// ---------------------------------------------------------------------------
// The Page discovery
// ---------------------------------------------------------------------------

function accountsBody(entries: Array<{ id: string; access_token: string }>, paging?: unknown) {
  return paging === undefined ? { data: entries } : { data: entries, paging };
}

Deno.test("the exact protected Page is selected, never the first account", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse(
      accountsBody([
        { id: "page-other", access_token: "other-token" },
        { id: PAGE_ID, access_token: PAGE_TOKEN },
      ]),
    )
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "found");
  if (outcome.kind === "found") assertEquals(outcome.pageToken, PAGE_TOKEN);
  assertEquals(calls.length, 1);
});

Deno.test("conflicting duplicate target entries refuse and identical ones do not", async () => {
  const conflicting = recordingFetcher(() =>
    jsonResponse(
      accountsBody([
        { id: PAGE_ID, access_token: PAGE_TOKEN },
        { id: PAGE_ID, access_token: "another-token" },
      ]),
    )
  );
  const conflictingProvider = createMetaPageReconciliationProvider({ fetcher: conflicting.fetcher });
  const conflictingOutcome = await conflictingProvider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(conflictingOutcome.kind, "incomplete");
  if (conflictingOutcome.kind === "incomplete") {
    assertEquals(conflictingOutcome.reason, "page_target_conflict");
  }

  const identical = recordingFetcher(() =>
    jsonResponse(
      accountsBody([
        { id: PAGE_ID, access_token: PAGE_TOKEN },
        { id: PAGE_ID, access_token: PAGE_TOKEN },
      ]),
    )
  );
  const identicalProvider = createMetaPageReconciliationProvider({ fetcher: identical.fetcher });
  const identicalOutcome = await identicalProvider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(identicalOutcome.kind, "found");
});

Deno.test("a malformed candidate is never target permission evidence", async () => {
  const { fetcher } = recordingFetcher(() =>
    jsonResponse({
      data: [
        { id: "page-other" },
        { id: PAGE_ID, access_token: PAGE_TOKEN },
      ],
    })
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "page_listing_malformed");
  }
});

Deno.test("an oversized listing page is refused", async () => {
  const entries = Array.from({ length: 26 }, (_unused, index) => ({
    id: `page-${index}`,
    access_token: `token-${index}`,
  }));
  const { fetcher } = recordingFetcher(() => jsonResponse(accountsBody(entries)));
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "page_listing_oversized");
  }
});

Deno.test("only the opaque cursor is used and the provider next URL is never fetched", async () => {
  const { fetcher, calls } = recordingFetcher((_url, index) => {
    if (index === 0) {
      return jsonResponse(
        accountsBody([{ id: "page-other", access_token: "other-token" }], {
          cursors: { after: "CURSOR-ONE" },
          next: "https://evil.example.com/steal?access_token=secret",
        }),
      );
    }
    return jsonResponse(accountsBody([{ id: PAGE_ID, access_token: PAGE_TOKEN }]));
  });
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "found");
  assertEquals(calls.length, 2);
  assertEquals(calls[1].url.startsWith("https://graph.facebook.com/v22.0/me/accounts?"), true);
  assertEquals(calls[1].url.includes("after=CURSOR-ONE"), true);
  // The arbitrary host is never contacted.
  assertEquals(calls.some((call) => call.url.includes("evil.example.com")), false);
});

Deno.test("a repeated cursor ends the enumeration", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse(
      accountsBody([{ id: "page-other", access_token: "other-token" }], {
        cursors: { after: "CURSOR-ONE" },
      }),
    )
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "page_cursor_repeated");
  }
  assertEquals(calls.length, 2);
});

Deno.test("a next without a usable cursor is an incomplete enumeration", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse(
      accountsBody([{ id: "page-other", access_token: "other-token" }], {
        next: "https://graph.facebook.com/v22.0/me/accounts?after=SECRET",
      }),
    )
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "page_target_not_found");
  }
  assertEquals(calls.length, 1);
});

Deno.test("a hostile cursor is refused", async () => {
  for (const cursor of ["", "CURSOR\n", " CURSOR", "x".repeat(513)]) {
    const { fetcher } = recordingFetcher(() =>
      jsonResponse(
        accountsBody([{ id: "page-other", access_token: "other-token" }], {
          cursors: { after: cursor },
        }),
      )
    );
    const provider = createMetaPageReconciliationProvider({ fetcher });
    const outcome = await provider.findProtectedPage({
      capturedToken: USER_TOKEN,
      pageId: PAGE_ID,
      budget: budget(),
    });
    assertEquals(outcome.kind, "incomplete");
    if (outcome.kind === "incomplete") {
      assertEquals(outcome.reason, "page_target_not_found");
    }
  }
});

Deno.test("the listing stops at two pages and fifty candidates", async () => {
  const { fetcher, calls } = recordingFetcher((_url, index) =>
    jsonResponse(
      accountsBody([{ id: "page-other", access_token: "other-token" }], {
        cursors: { after: `CURSOR-${index}` },
      }),
    )
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.findProtectedPage({
    capturedToken: USER_TOKEN,
    pageId: PAGE_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "incomplete");
  if (outcome.kind === "incomplete") {
    assertEquals(outcome.reason, "page_listing_cap");
  }
  assertEquals(calls.length, 2);
});

// ---------------------------------------------------------------------------
// The Page proof
// ---------------------------------------------------------------------------

Deno.test("an Instagram Page must prove the exact Page and the exact Instagram identity", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    jsonResponse({ id: PAGE_ID, instagram_business_account: { id: INSTAGRAM_ID } })
  );
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.verifyPageIdentity({
    pageToken: PAGE_TOKEN,
    pageId: PAGE_ID,
    instagramUserId: INSTAGRAM_ID,
    budget: budget(),
  });
  assertEquals(outcome.kind, "verified");
  assertEquals(calls[0].url.includes("instagram_business_account"), true);
});

Deno.test("a Facebook Page asks only for the Page identity", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ id: PAGE_ID }));
  const provider = createMetaPageReconciliationProvider({ fetcher });
  const outcome = await provider.verifyPageIdentity({
    pageToken: PAGE_TOKEN,
    pageId: PAGE_ID,
    instagramUserId: null,
    budget: budget(),
  });
  assertEquals(outcome.kind, "verified");
  assertEquals(calls[0].url.includes("instagram_business_account"), false);
  assertEquals(calls[0].url.includes("fields=id"), true);
});

Deno.test("a wrong Page identity or a wrong Instagram identity is incomplete", async () => {
  const wrongPage = recordingFetcher(() => jsonResponse({ id: "page-other" }));
  const wrongPageProvider = createMetaPageReconciliationProvider({ fetcher: wrongPage.fetcher });
  const wrongPageOutcome = await wrongPageProvider.verifyPageIdentity({
    pageToken: PAGE_TOKEN,
    pageId: PAGE_ID,
    instagramUserId: INSTAGRAM_ID,
    budget: budget(),
  });
  assertEquals(wrongPageOutcome.kind, "incomplete");
  if (wrongPageOutcome.kind === "incomplete") {
    assertEquals(wrongPageOutcome.reason, "page_identity_mismatch");
  }

  const wrongInstagram = recordingFetcher(() =>
    jsonResponse({ id: PAGE_ID, instagram_business_account: { id: "ig-other" } })
  );
  const wrongInstagramProvider = createMetaPageReconciliationProvider({
    fetcher: wrongInstagram.fetcher,
  });
  const wrongInstagramOutcome = await wrongInstagramProvider.verifyPageIdentity({
    pageToken: PAGE_TOKEN,
    pageId: PAGE_ID,
    instagramUserId: INSTAGRAM_ID,
    budget: budget(),
  });
  assertEquals(wrongInstagramOutcome.kind, "incomplete");
  if (wrongInstagramOutcome.kind === "incomplete") {
    assertEquals(wrongInstagramOutcome.reason, "page_instagram_mismatch");
  }

  const missing = recordingFetcher(() => jsonResponse({ id: PAGE_ID }));
  const missingProvider = createMetaPageReconciliationProvider({ fetcher: missing.fetcher });
  const missingOutcome = await missingProvider.verifyPageIdentity({
    pageToken: PAGE_TOKEN,
    pageId: PAGE_ID,
    instagramUserId: INSTAGRAM_ID,
    budget: budget(),
  });
  assertEquals(missingOutcome.kind, "incomplete");
  if (missingOutcome.kind === "incomplete") {
    assertEquals(missingOutcome.reason, "page_instagram_missing");
  }
});

// ---------------------------------------------------------------------------
// The transport contract
// ---------------------------------------------------------------------------

Deno.test("every request refuses a redirect and carries one bounded deadline", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ id: PROVIDER_USER_ID }));
  const provider = createMetaPageReconciliationProvider({ fetcher });
  await provider.verifyUserSubject({
    capturedToken: USER_TOKEN,
    subject: PROVIDER_USER_ID,
    budget: budget(),
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].init?.redirect, "error");
  assertEquals(calls[0].init?.method, "GET");
});

Deno.test("the provider reserve keeps four seconds for the persistence", () => {
  let clock = 0;
  const bounded = createPageReconciliationBudget(24_000, () => clock);
  // 24s left minus the 4s reserve leaves 20s of provider time.
  assertEquals(bounded.takeProviderMs(4_000), 4_000);
  clock = 19_000;
  // 5s left minus the 4s reserve: one second of provider time.
  assertEquals(bounded.takeProviderMs(4_000), 1_000);
  clock = 20_000;
  // 4s left minus the 4s reserve: nothing is left.
  let exhausted = false;
  try {
    bounded.takeProviderMs(4_000);
  } catch {
    exhausted = true;
  }
  assertEquals(exhausted, true);
  // The persistence reserve itself is still available.
  assertEquals(bounded.takePersistenceMs(3_000), 3_000);
});

Deno.test("the total request ceiling is enforced", () => {
  const bounded = budget();
  for (let index = 0; index < PAGE_MAX_TOTAL_REQUESTS; index += 1) {
    bounded.countRequest("identity");
  }
  let refused = false;
  try {
    bounded.countRequest("identity");
  } catch {
    refused = true;
  }
  assertEquals(refused, true);
});

Deno.test("no token reaches a thrown error or a log line", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    const { fetcher } = recordingFetcher(() => {
      throw new Error(`transport failure ${USER_TOKEN}`);
    });
    const provider = createMetaPageReconciliationProvider({ fetcher });
    const outcome = await provider.verifyUserSubject({
      capturedToken: USER_TOKEN,
      subject: PROVIDER_USER_ID,
      budget: budget(),
    });
    assertEquals(outcome.kind, "incomplete");
    assertEquals(lines.join("\n").includes(USER_TOKEN), false);
    assertEquals(lines.join("\n").includes("graph.facebook.com"), false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});
