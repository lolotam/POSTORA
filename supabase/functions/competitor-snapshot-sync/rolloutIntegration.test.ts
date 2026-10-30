/**
 * The rollout exclusion proof of the COMPETITOR collection, end to end.
 *
 * WHAT THIS SUITE PROVES
 *
 *   1. THE REAL PATH. The registered handler of
 *      `supabase/functions/competitor-snapshot-sync/index.ts` is loaded and
 *      driven: it builds the REAL production store factory
 *      (`createCompetitorServiceStore`) and the REAL worker, and every
 *      statement it makes runs against a REAL disposable Postgres - the
 *      accepted migrations, the accepted functions, the accepted fences.
 *      Only the driver and the provider transport are replaced: the driver
 *      by a thin SQL adapter, the provider by a fake Meta transport with no
 *      public egress.
 *
 *   2. THE ADMISSION, IN EVERY ACTIVATION STAGE. While the competitors are
 *      off, nothing is called. With exactly one watchlist allowlisted and
 *      pinned to exactly one viewer, ONLY that pair is called: the other
 *      watchlist of the SAME owner, the watchlist of ANOTHER owner, the
 *      unapproved alternate viewer of the same owner and the foreign viewer
 *      all receive EXACTLY ZERO provider requests. With the competitors on
 *      `all`, every otherwise eligible owned watchlist is called.
 *
 *   3. THE PIN. The approved pair is the pair that is called: the request
 *      carries the pinned viewer's identity AND its credential, and no
 *      substitute viewer is ever used.
 *
 *   4. THE ROLLBACK. The policy is switched off DURING an active lease: the
 *      next permit is refused, no further request leaves the process, the
 *      write after the exclusion is refused, the job settles, and the
 *      stored results survive. Re-admitting the target resumes only that
 *      target, and the history and report rows from before are kept.
 *
 *   5. THE FAILURE SHAPES. A missing policy row, an unreadable policy and
 *      an audit write that does not commit each surface as a refusal or a
 *      failure. None of them is an empty success. The unreadable policy and
 *      the audit failure are asked at the PERMIT, after the lease was
 *      granted: an unavailable permit is not permission, the run stops
 *      before the next admitted watchlist, and no snapshot is stored.
 *
 *   6. THE NEGATIVE CONTROL. The same scenario runs against a COPY of the
 *      production source whose permit call was removed. The copy lets a
 *      request through that the real source refuses, so the detector of this
 *      suite is proved to be sensitive rather than vacuous. The committed
 *      source is never modified.
 *
 * WHY A MISSING RUNTIME FAILS THIS SUITE
 *
 *   The runtime is resolved before any test is declared. When
 *   `ROLLOUT_IT_CONTAINER` or `ROLLOUT_IT_DB` is missing, every test in this
 *   file fails with the message that names both variables. There is no skip,
 *   and there is no zero-test pass.
 *
 * WHY NO PRODUCTION SECRET IS READ
 *
 *   The bearer, the keys and the credential tokens are synthetic strings
 *   created here. The account rows carry a BROWSER-READABLE token as well,
 *   and the suite proves that the provider request never carries it.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FakeMetaTransport,
  acquireRolloutLease,
  createRolloutBridge,
  installRolloutBridge,
  releaseRolloutLease,
  resolveRolloutRuntime,
  rolloutDriverStubPlugin,
  type RecordedProviderCall,
  type RolloutRuntime,
} from "../_shared/rolloutIntegrationTestSupport.ts";

const testFilePath = fileURLToPath(import.meta.url);
const FUNCTIONS_ROOT = dirname(dirname(testFilePath));
const REPO_ROOT = dirname(dirname(FUNCTIONS_ROOT));
const require = createRequire(join(REPO_ROOT, "package.json"));
const { build } = require("esbuild") as {
  build: (options: Record<string, unknown>) => Promise<unknown>;
};

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-rollout-competitor-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-rollout-competitor-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const CRON_SECRET = "synthetic-cron-secret";

// ---------------------------------------------------------------------------
// The identities
// ---------------------------------------------------------------------------

/** The pilot owner. */
const OWNER_A = "7a100000-0000-4000-8000-000000000001";
/** Another tenant. */
const OWNER_D = "7b100000-0000-4000-8000-000000000002";

/** The approved watchlist of owner A. */
const WATCHLIST_A = "7c100000-0000-4000-8000-000000000001";
/** Another watchlist of the SAME owner. */
const WATCHLIST_B = "7c100000-0000-4000-8000-000000000002";
/** A watchlist of ANOTHER tenant. */
const WATCHLIST_D = "7d100000-0000-4000-8000-000000000001";

/** The pinned viewer of owner A. */
const VIEWER_1 = "7e100000-0000-4000-8000-000000000001";
/** Another approved-shape viewer of owner A. It is NOT the pin. */
const VIEWER_2 = "7e100000-0000-4000-8000-000000000002";
/** The viewer of ANOTHER tenant. */
const VIEWER_D = "7e100000-0000-4000-8000-000000000003";

const CRED_VIEWER_1 = "7f100000-0000-4000-8000-000000000001";
const CRED_VIEWER_2 = "7f100000-0000-4000-8000-000000000002";
const CRED_VIEWER_D = "7f100000-0000-4000-8000-000000000003";

const IG_VIEWER_1 = "ig-viewer-1";
const IG_VIEWER_2 = "ig-viewer-2";
const IG_VIEWER_D = "ig-viewer-d";

const HANDLE_A = "comp_rollout_a";
const HANDLE_B = "comp_rollout_b";
const HANDLE_D = "comp_rollout_d";

/**
 * Stable job ids, so a claim of the two admitted watchlists starts with A.
 *
 * The claim orders by due time and then by job id. These ids sort A, B, D.
 */
const JOB_A = "7c200000-0000-4000-8000-000000000001";
const JOB_B = "7c200000-0000-4000-8000-000000000002";
const JOB_D = "7c200000-0000-4000-8000-000000000003";

const TOKEN_VIEWER_1 = "synthetic-protected-token-viewer-1";
const TOKEN_VIEWER_2 = "synthetic-protected-token-viewer-2";
const TOKEN_VIEWER_D = "synthetic-protected-token-viewer-d";

