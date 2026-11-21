/**
 * The reconnect detection for a revoked Meta publishing grant.
 *
 * The fixture is an in-memory account table and a recording writer. The writer
 * applies every filter of the conditional update to the table's rows, so a row
 * of another owner, another platform, an inactive row, a row whose version moved
 * or a row that already carries the reconnect flag is matched by nothing.
 *
 * The marker below stands for the credential: it is in the provider's message,
 * in the request URL and in the storage failure, and no diagnostic, persisted
 * value or returned error may carry it.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createMetaPublishReauthObserver,
  META_PUBLISH_REAUTH_REASON,
  type MetaPublishReauthSnapshot,
  type MetaPublishReauthWriteRequest,
  type MetaPublishReauthWriter,
} from "./metaPublishReauth.ts";

const OWNER = "owner-a";
const OTHER_OWNER = "owner-b";
const INSTAGRAM_ACCOUNT = "account-instagram";
const FACEBOOK_ACCOUNT = "account-facebook";
const OTHER_OWNER_ACCOUNT = "account-other-owner";
const ROW_VERSION = "2026-11-21T10:00:00.123456+00:00";
const LATER_ROW_VERSION = "2026-11-21T10:05:00.987654+00:00";
const CREDENTIAL_MARKER = "fixture-a";
const FUTURE_EXPIRY = "2999-01-01T00:00:00+00:00";

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  is_active: boolean;
  needs_reauth: boolean | null;
  updated_at: string;
  token_expires_at: string;
  last_refresh_error: string | null;
}

/** Two owners, two rows of the first owner, and both native platforms. */
function fixtureRows(): AccountRow[] {
  return [
    { id: INSTAGRAM_ACCOUNT, user_id: OWNER, platform: "instagram", is_active: true, needs_reauth: false, updated_at: ROW_VERSION, token_expires_at: FUTURE_EXPIRY, last_refresh_error: null },
    { id: FACEBOOK_ACCOUNT, user_id: OWNER, platform: "facebook", is_active: true, needs_reauth: false, updated_at: ROW_VERSION, token_expires_at: FUTURE_EXPIRY, last_refresh_error: null },
    { id: OTHER_OWNER_ACCOUNT, user_id: OTHER_OWNER, platform: "instagram", is_active: true, needs_reauth: false, updated_at: ROW_VERSION, token_expires_at: FUTURE_EXPIRY, last_refresh_error: null },
  ];
}

interface RecordedWrite {
  filters: string[];
  request: MetaPublishReauthWriteRequest;
}

/** The filters of the conditional write, as the persistence request names them. */
function filtersFor(request: MetaPublishReauthWriteRequest): string[] {
  return [
    `id=eq.${request.accountId}`,
    `user_id=eq.${request.postOwnerId}`,
    `platform=eq.${request.platform}`,
    "is_active=eq.true",
    `updated_at=eq.${request.updatedAt}`,
    "or=(needs_reauth.is.null,needs_reauth.eq.false)",
  ];
}

/** Every filter of the write decides whether a row is matched. */
function matchesEveryFilter(row: AccountRow, request: MetaPublishReauthWriteRequest): boolean {
  return row.id === request.accountId &&
    row.user_id === request.postOwnerId &&
    row.platform === request.platform &&
    row.is_active === true &&
    row.updated_at === request.updatedAt &&
    (row.needs_reauth === null || row.needs_reauth === false);
}

function recordingWriter(
  rows: AccountRow[],
  failure: "none" | "resolved" | "rejected" | "timeout" = "none",
  beforeMatch?: () => void,
) {
  const writes: RecordedWrite[] = [];
  const write: MetaPublishReauthWriter = async (request) => {
    writes.push({ filters: filtersFor(request), request });
    if (failure === "rejected") throw new Error(`storage refused ${CREDENTIAL_MARKER}`);
    if (failure === "resolved") return { matched: 0, error: `storage refused ${CREDENTIAL_MARKER}` };
    if (failure === "timeout") {
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error(`storage timed out ${CREDENTIAL_MARKER}`)));
      });
    }
    beforeMatch?.();
    const matched = rows.filter((row) => matchesEveryFilter(row, request));
    for (const row of matched) {
      row.needs_reauth = true;
      row.last_refresh_error = META_PUBLISH_REAUTH_REASON;
    }
    return { matched: matched.length, error: null };
  };
  return { write, writes };
}