const BROWSER_TOKEN_1 = "synthetic-browser-readable-token-viewer-1";
const BROWSER_TOKEN_2 = "synthetic-browser-readable-token-viewer-2";
const BROWSER_TOKEN_D = "synthetic-browser-readable-token-viewer-d";

/** Every watchlist, with the handle its collection addresses. */
const WATCHLISTS = [
  { id: WATCHLIST_A, owner: OWNER_A, handle: HANDLE_A },
  { id: WATCHLIST_B, owner: OWNER_A, handle: HANDLE_B },
  { id: WATCHLIST_D, owner: OWNER_D, handle: HANDLE_D },
] as const;

/** Every viewer, with the identity the provider call carries. */
const VIEWERS = [
  { id: VIEWER_1, owner: OWNER_A, igUserId: IG_VIEWER_1, token: TOKEN_VIEWER_1 },
  { id: VIEWER_2, owner: OWNER_A, igUserId: IG_VIEWER_2, token: TOKEN_VIEWER_2 },
  { id: VIEWER_D, owner: OWNER_D, igUserId: IG_VIEWER_D, token: TOKEN_VIEWER_D },
] as const;

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

let runtime: RolloutRuntime | null = null;
let runtimeFailure: Error | null = null;

try {
  runtime = resolveRolloutRuntime();
} catch (error) {
  runtimeFailure = error instanceof Error ? error : new Error(String(error));
}

/** The runtime, or the failure that says why there is none. */
function requireRuntime(): RolloutRuntime {
  if (runtime === null) {
    throw runtimeFailure ?? new Error("The rollout integration runtime is missing.");
  }
  return runtime;
}

/** The lease holder of this run. */
const LEASE_HOLDER = `competitor-rollout-${crypto.randomUUID()}`;

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SQL = `
INSERT INTO auth.users (id, email)
VALUES
  ('${OWNER_A}', 'igrollout-it-comp-owner-a@example.invalid'),
  ('${OWNER_D}', 'igrollout-it-comp-owner-d@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username,
   access_token, ig_auth_type, is_active, needs_reauth, connected_at)
VALUES
  ('${VIEWER_1}', '${OWNER_A}', 'instagram', '${IG_VIEWER_1}', 'igrollout_it_v1',
   '${BROWSER_TOKEN_1}', 'facebook_page', true, false, now() - interval '3 days'),
  ('${VIEWER_2}', '${OWNER_A}', 'instagram', '${IG_VIEWER_2}', 'igrollout_it_v2',
   '${BROWSER_TOKEN_2}', 'facebook_page', true, false, now() - interval '2 days'),
  ('${VIEWER_D}', '${OWNER_D}', 'instagram', '${IG_VIEWER_D}', 'igrollout_it_vd',
   '${BROWSER_TOKEN_D}', 'facebook_page', true, false, now() - interval '1 day');

INSERT INTO public.instagram_account_capabilities
  (social_account_id, user_id, platform, login_kind, permission_read_state,
   granted_scopes, scopes_read_at, last_read_failed_at, credential_generation)
VALUES
  ('${VIEWER_1}', '${OWNER_A}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 3),
  ('${VIEWER_2}', '${OWNER_A}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 2),
  ('${VIEWER_D}', '${OWNER_D}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 1);

INSERT INTO public.facebook_user_credentials
  (id, user_id, token, revision, lifecycle, token_expires_at, provenance_source)
VALUES
  ('${CRED_VIEWER_1}', '${OWNER_A}', '${TOKEN_VIEWER_1}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential'),
  ('${CRED_VIEWER_2}', '${OWNER_A}', '${TOKEN_VIEWER_2}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential'),
  ('${CRED_VIEWER_D}', '${OWNER_D}', '${TOKEN_VIEWER_D}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential');

INSERT INTO public.facebook_user_credential_bindings
  (social_account_id, user_id, platform, credential_id, evidence_source)
VALUES
  ('${VIEWER_1}', '${OWNER_A}', 'instagram', '${CRED_VIEWER_1}',
   'migrated_instagram_account_credential'),
  ('${VIEWER_2}', '${OWNER_A}', 'instagram', '${CRED_VIEWER_2}',
   'migrated_instagram_account_credential'),
  ('${VIEWER_D}', '${OWNER_D}', 'instagram', '${CRED_VIEWER_D}',
   'migrated_instagram_account_credential');

INSERT INTO public.competitor_watchlist
  (id, user_id, platform, username, label, is_active, status)
VALUES
  ('${WATCHLIST_A}', '${OWNER_A}', 'instagram', '${HANDLE_A}',
   'Synthetic watchlist A', true, 'pending'),
  ('${WATCHLIST_B}', '${OWNER_A}', 'instagram', '${HANDLE_B}',
   'Synthetic watchlist B', true, 'pending'),
  ('${WATCHLIST_D}', '${OWNER_D}', 'instagram', '${HANDLE_D}',
   'Synthetic watchlist D', true, 'pending');

INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic harness master switch for the rollout integration suite.'),
  ('credential_facebook_user_mode', '"legacy"'::jsonb,
   'Synthetic harness credential mode for the rollout integration suite.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;

const TEARDOWN_SQL = `
DELETE FROM public.competitor_capture_coverage
 WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');
DELETE FROM public.competitor_media_snapshots
 WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');
DELETE FROM public.competitor_profile_snapshots
 WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');
DELETE FROM public.instagram_collection_job_operations
 WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                   WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}'));
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                   WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}'));
DELETE FROM public.instagram_collection_jobs
 WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');
DELETE FROM public.competitor_watchlist
 WHERE id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');
DELETE FROM public.facebook_user_credential_bindings
 WHERE social_account_id IN ('${VIEWER_1}', '${VIEWER_2}', '${VIEWER_D}');
DELETE FROM public.facebook_user_credentials
 WHERE id IN ('${CRED_VIEWER_1}', '${CRED_VIEWER_2}', '${CRED_VIEWER_D}');
DELETE FROM public.instagram_account_capabilities
 WHERE social_account_id IN ('${VIEWER_1}', '${VIEWER_2}', '${VIEWER_D}');
DELETE FROM public.social_accounts
 WHERE id IN ('${VIEWER_1}', '${VIEWER_2}', '${VIEWER_D}');
DELETE FROM auth.users WHERE id IN ('${OWNER_A}', '${OWNER_D}');
`;

/**
 * The server-controlled settings the suite writes.
 *
 * The suite OWNS a disposable database, but it still leaves that database
 * exactly as it found it: the settings it overwrites are captured before
 * the fixture is installed and restored afterwards.
 */
const SETTINGS_KEYS = [
  "collection_instagram_insights_enabled",
  "credential_facebook_user_mode",
  "collection_instagram_rollout_policy",
] as const;

let settingsSnapshot: Record<string, string | null> | null = null;

/** Captures the settings the fixture is about to overwrite. */
async function captureSettings(): Promise<void> {
  const keys = SETTINGS_KEYS.map((key) => `'${key}'`).join(", ");
  const rows = await requireRuntime().queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT key, to_jsonb(value)::text AS value ` +
      `FROM public.app_settings WHERE key IN (${keys})) AS picked;`,
  );
  const snapshot: Record<string, string | null> = {};
  for (const key of SETTINGS_KEYS) snapshot[key] = null;
  for (const row of rows) {
    const record = row as { key: string; value: string | null };
    snapshot[record.key] = record.value;
  }
  settingsSnapshot = snapshot;
}

/** Restores the settings the fixture overwrote. */
async function restoreSettings(): Promise<void> {
  if (settingsSnapshot === null) return;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(settingsSnapshot)) {
    if (value === null) {
      parts.push(`DELETE FROM public.app_settings WHERE key = '${key}';`);
    } else {
      parts.push(
        `INSERT INTO public.app_settings (key, value, description) ` +
          `VALUES ('${key}', '${value.replaceAll("'", "''")}'::jsonb, ` +
          `'Restored by the rollout integration suite.') ` +
          `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
      );
    }
  }
  await requireRuntime().exec(parts.join("\n"));
}

/** The policy document of one activation stage. */
function policyDocument(
  ownerMode: "off" | "allowlist" | "all" = "off",
  competitorMode: "off" | "allowlist" | "all" = "off",
): string {
  const ownerIds = ownerMode === "allowlist" ? [VIEWER_1] : [];
  const competitorTargets = competitorMode === "allowlist"
    ? [{ watchlist_id: WATCHLIST_A, viewer_social_account_id: VIEWER_1 }]
    : [];
  return JSON.stringify({
    version: 1,
    owners: { mode: ownerMode, account_ids: ownerIds },
    competitors: { mode: competitorMode, targets: competitorTargets },
  });
}

/** Writes the policy document. */
async function setPolicy(document: string): Promise<void> {
  const sql = document.replaceAll("'", "''");
  await requireRuntime().exec(
    `INSERT INTO public.app_settings (key, value, description) ` +
      `VALUES ('collection_instagram_rollout_policy', '${sql}'::jsonb, ` +
      `'Synthetic harness policy.') ` +
      `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
  );
}

/** Removes the policy row entirely. */
async function removePolicy(): Promise<void> {
  await requireRuntime().exec(
    `DELETE FROM public.app_settings WHERE key = 'collection_instagram_rollout_policy';`,
  );
}

/** An allowlist of A and B, both pinned to the approved viewer. */
function admittedPairPolicy(): string {
  return JSON.stringify({
    version: 1,
    owners: { mode: "off", account_ids: [] },
    competitors: {
      mode: "allowlist",
      targets: [
        { watchlist_id: WATCHLIST_A, viewer_social_account_id: VIEWER_1 },
        { watchlist_id: WATCHLIST_B, viewer_social_account_id: VIEWER_1 },
      ],
    },
  });
}

/**
 * Seeds one pending job per watchlist, with ids that claim in watchlist order.
 */
async function seedRankedCompetitorJobs(): Promise<void> {
  const rows = [
    [JOB_A, WATCHLIST_A, OWNER_A],
    [JOB_B, WATCHLIST_B, OWNER_A],
    [JOB_D, WATCHLIST_D, OWNER_D],
  ];
  const values = rows.map(([id, watchlist, owner]) =>
    `('${id}', '${owner}', 'competitor', '${watchlist}', '${watchlist}', ` +
    `(now() AT TIME ZONE 'Asia/Kuwait')::date, 'queued', now() - interval '1 day', 0, 1)`
  ).join(",\n  ");

  await requireRuntime().exec(
    `INSERT INTO public.instagram_collection_jobs ` +
      `(id, user_id, target_kind, target_id, watchlist_id, captured_on, ` +
      `status, due_at, attempts, job_generation) ` +
      `VALUES ${values};`,
  );
}

/** The job row of one watchlist. */
async function competitorJob(watchlistId: string): Promise<{
  status: string;
  attempts: number;
  last_reason_code: string | null;
  context_viewer_social_account_id: string | null;
}> {
  const rows = await requireRuntime().queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT status, attempts, last_reason_code, ` +
      `context_viewer_social_account_id ` +
      `FROM public.instagram_collection_jobs ` +
      `WHERE watchlist_id = '${watchlistId}') AS picked;`,
  );
  assertEquals(rows.length, 1, `expected one job for ${watchlistId}`);
  return rows[0] as {
    status: string;
    attempts: number;
    last_reason_code: string | null;
    context_viewer_social_account_id: string | null;
  };
}

/** Profile snapshots plus coverage rows. Both are the stored collection. */
async function storedResultCount(watchlistId: string): Promise<number> {
  const profiles = Number(await requireRuntime().queryJson(
    `SELECT count(*)::int FROM public.competitor_profile_snapshots ` +
      `WHERE watchlist_id = '${watchlistId}';`,
  ));
  const coverage = Number(await requireRuntime().queryJson(
    `SELECT count(*)::int FROM public.competitor_capture_coverage ` +
      `WHERE watchlist_id = '${watchlistId}';`,
  ));
  return profiles + coverage;
}

/** The history and report rows of one watchlist, in stable order. */
async function historyRows(
  table: "competitor_profile_snapshots" | "competitor_capture_coverage",
  watchlistId: string,
): Promise<Array<{ id: string; captured_at: string }>> {
  const rows = await requireRuntime().queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT id::text AS id, captured_at::text AS captured_at ` +
      `FROM public.${table} WHERE watchlist_id = '${watchlistId}' ORDER BY id) AS picked;`,
  );
  return rows as Array<{ id: string; captured_at: string }>;
}