function revokedEnvelope(message = `Error validating access token: ${CREDENTIAL_MARKER}`) {
  return { error: { type: "OAuthException", code: 190, error_subcode: 458, message } };
}

function observerFor(
  write: MetaPublishReauthWriter,
  options: { snapshot?: Partial<MetaPublishReauthSnapshot>; requestToken?: string } = {},
) {
  const snapshot: MetaPublishReauthSnapshot = {
    accountId: INSTAGRAM_ACCOUNT,
    postOwnerId: OWNER,
    platform: "instagram",
    updatedAt: ROW_VERSION,
    accessToken: CREDENTIAL_MARKER,
    ...options.snapshot,
  };
  return createMetaPublishReauthObserver({
    snapshot,
    requestToken: options.requestToken ?? snapshot.accessToken,
    write,
    timeoutMs: 25,
  });
}

/** Everything the run said, so a diagnostic that carries the marker is found. */
function captureDiagnostics(): { lines: string[]; warnings: unknown[][]; restore: () => void } {
  const lines: string[] = [];
  const warnings: unknown[][] = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  const previousError = console.error;
  const record = (...message: unknown[]) => { lines.push(message.map((part) => String(part)).join(" ")); };
  console.log = record;
  console.warn = (...message: unknown[]) => {
    warnings.push(message);
    record(...message);
  };
  console.error = record;
  return { lines, warnings, restore: () => { console.log = previousLog; console.warn = previousWarn; console.error = previousError; } };
}