/**
 * Seeds one pending competitor job per watchlist.
 *
 * The rows are written DIRECTLY, so they are PRE-EXISTING pending jobs for
 * every watchlist, admitted or not.
 */
async function seedCompetitorJobs(): Promise<void> {
  const values = WATCHLISTS.map((watchlist) =>
    `('${watchlist.owner}', 'competitor', '${watchlist.id}', '${watchlist.id}', ` +
    `(now() AT TIME ZONE 'Asia/Kuwait')::date, 'queued', now() - interval '1 day', 0, 1)`
  ).join(",\n  ");

  await requireRuntime().exec(
    `INSERT INTO public.instagram_collection_jobs ` +
      `(user_id, target_kind, target_id, watchlist_id, captured_on, ` +
      `status, due_at, attempts, job_generation) ` +
      `VALUES ${values};`,
  );
}

/** Removes every competitor job of the fixture. */
async function clearCompetitorJobs(): Promise<void> {
  await requireRuntime().exec(
    `DELETE FROM public.instagram_collection_jobs ` +
      `WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');`,
  );
}

/** Removes every stored result of the fixture. */
async function clearResults(): Promise<void> {
  await requireRuntime().exec(
    `DELETE FROM public.competitor_capture_coverage ` +
      `WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');`,
  );
  await requireRuntime().exec(
    `DELETE FROM public.competitor_profile_snapshots ` +
      `WHERE watchlist_id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');`,
  );
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

type RouteHandler = (request: Request) => Response | Promise<Response>;

const bundles = new Map<string, string>();
let importSeq = 0;

/** Bundles one composition root and captures the handler it registers. */
async function loadRoute(functionsRoot: string = FUNCTIONS_ROOT): Promise<RouteHandler> {
  const cached = bundles.get(functionsRoot);
  if (cached !== undefined && cached !== "") return await importHandler(cached);

  const outfile = `${BUNDLE_DIR}/competitor-${++importSeq}.mjs`;
  await build({
    entryPoints: [join(functionsRoot, "competitor-snapshot-sync/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
    plugins: [rolloutDriverStubPlugin()],
  });
  bundles.set(functionsRoot, outfile);
  return await importHandler(outfile);
}

async function importHandler(outfile: string): Promise<RouteHandler> {
  let handler: RouteHandler | null = null;
  const previousServe = Deno.serve;
  Deno.serve = ((registered: RouteHandler) => {
    handler = registered;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  }) as typeof Deno.serve;

  try {
    await import(`${pathToFileURL(outfile).href}?case=${++importSeq}`);
  } finally {
    Deno.serve = previousServe;
  }

  if (handler === null) {
    throw new Error("competitor-snapshot-sync did not register a request handler");
  }
  return handler;
}

// ---------------------------------------------------------------------------
// The transport and the bridge
// ---------------------------------------------------------------------------

const meta = new FakeMetaTransport();

/** The structured events the worker logged during one run. */
interface WorkerLogEvent {
  readonly event?: string;
  readonly outcome?: string;
  readonly reasonCode?: string;
  readonly watchlistId?: string;
  readonly [key: string]: unknown;
}

let removeBridge: (() => void) | null = null;

/**
 * The bridge configuration.
 *
 * The `onRpc` hook is how a scenario changes the world BETWEEN two
 * statements of the production path: the exclusion is applied after the
 * viewer was attached and before the permit was asked, which is exactly the
 * window the authorization instant defines.
 */
const bridgeConfig: {
  serviceRoleKey: string;
  bearerSubjects: Record<string, string>;
  onRpc?: (name: string) => void | Promise<void>;
} = { serviceRoleKey: SERVICE_ROLE_KEY, bearerSubjects: {} };

function installBridge(): void {
  if (removeBridge !== null) return;
  removeBridge = installRolloutBridge(
    createRolloutBridge(requireRuntime()),
    bridgeConfig,
  );
}

/** Captures the worker's structured log events while `work` runs. */
async function captureLogs(
  work: () => Promise<void>,
): Promise<WorkerLogEvent[]> {
  const events: WorkerLogEvent[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    for (const argument of args) {
      if (typeof argument !== "string") continue;
      const trimmed = argument.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed) as WorkerLogEvent);
      } catch {
        // A log line that is not a structured event is not evidence.
      }
    }
  };
  try {
    await work();
  } finally {
    console.log = original;
  }
  return events;
}

/** The drain request of the registered route. */
function drainRequest(): Request {
  return new Request(
    "https://api.postora.invalid/functions/v1/competitor-snapshot-sync",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ mode: "all" }),
    },
  );
}

/** The body of one drain. The worker summary is returned as it is. */
interface DrainBody {
  readonly claimed: number;
  readonly processed: number;
  readonly completed: number;
  readonly abandoned: number;
  readonly stoppedEarly: boolean;
  readonly jobs: ReadonlyArray<{
    readonly jobId: string;
    readonly watchlistId: string;
    readonly outcome: string;
    readonly reasonCode: string | null;
  }>;
}