/** Fails a hung implementation instead of hanging the suite with it. */
function watchdog(ms: number): { expired: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the observation did not settle within ${ms} ms`)), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

/** Lets the queued rejections run, so one that nothing handles is reported. */
async function drainEventLoop(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("a revoked grant on a rejected request marks the account once", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 1);
  const marked = rows.find((row) => row.id === INSTAGRAM_ACCOUNT)!;
  assertEquals(marked.needs_reauth, true);
  assertEquals(marked.last_refresh_error, META_PUBLISH_REAUTH_REASON);
  assertEquals(marked.is_active, true);
  assertEquals(marked.token_expires_at, FUTURE_EXPIRY);
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 1, "Only the observed account may be marked");
});

Deno.test("the same envelope on a successful status still marks the account", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(200, revokedEnvelope());

  assertEquals(writes.length, 1);
  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, true);
});

Deno.test("a server error carrying the definitive fields still marks the account", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(503, revokedEnvelope());

  assertEquals(writes.length, 1);
  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, true);
});

Deno.test("a reply with a container id marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(200, { id: "container-1" });

  assertEquals(writes.length, 0);
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 0);
});

Deno.test("the provider's message alone marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { message: `Error validating access token: ${CREDENTIAL_MARKER}` } });

  assertEquals(writes.length, 0);
});

Deno.test("a code without the revoked-grant subcode marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { type: "OAuthException", code: 190, message: "invalid" } });

  assertEquals(writes.length, 0);
});

Deno.test("the revoked-grant subcode without its type and code marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { type: "GraphMethodException", code: 100, error_subcode: 458, message: "invalid" } });

  assertEquals(writes.length, 0);
});

Deno.test("numeric fields sent as text mark nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { type: "OAuthException", code: "190", error_subcode: "458", message: "invalid" } });

  assertEquals(writes.length, 0);
});

for (const code of [10, 200]) {
  Deno.test(`a permission error (code ${code}) marks nothing`, async () => {
    const rows = fixtureRows();
    const { write, writes } = recordingWriter(rows);
    const observe = observerFor(write);

    await observe(400, { error: { type: "OAuthException", code, message: "permission" } });

    assertEquals(writes.length, 0);
  });
}

Deno.test("a content rejection marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { code: 100, message: "Media type unsupported" } });

  assertEquals(writes.length, 0);
});

for (const code of [4, 17, 32, 613]) {
  Deno.test(`a throttled error (code ${code}) marks nothing`, async () => {
    const rows = fixtureRows();
    const { write, writes } = recordingWriter(rows);
    const observe = observerFor(write);

    await observe(400, { error: { code, message: "too many calls" } });

    assertEquals(writes.length, 0);
  });
}

for (const status of [408, 425, 429]) {
  Deno.test(`a retryable status (${status}) marks nothing`, async () => {
    const rows = fixtureRows();
    const { write, writes } = recordingWriter(rows);
    const observe = observerFor(write);

    await observe(status, { error: { code: 1, message: "try later" } });

    assertEquals(writes.length, 0);
  });
}

Deno.test("an explicit transient signal marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, { error: { code: 1, is_transient: true, message: "try later" } });

  assertEquals(writes.length, 0);
});

Deno.test("a generic server error marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(500, { error: { code: 2, message: "An unexpected error has occurred" } });

  assertEquals(writes.length, 0);
});

Deno.test("an unreadable reply marks nothing", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(0, undefined);
  await observe(400, "not json at all");

  assertEquals(writes.length, 0);
});

Deno.test("no diagnostic, persisted value or returned error carries the credential", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);
  const diagnostics = captureDiagnostics();
  try {
    await observe(400, revokedEnvelope());
  } finally {
    diagnostics.restore();
  }

  assertEquals(diagnostics.lines.join("\n").includes(CREDENTIAL_MARKER), false, "The provider's text must not reach a diagnostic");
  assertEquals(writes[0].filters.join(" ").includes(CREDENTIAL_MARKER), false, "The credential must not reach the write filters");
  assertEquals(JSON.stringify(writes[0].request).includes(CREDENTIAL_MARKER), false, "The credential must not reach the write request");
  assertEquals(JSON.stringify(rows).includes(CREDENTIAL_MARKER), false, "The credential must not reach the stored row");
});

Deno.test("a refresh between the failure and the write leaves the row untouched", async () => {
  const rows = fixtureRows();
  const row = rows.find((entry) => entry.id === INSTAGRAM_ACCOUNT)!;
  const { write, writes } = recordingWriter(rows, "none", () => { row.updated_at = LATER_ROW_VERSION; });
  const observe = observerFor(write);

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 1, "The observation asks, and the moved row version refuses it");
  assertEquals(row.needs_reauth, false, "A refreshed row keeps its own state");
});

Deno.test("a same-token reconnect between the failure and the write leaves the row untouched", async () => {
  const rows = fixtureRows();
  const row = rows.find((entry) => entry.id === INSTAGRAM_ACCOUNT)!;
  const { write, writes } = recordingWriter(rows, "none", () => {
    row.needs_reauth = false;
    row.updated_at = LATER_ROW_VERSION;
  });
  const observe = observerFor(write);

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 1);
  assertEquals(row.needs_reauth, false, "A reconnect that cleared the flag keeps it cleared");
});

Deno.test("a row of another owner is never marked", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write, { snapshot: { accountId: OTHER_OWNER_ACCOUNT } });

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 1, "The write is still asked for");
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 0, "The owner filter refuses another owner's row");
});

Deno.test("a row of another platform is never marked", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write, { snapshot: { accountId: FACEBOOK_ACCOUNT, platform: "instagram" } });

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 1);
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 0, "The platform filter refuses the Facebook row");
});

Deno.test("an inactive row is never marked", async () => {
  const rows = fixtureRows();
  rows.find((row) => row.id === INSTAGRAM_ACCOUNT)!.is_active = false;
  const { write } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, revokedEnvelope());

  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, false);
});

Deno.test("a legacy row with no reconnect flag is marked", async () => {
  const rows = fixtureRows();
  rows.find((row) => row.id === INSTAGRAM_ACCOUNT)!.needs_reauth = null;
  const { write } = recordingWriter(rows);
  const observe = observerFor(write);

  await observe(400, revokedEnvelope());

  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, true);
});

Deno.test("a repeated failure across invocations writes the flag once", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);

  await observerFor(write)(400, revokedEnvelope());
  await observerFor(write)(400, revokedEnvelope());

  assertEquals(writes.length, 2, "Each invocation asks once");
  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, true);
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 1);
});

Deno.test("an account without a row version is never marked", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write, { snapshot: { updatedAt: "" } });

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 0, "Without the row version there is nothing to fence the write with");
});

Deno.test("an unrelated update to the row leaves the observation unmatched", async () => {
  const rows = fixtureRows();
  const { write } = recordingWriter(rows);
  const observe = observerFor(write);
  rows.find((row) => row.id === INSTAGRAM_ACCOUNT)!.updated_at = LATER_ROW_VERSION;

  await observe(400, revokedEnvelope());

  assertEquals(rows.find((row) => row.id === INSTAGRAM_ACCOUNT)?.needs_reauth, false);
});

Deno.test("a substituted credential is never observed", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write, { requestToken: "fixture-b" });

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 0, "A request that used another credential says nothing about this row");
});

Deno.test("a late observation leaves a later timely reply eligible for the account write", async () => {
  let writes = 0;
  const observe = observerFor(async () => {
    writes++;
    return { matched: 1, error: null };
  });
  assertEquals(observe(400, revokedEnvelope(), Date.now() - 1), undefined);
  assertEquals(writes, 0);
  await observe(400, revokedEnvelope());
  assertEquals(writes, 1);
});

Deno.test("an unsupported platform is never observed", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write, { snapshot: { platform: "threads" } });

  await observe(400, revokedEnvelope());

  assertEquals(writes.length, 0);
});

Deno.test("parallel observations of the same failure write once", async () => {
  const rows = fixtureRows();
  const { write, writes } = recordingWriter(rows);
  const observe = observerFor(write);

  await Promise.all([
    observe(400, revokedEnvelope("one")),
    observe(400, revokedEnvelope("two")),
    observe(400, revokedEnvelope("three")),
  ]);

  assertEquals(writes.length, 1, "The children of one attempt share the write");
  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 1);
});

Deno.test("a refused write leaves the publish outcome intact and warns without the credential", async () => {
  const rows = fixtureRows();
  const { write } = recordingWriter(rows, "rejected");
  const observe = observerFor(write);
  const diagnostics = captureDiagnostics();
  try {
    await observe(400, revokedEnvelope());
  } finally {
    diagnostics.restore();
  }

  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 0);
  assertEquals(diagnostics.lines.some((line) => line.includes("meta_publish_reauth_write_failed")), true);
  assertEquals(diagnostics.lines.join("\n").includes(CREDENTIAL_MARKER), false);
});

Deno.test("a resolved storage error warns once and keeps the credential out of the warning", async () => {
  const rows = fixtureRows();
  const { write } = recordingWriter(rows, "resolved");
  const observe = observerFor(write);
  const diagnostics = captureDiagnostics();
  try {
    await observe(400, revokedEnvelope());
  } finally {
    diagnostics.restore();
  }

  assertEquals(diagnostics.lines.filter((line) => line.includes("meta_publish_reauth_write_failed")).length, 1);
  assertEquals(diagnostics.lines.join("\n").includes(CREDENTIAL_MARKER), false);
});

Deno.test("a write that never answers is abandoned without changing the outcome", async () => {
  const rows = fixtureRows();
  const { write } = recordingWriter(rows, "timeout");
  const observe = observerFor(write);
  const diagnostics = captureDiagnostics();
  try {
    await observe(400, revokedEnvelope());
  } finally {
    diagnostics.restore();
  }

  assertEquals(rows.filter((row) => row.needs_reauth === true).length, 0);
  assertEquals(diagnostics.lines.some((line) => line.includes("meta_publish_reauth_write_failed")), true);
  assertEquals(diagnostics.lines.join("\n").includes(CREDENTIAL_MARKER), false);
});

Deno.test("a write that ignores the abort does not hold the observation", async () => {
  const held = Promise.withResolvers<void>();
  const requests: MetaPublishReauthWriteRequest[] = [];
  const write: MetaPublishReauthWriter = async (request) => {
    requests.push(request);
    // The abort is ignored on purpose: the storage call is the one that must not hold the publish.
    await held.promise;
    return { matched: 1, error: null };
  };
  const observe = observerFor(write);
  const diagnostics = captureDiagnostics();
  const guard = watchdog(2_000);
  const expectedWarnings = [["meta_publish_reauth_write_failed", { account_id: INSTAGRAM_ACCOUNT, platform: "instagram" }]];

  try {
    await Promise.race([Promise.resolve(observe(400, revokedEnvelope())), guard.expired]);
    guard.cancel();

    assertEquals(requests.length, 1, "The account is written once");
    assertEquals(requests[0].signal.aborted, true, "The expiry aborts the write");
    assertEquals(diagnostics.warnings, expectedWarnings, "The expiry warns once with account and platform only");

    // The writer fails after the observation settled: it must warn about nothing, and Deno
    // must not find an unhandled rejection.
    held.reject(new Error(`the storage call failed after the expiry: ${CREDENTIAL_MARKER}`));
    await drainEventLoop();
    assertEquals(diagnostics.warnings, expectedWarnings, "A writer that fails late warns about nothing");
  } finally {
    guard.cancel();
    held.resolve();
    diagnostics.restore();
  }
});