/** Drives the real registered route once and returns its body. */
async function drain(handler: RouteHandler): Promise<DrainBody> {
  const response = await handler(drainRequest());
  assertEquals(response.status, 200);
  return (await response.json()) as DrainBody;
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/**
 * The breach detector.
 *
 * It names every recorded request that addressed an excluded identity. It
 * is the assertion the whole suite rests on, so the negative control runs it
 * against a source whose guard was removed and proves that it CAN fail.
 */
function detectExclusionBreach(
  calls: readonly RecordedProviderCall[],
  excludedHandles: readonly string[],
  fromIndex = 0,
): string[] {
  return calls
    .slice(fromIndex)
    .filter((call) => call.handle !== null && excludedHandles.includes(call.handle))
    .map((call) => `${call.kind}:${call.handle}:${call.target}`);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

Deno.test("the rollout integration runtime is configured", () => {
  const configured = requireRuntime();
  assert(configured.container !== "", "the container name is configured");
  assert(configured.database !== "", "the database name is configured");
});

Deno.test("the fixtures are installed and the route is registered", async () => {
  const active = requireRuntime();
  await captureSettings();
  await active.exec(`BEGIN;\n${FIXTURE_SQL}\nCOMMIT;`);

  installBridge();
  meta.install();

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("CRON_SECRET", CRON_SECRET);

  const handler = await loadRoute();
  assert(typeof handler === "function", "the route registered a handler");
});

Deno.test("every activation stage collects only the admitted pairs", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  const stages: Array<{
    readonly name: string;
    readonly policy: string;
    readonly admitted: readonly string[];
    readonly pinned: string | null;
  }> = [
    { name: "competitors off", policy: policyDocument(), admitted: [], pinned: null },
    {
      name: "one watchlist pinned to one viewer",
      policy: policyDocument("off", "allowlist"),
      admitted: [WATCHLIST_A],
      pinned: VIEWER_1,
    },
    {
      name: "competitors all",
      policy: policyDocument("off", "all"),
      admitted: [WATCHLIST_A, WATCHLIST_B, WATCHLIST_D],
      pinned: null,
    },
  ];

  for (const stage of stages) {
    await clearCompetitorJobs();
    await clearResults();
    await setPolicy(stage.policy);
    await seedCompetitorJobs();
    meta.reset();

    const body = await drain(handler);

    const excludedHandles = WATCHLISTS
      .filter((watchlist) => !stage.admitted.includes(watchlist.id))
      .map((watchlist) => watchlist.handle);

    assertEquals(
      detectExclusionBreach(meta.calls, excludedHandles),
      [],
      `${stage.name}: an excluded watchlist received a provider request`,
    );

    for (const watchlist of WATCHLISTS) {
      const calls = meta.calls.filter((call) => call.handle === watchlist.handle);
      if (stage.admitted.includes(watchlist.id)) {
        assert(
          calls.length > 0,
          `${stage.name}: the admitted watchlist ${watchlist.id} received no provider request`,
        );
        for (const call of calls) {
          const owner = watchlist.owner === OWNER_A ? OWNER_A : OWNER_D;
          const allowed = VIEWERS.filter((viewer) => viewer.owner === owner);
          assert(
            allowed.some((viewer) => viewer.igUserId === call.target),
            `${stage.name}: the request for ${watchlist.handle} used a viewer of another owner`,
          );
          if (stage.pinned !== null) {
            const pinned = VIEWERS.find((viewer) => viewer.id === stage.pinned);
            assert(
              pinned !== undefined && call.target === pinned.igUserId,
              `${stage.name}: the request for ${watchlist.handle} did not use the pinned viewer`,
            );
            assertEquals(
              call.accessToken,
              pinned.token,
              `${stage.name}: the request for ${watchlist.handle} used another credential`,
            );
          }
        }
      } else {
        assertEquals(
          calls.length,
          0,
          `${stage.name}: the excluded watchlist ${watchlist.id} was called`,
        );
      }
    }

    // The browser-readable account column is never the credential.
    for (const call of meta.calls) {
      assert(
        !call.accessToken.startsWith("synthetic-browser-readable-token"),
        `${stage.name}: a provider request carried the browser-readable token`,
      );
    }

    // The stored results follow the admission exactly.
    for (const watchlist of WATCHLISTS) {
      const snapshots = Number(await active.queryJson(
        `SELECT count(*)::int FROM public.competitor_profile_snapshots ` +
          `WHERE watchlist_id = '${watchlist.id}';`,
      ));
      if (stage.admitted.includes(watchlist.id)) {
        assert(
          snapshots > 0,
          `${stage.name}: the admitted watchlist ${watchlist.id} stored no result`,
        );
      } else {
        assertEquals(
          snapshots,
          0,
          `${stage.name}: the excluded watchlist ${watchlist.id} stored a result`,
        );
      }
    }

    assertEquals(
      body.claimed,
      stage.admitted.length,
      `${stage.name}: the claim returned the wrong number of jobs`,
    );
  }
});

Deno.test("the unapproved alternate viewer is never used", async () => {
  const handler = await loadRoute();
  installBridge();

  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(policyDocument("off", "allowlist"));
  await seedCompetitorJobs();
  meta.reset();

  await drain(handler);

  const calls = meta.calls.filter((call) => call.handle === HANDLE_A);
  assertEquals(calls.length, 1, "the approved pair was not called exactly once");
  assertEquals(
    calls[0].target,
    IG_VIEWER_1,
    "the approved watchlist was collected through a substitute viewer",
  );
  assertEquals(
    meta.callsFor(IG_VIEWER_2).length,
    0,
    "the unapproved alternate viewer was called",
  );
});

Deno.test("the next permit after the exclusion is refused", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(policyDocument("off", "allowlist"));
  await seedCompetitorJobs();
  meta.reset();

  // The exclusion is applied AFTER the viewer was attached and BEFORE the
  // permit is asked: the credential read is the statement in between.
  let switched = false;
  bridgeConfig.onRpc = async (name) => {
    if (switched || name !== "read_facebook_user_account_credential") return;
    switched = true;
    await setPolicy(policyDocument());
  };

  const events = await captureLogs(async () => {
    await drain(handler);
  });
  bridgeConfig.onRpc = undefined;

  assert(switched, "the exclusion was never applied during the lease");
  assertEquals(
    meta.calls.length,
    0,
    "a request left the process after the exclusion",
  );

  const refusal = events.find((event) =>
    event.event === "competitor_provider_call_refused" ||
    event.event === "competitor_admission_refused"
  );
  assert(refusal !== undefined, "the next permit was not refused");

  const snapshots = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.competitor_profile_snapshots ` +
      `WHERE watchlist_id = '${WATCHLIST_A}';`,
  ));
  assertEquals(snapshots, 0, "the excluded watchlist stored a result");

  // --- Quiescence ----------------------------------------------------------
  meta.reset();
  const quiescent = await drain(handler);
  assertEquals(
    meta.calls.length,
    0,
    "a request left the process after the work had settled",
  );
  assertEquals(quiescent.claimed, 0, "the settled work was claimed again");
});

Deno.test("the write after the exclusion is refused and the work settles", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(policyDocument("off", "allowlist"));
  await seedCompetitorJobs();
  meta.reset();

  // The exclusion is applied DURING the request. The request was already
  // authorized; the write that follows it is refused.
  let switched = false;
  let boundary = 0;
  meta.setHook(async () => {
    if (switched) return;
    switched = true;
    boundary = meta.calls.length;
    await setPolicy(policyDocument());
  });

  const events = await captureLogs(async () => {
    await drain(handler);
  });
  meta.setHook(null);

  assert(switched, "the exclusion was never applied during the lease");
  assertEquals(
    detectExclusionBreach(meta.calls, [HANDLE_A], boundary),
    [],
    "a request left the process after the exclusion",
  );

  const abandoned = events.find((event) =>
    event.event === "competitor_job_abandoned" ||
    event.outcome === "abandoned"
  );
  assert(abandoned !== undefined, "the excluded work did not settle");

  const snapshots = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.competitor_profile_snapshots ` +
      `WHERE watchlist_id = '${WATCHLIST_A}';`,
  ));
  assertEquals(snapshots, 0, "the write after the exclusion was stored");

  const jobs = await active.queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT status FROM public.instagram_collection_jobs ` +
      `WHERE watchlist_id = '${WATCHLIST_A}') AS picked;`,
  );
  assertEquals(
    (jobs[0] as { status: string }).status,
    "leased",
    "the refused job did not settle",
  );
});

Deno.test("a missing policy row refuses the work and never collects", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearCompetitorJobs();
  await clearResults();
  await removePolicy();
  await seedCompetitorJobs();
  meta.reset();

  const auditsBefore = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.system_logs ` +
      `WHERE source = 'instagram-collection-rollout' ` +
      `AND metadata ->> 'event' = 'collection_claim_refused' ` +
      `AND metadata ->> 'reason_code' = 'collection_not_eligible';`,
  ));

  const body = await drain(handler);

  assertEquals(meta.calls.length, 0, "a missing policy let a request through");
  assertEquals(body.claimed, 0, "a missing policy leased a job");
  assertEquals(body.completed, 0, "a missing policy completed a job");
  assertEquals(body.processed, 0, "a missing policy processed a job");
  assertEquals(body.jobs.length, 0, "a missing policy reported a job");
  for (const watchlistId of [WATCHLIST_A, WATCHLIST_B, WATCHLIST_D]) {
    const job = await competitorJob(watchlistId);
    assertEquals(job.status, "queued", "a missing policy changed a job");
    assertEquals(job.attempts, 0, "a missing policy attempted a job");
    assertEquals(job.last_reason_code, null, "a missing policy stored a success reason");
    assertEquals(await storedResultCount(watchlistId), 0, "a missing policy stored a result");
  }
  const auditsAfter = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.system_logs ` +
      `WHERE source = 'instagram-collection-rollout' ` +
      `AND metadata ->> 'event' = 'collection_claim_refused' ` +
      `AND metadata ->> 'reason_code' = 'collection_not_eligible';`,
  ));
  assert(auditsAfter > auditsBefore, "the missing policy was not audited as a refusal");
});

Deno.test("an unreadable policy fails the run and never collects", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  // --- The claim cannot read the policy -----------------------------------
  await clearCompetitorJobs();
  await clearResults();
  await setPolicy('{"version":1,"owners":{"mode":"nonsense"}}');
  await seedCompetitorJobs();
  meta.reset();

  const claimed = { body: null as DrainBody | null };
  const events = await captureLogs(async () => {
    claimed.body = await drain(handler);
  });

  assertEquals(meta.calls.length, 0, "an unreadable policy let a request through");
  assert(
    events.some((event) => event.event === "competitor_claim_abandoned"),
    "the unreadable policy did not fail the claim",
  );
  assert(claimed.body !== null, "the claim drain returned no body");
  assertEquals(claimed.body.stoppedEarly, true, "an unreadable claim did not stop the run");
  assertEquals(claimed.body.claimed, 0, "an unreadable claim leased work");
  assertEquals(claimed.body.completed, 0, "an unreadable claim completed work");
  assertEquals(claimed.body.jobs.length, 0, "an unreadable claim reported a job");
  for (const watchlistId of [WATCHLIST_A, WATCHLIST_B, WATCHLIST_D]) {
    const job = await competitorJob(watchlistId);
    assertEquals(job.status, "queued", "an unreadable claim changed a job");
    assertEquals(job.attempts, 0, "an unreadable claim attempted a job");
    assertEquals(job.last_reason_code, null, "an unreadable claim stored a success reason");
    assertEquals(await storedResultCount(watchlistId), 0, "an unreadable claim stored a result");
  }

  // --- The permit is asked after the lease, and the policy is then unreadable.
  // The first admitted watchlist stops the run. The second is not entered.
  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(admittedPairPolicy());
  await seedRankedCompetitorJobs();
  meta.reset();
  bridgeConfig.onRpc = undefined;

  let switched = false;
  bridgeConfig.onRpc = async (name) => {
    if (switched || name !== "authorize_instagram_collection_provider_call") return;
    switched = true;
    await setPolicy('{"version":1,"owners":{"mode":"nonsense"}}');
  };

  const permitted = { body: null as DrainBody | null };
  let permitEvents: WorkerLogEvent[] = [];
  try {
    permitEvents = await captureLogs(async () => {
      permitted.body = await drain(handler);
    });
  } finally {
    bridgeConfig.onRpc = undefined;
    await setPolicy(policyDocument("off", "allowlist"));
  }

  assert(switched, "the permit was never asked");
  assert(permitted.body !== null, "the permit drain returned no body");
  assertEquals(meta.calls.length, 0, "an unreadable permit let a request through");
  assertEquals(permitted.body.stoppedEarly, true, "an unreadable permit did not stop the run");
  assertEquals(permitted.body.claimed, 2, "the two admitted jobs were not both leased");
  assertEquals(permitted.body.completed, 0, "an unreadable permit completed a job");
  assertEquals(permitted.body.abandoned, 1, "the refused job was not abandoned");
  assertEquals(permitted.body.jobs.length, 1, "the run continued to the next watchlist");
  assertEquals(permitted.body.jobs[0]!.watchlistId, WATCHLIST_A);
  assertEquals(permitted.body.jobs[0]!.outcome, "abandoned");
  assertEquals(
    permitted.body.jobs[0]!.reasonCode,
    "collection_unavailable",
    "an unreadable permit was recorded as collection_not_eligible",
  );
  assertEquals(
    permitEvents.some((event) => event.watchlistId === WATCHLIST_B),
    false,
    "the second admitted watchlist was entered after the unreadable permit",
  );
  const first = await competitorJob(WATCHLIST_A);
  assertEquals(first.status, "leased", "the refused job was stored as a success");
  assertEquals(first.last_reason_code, null, "the refused job stored an outcome");
  assertEquals(first.context_viewer_social_account_id, VIEWER_1, "the lease never bound a viewer");
  const second = await competitorJob(WATCHLIST_B);
  assertEquals(second.status, "leased", "the second job was not left on its claim");
  assertEquals(second.context_viewer_social_account_id, null, "the second watchlist was attached");
  assertEquals(second.last_reason_code, null, "the second job recorded an outcome");
  const excluded = await competitorJob(WATCHLIST_D);
  assertEquals(excluded.status, "queued", "the foreign watchlist was claimed");
  assertEquals(excluded.attempts, 0, "the foreign watchlist was attempted");
  for (const watchlistId of [WATCHLIST_A, WATCHLIST_B, WATCHLIST_D]) {
    assertEquals(await storedResultCount(watchlistId), 0, "an unreadable permit stored a result");
  }
});

Deno.test("an audit write that does not commit stops the run", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(admittedPairPolicy());
  await seedRankedCompetitorJobs();
  meta.reset();

  // The lease is granted by the claim, and the viewer is attached, before
  // the permit is asked. The permit cannot be read, and the refusal cannot
  // be audited. An unavailable permit is not permission: no request leaves,
  // and the run stops before the second admitted watchlist is entered.
  await active.exec(
    `GRANT EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) TO service_role;`,
  );
  await active.exec(`GRANT INSERT ON public.system_logs TO service_role;`);
  await active.exec(
    `REVOKE EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) FROM service_role;`,
  );
  await active.exec(`REVOKE INSERT ON public.system_logs FROM service_role;`);

  const drained = { body: null as DrainBody | null };
  let events: WorkerLogEvent[] = [];
  try {
    events = await captureLogs(async () => {
      drained.body = await drain(handler);
    });
  } finally {
    await active.exec(
      `GRANT EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) TO service_role;`,
    );
    await active.exec(`GRANT INSERT ON public.system_logs TO service_role;`);
  }

  assertEquals(meta.calls.length, 0, "an unauditable refusal let a request through");
  assert(
    events.some((event) => event.event === "competitor_provider_call_audit_failed"),
    "the audit failure was not reported",
  );
  assertEquals(
    events.some((event) => event.event === "competitor_claim_abandoned"),
    false,
    "the audit failure was reported as a claim failure",
  );
  assert(drained.body !== null, "the drain returned no body");
  assertEquals(drained.body.stoppedEarly, true, "the audit failure did not stop the run");
  assertEquals(drained.body.claimed, 2, "the two admitted jobs were not both leased");
  assertEquals(drained.body.completed, 0, "an unauditable refusal completed a job");
  assertEquals(drained.body.abandoned, 1, "the refused job was not abandoned");
  assertEquals(drained.body.jobs.length, 1, "the run continued to the next watchlist");
  assertEquals(drained.body.jobs[0]!.watchlistId, WATCHLIST_A);
  assertEquals(drained.body.jobs[0]!.outcome, "abandoned");
  assertEquals(
    drained.body.jobs[0]!.reasonCode,
    "collection_unavailable",
    "an unauditable refusal was recorded as collection_not_eligible",
  );
  assertEquals(
    events.some((event) => event.watchlistId === WATCHLIST_B),
    false,
    "the second admitted watchlist was entered after the audit failure",
  );
  const first = await competitorJob(WATCHLIST_A);
  assertEquals(first.status, "leased", "the refused job was stored as a success");
  assertEquals(first.last_reason_code, null, "the refused job stored an outcome");
  assertEquals(
    first.context_viewer_social_account_id,
    VIEWER_1,
    "the permit ran before a viewer was bound",
  );
  const second = await competitorJob(WATCHLIST_B);
  assertEquals(second.status, "leased", "the second job was not left on its claim");
  assertEquals(second.context_viewer_social_account_id, null, "the second watchlist was attached");
  for (const watchlistId of [WATCHLIST_A, WATCHLIST_B, WATCHLIST_D]) {
    assertEquals(await storedResultCount(watchlistId), 0, "an unauditable refusal stored a result");
  }
});

Deno.test("a re-admitted target resumes only itself and keeps the earlier history", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  // --- The first, complete visit -----------------------------------------
  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(policyDocument("off", "allowlist"));
  await seedCompetitorJobs();
  meta.reset();

  const first = await drain(handler);
  assert(first.completed >= 1, "the allowlisted visit did not complete");
  const profilesBefore = await historyRows("competitor_profile_snapshots", WATCHLIST_A);
  const coverageBefore = await historyRows("competitor_capture_coverage", WATCHLIST_A);
  assert(profilesBefore.length > 0, "the first visit stored no profile history");
  assert(coverageBefore.length > 0, "the first visit stored no coverage report");
  for (const watchlistId of [WATCHLIST_B, WATCHLIST_D]) {
    assertEquals(await storedResultCount(watchlistId), 0, "the first visit stored an excluded result");
  }

  // --- The exclusion DURING the lease ------------------------------------
  await clearCompetitorJobs();
  await seedCompetitorJobs();
  meta.reset();

  let switched = false;
  let boundary = 0;
  meta.setHook(async () => {
    if (switched) return;
    switched = true;
    boundary = meta.calls.length;
    await setPolicy(policyDocument());
  });

  const during = await drain(handler);
  meta.setHook(null);

  assert(switched, "the exclusion was never applied during the lease");
  assertEquals(
    detectExclusionBreach(meta.calls, [HANDLE_A], boundary),
    [],
    "a request left the process after the exclusion",
  );
  assertEquals(during.completed, 0, "the excluded job completed anyway");
  assertEquals(
    await historyRows("competitor_profile_snapshots", WATCHLIST_A),
    profilesBefore,
    "the exclusion replaced the profile history",
  );
  assertEquals(
    await historyRows("competitor_capture_coverage", WATCHLIST_A),
    coverageBefore,
    "the exclusion replaced the coverage report",
  );
  const duringJob = await competitorJob(WATCHLIST_A);
  assertEquals(duringJob.status, "leased", "the refused job did not settle");

  // --- Quiescence ----------------------------------------------------------
  meta.reset();
  const quiescent = await drain(handler);
  assertEquals(meta.calls.length, 0, "a request left the process after the work had settled");
  assertEquals(quiescent.claimed, 0, "the settled work was claimed again");

  // --- The re-admission ----------------------------------------------------
  await setPolicy(policyDocument("off", "allowlist"));
  await active.exec(
    `UPDATE public.instagram_collection_jobs ` +
      `SET lease_expires_at = clock_timestamp() - interval '1 second' ` +
      `WHERE watchlist_id = '${WATCHLIST_A}';`,
  );
  meta.reset();

  const resumed = await drain(handler);
  assert(resumed.completed >= 1, "the re-admitted work did not resume");
  assertEquals(
    detectExclusionBreach(meta.calls, [HANDLE_B, HANDLE_D]),
    [],
    "the resumed work reached a watchlist it was not scoped to",
  );
  assert(
    meta.calls.some((call) => call.handle === HANDLE_A),
    "the resumed work made no request for the admitted watchlist",
  );
  assertEquals(
    meta.calls.filter((call) => call.handle === HANDLE_A).every((call) => call.target === IG_VIEWER_1),
    true,
    "the resumed work used a viewer other than the pin",
  );
  const profilesAfter = await historyRows("competitor_profile_snapshots", WATCHLIST_A);
  const coverageAfter = await historyRows("competitor_capture_coverage", WATCHLIST_A);
  for (const row of profilesBefore) {
    assert(
      profilesAfter.some((kept) => kept.id === row.id && kept.captured_at === row.captured_at),
      "the resumed work dropped a profile history row",
    );
  }
  for (const row of coverageBefore) {
    assert(
      coverageAfter.some((kept) => kept.id === row.id),
      "the resumed work dropped a coverage report row",
    );
  }
  for (const watchlistId of [WATCHLIST_B, WATCHLIST_D]) {
    assertEquals(await storedResultCount(watchlistId), 0, "the resumed work stored an excluded result");
    const job = await competitorJob(watchlistId);
    assertEquals(job.status, "queued", "the resumed work claimed an excluded watchlist");
    assertEquals(job.attempts, 0, "the resumed work attempted an excluded watchlist");
  }

  const mode = await active.queryJson(
    `SELECT value::text FROM public.app_settings ` +
      `WHERE key = 'credential_facebook_user_mode';`,
  );
  assertEquals(mode, "legacy", "the credential mode changed");
});

Deno.test("the copied source without the permit call makes the detector fail", async () => {
  // --- The copy ------------------------------------------------------------
  const copyRoot = join(COPY_DIR, "copy-1", "supabase", "functions");
  await Deno.mkdir(copyRoot, { recursive: true });
  await copyTree(
    join(FUNCTIONS_ROOT, "competitor-snapshot-sync"),
    join(copyRoot, "competitor-snapshot-sync"),
  );
  await copyTree(join(FUNCTIONS_ROOT, "_shared"), join(copyRoot, "_shared"));

  const transportPath = join(copyRoot, "competitor-snapshot-sync", "graphProvider.ts");
  const transport = await Deno.readTextFile(transportPath);
  const anchor =
    "      if (request.permit !== undefined) {\n        await askPermit(request.permit, request.signal);\n      }";
  assert(
    transport.includes(anchor),
    "the permit call could not be found in the copied provider",
  );
  await Deno.writeTextFile(
    transportPath,
    transport.replace(anchor, "      // The permit call was removed on purpose."),
  );

  const copiedHandler = await loadRoute(copyRoot);

  // --- The same scenario --------------------------------------------------
  await clearCompetitorJobs();
  await clearResults();
  await setPolicy(policyDocument("off", "allowlist"));
  await seedCompetitorJobs();
  meta.reset();

  let switched = false;
  bridgeConfig.onRpc = async (name) => {
    if (switched || name !== "read_facebook_user_account_credential") return;
    switched = true;
    await setPolicy(policyDocument());
  };

  await drain(copiedHandler);
  bridgeConfig.onRpc = undefined;

  assert(switched, "the exclusion was never applied during the lease");
  // The copy lets the request through. The detector of this suite therefore
  // CAN fail, which is what makes the other assertions evidence.
  const breach = detectExclusionBreach(meta.calls, [HANDLE_A]);
  assert(
    breach.length > 0,
    "the negative control did not fail: the detector would be vacuous",
  );
});

Deno.test("the fixtures are removed", async () => {
  const active = requireRuntime();
  meta.restore();
  bridgeConfig.onRpc = undefined;
  if (removeBridge !== null) {
    removeBridge();
    removeBridge = null;
  }
  await active.exec(
    `GRANT EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) TO service_role;`,
  );
  await active.exec(`GRANT INSERT ON public.system_logs TO service_role;`);
  await active.exec(`BEGIN;\n${TEARDOWN_SQL}\nCOMMIT;`);
  await restoreSettings();
  await releaseRolloutLease(active, LEASE_HOLDER);

  const left = await active.queryJson(
    `SELECT count(*)::int FROM public.competitor_watchlist ` +
      `WHERE id IN ('${WATCHLIST_A}', '${WATCHLIST_B}', '${WATCHLIST_D}');`,
  );
  assertEquals(left, 0, "the synthetic watchlists survived the suite");

  // The settings the fixture overwrote are back to what they were.
  const settings = await active.queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT key, to_jsonb(value)::text AS value ` +
      `FROM public.app_settings WHERE key IN (` +
      `${SETTINGS_KEYS.map((key) => `'${key}'`).join(", ")})) AS picked;`,
  );
  const restored: Record<string, string | null> = {};
  for (const key of SETTINGS_KEYS) restored[key] = null;
  for (const row of settings) {
    const record = row as { key: string; value: string | null };
    restored[record.key] = record.value;
  }
  assertEquals(
    restored,
    settingsSnapshot,
    "the suite did not restore the settings it overwrote",
  );
});

/** Copies a directory tree. */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) await copyTree(source, target);
    else if (entry.isFile) await Deno.copyFile(source, target);
  }
}

// The lease is taken as soon as the runtime is known, so two suites cannot
// write the shared policy at the same time.
if (runtime !== null) {
  await acquireRolloutLease(runtime, LEASE_HOLDER);
}
