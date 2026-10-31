/**
 * The rollout exclusion proof of the OWNER collection, end to end.
 *
 * WHAT THIS SUITE PROVES
 *
 *   1. THE REAL PATH. The registered handler of
 *      `supabase/functions/instagram-insights-sync/index.ts` is loaded and
 *      driven: it builds the REAL production store factories
 *      (`createOwnerCollectionServiceStore`, `createOwnerDailyEnqueueStore`)
 *      and the REAL worker, and every statement it makes runs against a
 *      REAL disposable Postgres - the accepted migrations, the accepted
 *      functions, the accepted fences. Only the driver and the provider
 *      transport are replaced: the driver by a thin SQL adapter, the
 *      provider by a fake Meta transport with no public egress.
 *
 *   2. THE ADMISSION, IN EVERY ACTIVATION STAGE. With the policy off, with
 *      the owners allowlisted to exactly one account and with the owners on
 *      `all`, the EXCLUDED identities - the same owner's second account, the
 *      shared-grant sibling and the foreign owner's account - receive EXACTLY
 *      ZERO provider requests, and the ADMITTED identities receive requests
 *      and leave persisted observations behind. The count is per target AND
 *      per credential identity, never a total.
 *
 *   3. THE ROLLBACK. The policy is switched off DURING an active lease:
 *      after the permit of the first request was granted and before the
 *      permit of the second one. The next permit is refused, no further
 *      request leaves the process, the write after the exclusion is refused,
 *      the job settles, the stored observations survive, the credential mode
 *      is untouched, and a later re-admission resumes the work safely and
 *      scoped.
 *
 *   4. THE FAILURE SHAPES. A missing policy row, an unreadable policy and
 *      an audit write that does not commit each surface as a refusal or a
 *      failure. None of them is ever an empty success. An unreadable
 *      policy, an audit that does not commit and a collection that is
 *      switched off after the lease was granted are asked at the PERMIT:
 *      the run stops before the next admitted job, and the recorded reason
 *      is collection_unavailable.
 *
 *   5. THE NEGATIVE CONTROL. The same scenario runs against a COPY of the
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

const BUNDLE_DIR = Deno.makeTempDirSync({ prefix: "postora-rollout-owner-" });
const COPY_DIR = Deno.makeTempDirSync({ prefix: "postora-rollout-owner-copy-" });

const SUPABASE_URL = "https://api.postora.invalid";
const ANON_KEY = "synthetic-anon-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key";
const CRON_SECRET = "synthetic-cron-secret";

// ---------------------------------------------------------------------------
// The identities
// ---------------------------------------------------------------------------

/** The pilot owner. */
const OWNER_A = "6a100000-0000-4000-8000-000000000001";
/** Another tenant. */
const OWNER_D = "6b100000-0000-4000-8000-000000000002";

/** The allowlisted owner account. */
const ACCT_A = "6c100000-0000-4000-8000-000000000001";
/** Another account of the SAME owner. */
const ACCT_B = "6c100000-0000-4000-8000-000000000002";
/** A shared-grant sibling of the same owner. */
const ACCT_C = "6c100000-0000-4000-8000-000000000003";
/** An account of ANOTHER tenant. */
const ACCT_D = "6d100000-0000-4000-8000-000000000001";

/** The protected credential shared by ACCT_A and ACCT_C. */
const CRED_SHARED = "6e100000-0000-4000-8000-000000000001";
/** The protected credential of ACCT_B. */
const CRED_B = "6e100000-0000-4000-8000-000000000002";
/** The protected credential of ACCT_D. */
const CRED_D = "6e100000-0000-4000-8000-000000000003";

const IG_USER_A = "ig-rollout-a";
const IG_USER_B = "ig-rollout-b";
const IG_USER_C = "ig-rollout-c";
const IG_USER_D = "ig-rollout-d";

/**
 * Stable job ids, so a claim of two admitted accounts always starts with A.
 *
 * The claim orders by due time and then by job id. These ids sort A, B, C, D.
 */
const JOB_A = "6c200000-0000-4000-8000-000000000001";
const JOB_B = "6c200000-0000-4000-8000-000000000002";
const JOB_C = "6c200000-0000-4000-8000-000000000003";
const JOB_D = "6c200000-0000-4000-8000-000000000004";

/** The protected secret of the shared credential. */
const TOKEN_SHARED = "synthetic-protected-token-shared";
const TOKEN_B = "synthetic-protected-token-b";
const TOKEN_D = "synthetic-protected-token-d";

/** The browser-readable account column. The provider must never carry it. */
const BROWSER_TOKEN_A = "synthetic-browser-readable-token-a";
const BROWSER_TOKEN_B = "synthetic-browser-readable-token-b";
const BROWSER_TOKEN_C = "synthetic-browser-readable-token-c";
const BROWSER_TOKEN_D = "synthetic-browser-readable-token-d";

/** Every account, with the identity the provider call carries. */
const ACCOUNTS = [
  { id: ACCT_A, igUserId: IG_USER_A, owner: OWNER_A, token: TOKEN_SHARED },
  { id: ACCT_B, igUserId: IG_USER_B, owner: OWNER_A, token: TOKEN_B },
  { id: ACCT_C, igUserId: IG_USER_C, owner: OWNER_A, token: TOKEN_SHARED },
  { id: ACCT_D, igUserId: IG_USER_D, owner: OWNER_D, token: TOKEN_D },
] as const;

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

let runtime: RolloutRuntime | null = null;
let runtimeFailure: Error | null = null;

try {
  runtime = resolveRolloutRuntime();
} catch (error) {
  runtimeFailure = error instanceof Error
    ? error
    : new Error(String(error));
}

/** The runtime, or the failure that says why there is none. */
function requireRuntime(): RolloutRuntime {
  if (runtime === null) {
    throw runtimeFailure ??
      new Error("The rollout integration runtime is missing.");
  }
  return runtime;
}

/** The lease holder of this run. */
const LEASE_HOLDER = `owner-rollout-${crypto.randomUUID()}`;

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/**
 * The synthetic fixtures.
 *
 * They are written as the superuser, where RLS does not apply, and they are
 * removed again when the suite ends. Every value is synthetic: the emails
 * are `@example.invalid` and the tokens are literal strings.
 */
const FIXTURE_SQL = `
INSERT INTO auth.users (id, email)
VALUES
  ('${OWNER_A}', 'igrollout-it-owner-a@example.invalid'),
  ('${OWNER_D}', 'igrollout-it-owner-d@example.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_accounts
  (id, user_id, platform, platform_user_id, platform_username,
   access_token, ig_auth_type, is_active, needs_reauth)
VALUES
  ('${ACCT_A}', '${OWNER_A}', 'instagram', '${IG_USER_A}', 'igrollout_it_a',
   '${BROWSER_TOKEN_A}', 'facebook_page', true, false),
  ('${ACCT_B}', '${OWNER_A}', 'instagram', '${IG_USER_B}', 'igrollout_it_b',
   '${BROWSER_TOKEN_B}', 'facebook_page', true, false),
  ('${ACCT_C}', '${OWNER_A}', 'instagram', '${IG_USER_C}', 'igrollout_it_c',
   '${BROWSER_TOKEN_C}', 'facebook_page', true, false),
  ('${ACCT_D}', '${OWNER_D}', 'instagram', '${IG_USER_D}', 'igrollout_it_d',
   '${BROWSER_TOKEN_D}', 'facebook_page', true, false);

INSERT INTO public.instagram_account_capabilities
  (social_account_id, user_id, platform, login_kind, permission_read_state,
   granted_scopes, scopes_read_at, last_read_failed_at, credential_generation)
VALUES
  ('${ACCT_A}', '${OWNER_A}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 3),
  ('${ACCT_B}', '${OWNER_A}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 1),
  ('${ACCT_C}', '${OWNER_A}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 1),
  ('${ACCT_D}', '${OWNER_D}', 'instagram', 'page_linked', 'ok',
   ARRAY['instagram_manage_insights'], now(), NULL, 1);

INSERT INTO public.facebook_user_credentials
  (id, user_id, token, revision, lifecycle, token_expires_at, provenance_source)
VALUES
  ('${CRED_SHARED}', '${OWNER_A}', '${TOKEN_SHARED}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential'),
  ('${CRED_B}', '${OWNER_A}', '${TOKEN_B}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential'),
  ('${CRED_D}', '${OWNER_D}', '${TOKEN_D}', 1, 'active',
   now() + interval '30 days', 'migrated_instagram_account_credential');

INSERT INTO public.facebook_user_credential_bindings
  (social_account_id, user_id, platform, credential_id, evidence_source)
VALUES
  ('${ACCT_A}', '${OWNER_A}', 'instagram', '${CRED_SHARED}',
   'migrated_instagram_account_credential'),
  ('${ACCT_C}', '${OWNER_A}', 'instagram', '${CRED_SHARED}',
   'migrated_instagram_account_credential'),
  ('${ACCT_B}', '${OWNER_A}', 'instagram', '${CRED_B}',
   'migrated_instagram_account_credential'),
  ('${ACCT_D}', '${OWNER_D}', 'instagram', '${CRED_D}',
   'migrated_instagram_account_credential');

INSERT INTO public.app_settings (key, value, description)
VALUES
  ('collection_instagram_insights_enabled', 'true'::jsonb,
   'Synthetic harness master switch for the rollout integration suite.'),
  ('credential_facebook_user_mode', '"legacy"'::jsonb,
   'Synthetic harness credential mode for the rollout integration suite.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
`;

/** Removes every synthetic row the suite wrote. */
const TEARDOWN_SQL = `
DELETE FROM public.ig_account_insight_daily
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.ig_account_profile_observations
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.ig_media_insight_snapshots
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.instagram_collection_job_operations
 WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                   WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}'));
DELETE FROM public.instagram_collection_job_checkpoints
 WHERE job_id IN (SELECT id FROM public.instagram_collection_jobs
                   WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}'));
DELETE FROM public.instagram_collection_jobs
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.facebook_user_credential_bindings
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.facebook_user_credentials
 WHERE id IN ('${CRED_SHARED}', '${CRED_B}', '${CRED_D}');
DELETE FROM public.instagram_account_capabilities
 WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM public.social_accounts
 WHERE id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');
DELETE FROM auth.users WHERE id IN ('${OWNER_A}', '${OWNER_D}');
`;

/** The policy document of one activation stage. */
function policyDocument(
  ownerMode: "off" | "allowlist" | "all",
  competitorMode: "off" | "allowlist" | "all" = "off",
): string {
  const ownerIds = ownerMode === "allowlist" ? [ACCT_A] : [];
  const competitorTargets = competitorMode === "allowlist"
    ? [{ watchlist_id: "6f100000-0000-4000-8000-000000000001", viewer_social_account_id: ACCT_A }]
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

/** Writes the master switch. */
async function setMaster(enabled: boolean): Promise<void> {
  await requireRuntime().exec(
    `INSERT INTO public.app_settings (key, value, description) ` +
      `VALUES ('collection_instagram_insights_enabled', '${enabled}'::jsonb, ` +
      `'Synthetic harness master switch.') ` +
      `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
  );
}

/** An allowlist of exactly the named owner accounts. */
function ownersAllowlist(accountIds: readonly string[]): string {
  return JSON.stringify({
    version: 1,
    owners: { mode: "allowlist", account_ids: [...accountIds] },
    competitors: { mode: "off", targets: [] },
  });
}

/**
 * Seeds one pending job per account, with ids that claim in account order.
 *
 * A and B are the two admitted jobs of the stop-the-run cases. C and D stay
 * outside that allowlist, so a run that continues past the failure would
 * still have to leave them unclaimed.
 */
async function seedRankedOwnerJobs(): Promise<void> {
  const rows = [
    [JOB_A, ACCT_A, OWNER_A],
    [JOB_B, ACCT_B, OWNER_A],
    [JOB_C, ACCT_C, OWNER_A],
    [JOB_D, ACCT_D, OWNER_D],
  ];
  const values = rows.map(([id, account, owner]) =>
    `('${id}', '${owner}', 'owner', '${account}', '${account}', ` +
    `(now() AT TIME ZONE 'Asia/Kuwait')::date, 'queued', now() - interval '1 day', 0, 1)`
  ).join(",\n  ");

  await requireRuntime().exec(
    `INSERT INTO public.instagram_collection_jobs ` +
      `(id, user_id, target_kind, target_id, social_account_id, captured_on, ` +
      `status, due_at, attempts, job_generation) ` +
      `VALUES ${values};`,
  );
}

/** The job row of one account. */
async function ownerJob(accountId: string): Promise<{
  status: string;
  attempts: number;
  last_reason_code: string | null;
}> {
  const rows = await requireRuntime().queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT status, attempts, last_reason_code ` +
      `FROM public.instagram_collection_jobs ` +
      `WHERE social_account_id = '${accountId}') AS picked;`,
  );
  assertEquals(rows.length, 1, `expected one job for ${accountId}`);
  return rows[0] as {
    status: string;
    attempts: number;
    last_reason_code: string | null;
  };
}

/** Operations the worker planned for one account. The claim writes none. */
async function operationCount(accountId: string): Promise<number> {
  return Number(await requireRuntime().queryJson(
    `SELECT count(*)::int FROM public.instagram_collection_job_operations AS o ` +
      `JOIN public.instagram_collection_jobs AS j ON j.id = o.job_id ` +
      `WHERE j.social_account_id = '${accountId}';`,
  ));
}

/**
 * Seeds one pending job per account.
 *
 * The rows are written DIRECTLY, so they are PRE-EXISTING pending jobs for
 * every identity, admitted or not. That is the state the admission has to
 * survive: an excluded target's old work must stay unclaimed.
 */
async function seedOwnerJobs(): Promise<void> {
  const values = ACCOUNTS.map((account) =>
    `('${account.owner}', 'owner', '${account.id}', '${account.id}', ` +
    `(now() AT TIME ZONE 'Asia/Kuwait')::date, 'queued', now() - interval '1 day', 0, 1)`
  ).join(",\n  ");

  await requireRuntime().exec(
    `INSERT INTO public.instagram_collection_jobs ` +
      `(user_id, target_kind, target_id, social_account_id, captured_on, ` +
      `status, due_at, attempts, job_generation) ` +
      `VALUES ${values};`,
  );
}

/** Removes every owner job of the fixture. */
async function clearOwnerJobs(): Promise<void> {
  await requireRuntime().exec(
    `DELETE FROM public.instagram_collection_jobs ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  );
}

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

/**
 * Removes every stored observation of the fixture.
 *
 * The observations are the REPORT and the HISTORY. A test that counts them
 * starts from zero, so one test can never be satisfied by the rows another
 * test left behind.
 */
async function clearObservations(): Promise<void> {
  await requireRuntime().exec(
    `DELETE FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  );
  await requireRuntime().exec(
    `DELETE FROM public.ig_account_profile_observations ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
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
  const key = functionsRoot;
  const cached = bundles.get(key);
  if (cached !== undefined && cached !== "") {
    // The handler is created once per bundle. The tests reuse it.
    return await importHandler(cached);
  }

  const outfile = `${BUNDLE_DIR}/owner-${++importSeq}.mjs`;
  await build({
    entryPoints: [join(functionsRoot, "instagram-insights-sync/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
    plugins: [rolloutDriverStubPlugin()],
  });
  bundles.set(key, outfile);
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
    throw new Error("instagram-insights-sync did not register a request handler");
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
  readonly socialAccountId?: string;
  readonly [key: string]: unknown;
}

let removeBridge: (() => void) | null = null;

/**
 * The bridge configuration.
 *
 * `onRpc` runs BEFORE a statement, so a scenario can change the policy
 * after the lease was granted and before the permit is asked.
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
    "https://api.postora.invalid/functions/v1/instagram-insights-sync",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ action: "drain" }),
    },
  );
}

/** The body of one drain. */
interface DrainBody {
  readonly claimed: number;
  readonly processed: number;
  readonly completed: number;
  readonly abandoned: number;
  readonly stopped_early: boolean;
  readonly jobs: Array<{
    readonly job_id: string;
    readonly social_account_id: string;
    readonly outcome: string;
    readonly reason_code: string | null;
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
  excludedTargets: readonly string[],
  fromIndex = 0,
): string[] {
  return calls
    .slice(fromIndex)
    .filter((call) => excludedTargets.includes(call.target))
    .map((call) => `${call.kind}:${call.target}`);
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
  // One transaction: the protected-credential table carries a DEFERRED
  // constraint trigger, so a secret and its binding have to commit together.
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

Deno.test("every activation stage collects only the admitted identities", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  const stages: Array<{
    readonly name: string;
    readonly policy: string;
    readonly admitted: readonly string[];
  }> = [
    { name: "policy off", policy: policyDocument("off"), admitted: [] },
    {
      name: "owners allowlisted to one account",
      policy: policyDocument("allowlist"),
      admitted: [ACCT_A],
    },
    {
      name: "owners all",
      policy: policyDocument("all"),
      admitted: [ACCT_A, ACCT_B, ACCT_C, ACCT_D],
    },
  ];

  for (const stage of stages) {
    await clearOwnerJobs();
    await setPolicy(stage.policy);
    await seedOwnerJobs();
    meta.reset();

    const body = await drain(handler);

    const excluded = ACCOUNTS
      .filter((account) => !stage.admitted.includes(account.id))
      .map((account) => account.igUserId);

    const breach = detectExclusionBreach(meta.calls, excluded);
    assertEquals(
      breach,
      [],
      `${stage.name}: an excluded identity received a provider request`,
    );

    for (const account of ACCOUNTS) {
      const calls = meta.callsFor(account.igUserId);
      if (stage.admitted.includes(account.id)) {
        assert(
          calls.length > 0,
          `${stage.name}: the admitted account ${account.id} received no provider request`,
        );
        for (const call of calls) {
          assertEquals(
            call.accessToken,
            account.token,
            `${stage.name}: the request for ${account.id} carried another credential`,
          );
        }
      } else {
        assertEquals(
          calls.length,
          0,
          `${stage.name}: the excluded account ${account.id} was called`,
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

    // The persisted observations follow the admission exactly.
    for (const account of ACCOUNTS) {
      const daily = await active.queryJson(
        `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
          `WHERE social_account_id = '${account.id}';`,
      );
      const profiles = await active.queryJson(
        `SELECT count(*)::int FROM public.ig_account_profile_observations ` +
          `WHERE social_account_id = '${account.id}';`,
      );
      if (stage.admitted.includes(account.id)) {
        assert(
          Number(daily) > 0,
          `${stage.name}: the admitted account ${account.id} stored no daily observation`,
        );
        assert(
          Number(profiles) > 0,
          `${stage.name}: the admitted account ${account.id} stored no profile observation`,
        );
      } else {
        assertEquals(
          daily,
          0,
          `${stage.name}: the excluded account ${account.id} stored a daily observation`,
        );
        assertEquals(
          profiles,
          0,
          `${stage.name}: the excluded account ${account.id} stored a profile observation`,
        );
      }
    }

    // An excluded target's old work is untouched: it is never claimed.
    const jobs = await active.queryRows(
      `SELECT to_jsonb(picked) FROM (SELECT social_account_id, status, attempts ` +
        `FROM public.instagram_collection_jobs WHERE social_account_id IN ` +
        `('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}')) AS picked;`,
    );
    for (const job of jobs) {
      const record = job as { social_account_id: string; status: string; attempts: number };
      if (!stage.admitted.includes(record.social_account_id)) {
        assertEquals(
          record.status,
          "queued",
          `${stage.name}: the excluded job of ${record.social_account_id} was claimed`,
        );
        assertEquals(
          record.attempts,
          0,
          `${stage.name}: the excluded job of ${record.social_account_id} was attempted`,
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

Deno.test("the write after the exclusion is refused and the work settles", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  // --- The first, complete visit -----------------------------------------
  await clearOwnerJobs();
  await clearObservations();
  await setPolicy(policyDocument("allowlist"));
  await seedOwnerJobs();
  meta.reset();

  const first = await drain(handler);
  assertEquals(first.completed, 1, "the allowlisted visit did not complete");

  const storedBefore = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id = '${ACCT_A}';`,
  ));
  assert(storedBefore > 0, "the first visit stored no observation");

  // --- The exclusion DURING the lease ------------------------------------
  await clearOwnerJobs();
  await seedOwnerJobs();
  meta.reset();

  let switched = false;
  let boundary = 0;
  meta.setHook(async () => {
    if (switched) return;
    switched = true;
    // The permit of THIS request was already granted. The write that
    // follows it is the first thing the exclusion can refuse.
    boundary = meta.calls.length;
    await setPolicy(policyDocument("off"));
  });

  const during = await drain(handler);
  meta.setHook(null);

  assert(switched, "the exclusion was never applied during the lease");
  assertEquals(
    meta.calls.length,
    1,
    "a request left the process after the exclusion",
  );
  assertEquals(
    detectExclusionBreach(meta.calls, [IG_USER_A], boundary),
    [],
    "the excluded identity received a request after the exclusion",
  );

  // The write after the exclusion is refused: nothing new is stored and the
  // job does not complete.
  const storedAfter = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id = '${ACCT_A}';`,
  ));
  assertEquals(
    storedAfter,
    storedBefore,
    "the write after the exclusion was stored",
  );
  assertEquals(during.completed, 0, "the excluded job completed anyway");
  assertEquals(during.abandoned, 1, "the excluded job was not abandoned");

  const duringJobs = await active.queryRows(
    `SELECT to_jsonb(picked) FROM (SELECT status FROM public.instagram_collection_jobs ` +
      `WHERE social_account_id = '${ACCT_A}') AS picked;`,
  );
  assertEquals(
    (duringJobs[0] as { status: string }).status,
    "leased",
    "the refused job did not settle",
  );

  // The stored observations survive the exclusion.
  const survivors = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id = '${ACCT_A}';`,
  ));
  assertEquals(survivors, storedBefore, "the exclusion destroyed the observations");

  // --- Quiescence ----------------------------------------------------------
  meta.reset();
  const quiescent = await drain(handler);
  assertEquals(
    meta.calls.length,
    0,
    "a request left the process after the work had settled",
  );
  assertEquals(quiescent.claimed, 0, "the settled work was claimed again");

  // --- The re-admission ----------------------------------------------------
  await setPolicy(policyDocument("allowlist"));
  // The lease is bounded. The suite advances it instead of waiting two
  // minutes for it to expire.
  await active.exec(
    `UPDATE public.instagram_collection_jobs ` +
      `SET lease_expires_at = clock_timestamp() - interval '1 second' ` +
      `WHERE social_account_id = '${ACCT_A}';`,
  );
  meta.reset();

  const resumed = await drain(handler);
  assert(resumed.completed >= 1, "the re-admitted work did not resume");
  assertEquals(
    detectExclusionBreach(meta.calls, [IG_USER_B, IG_USER_C, IG_USER_D]),
    [],
    "the resumed work reached an identity it was not scoped to",
  );
  assert(
    meta.callsFor(IG_USER_A).length > 0,
    "the resumed work made no request",
  );

  // The credential mode is untouched by the whole scenario.
  const mode = await active.queryJson(
    `SELECT value::text FROM public.app_settings ` +
      `WHERE key = 'credential_facebook_user_mode';`,
  );
  assertEquals(mode, "legacy", "the credential mode changed");
});

Deno.test("the next permit after the exclusion is refused", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearOwnerJobs();
  await clearObservations();
  await setPolicy(policyDocument("allowlist"));
  await seedOwnerJobs();
  meta.reset();

  // The media window offers a cursor, so the adapter asks for a SECOND page.
  // The permit for that second page is asked again, and no write sits
  // between the two requests: the exclusion is observed by the PERMIT and
  // by nothing else.
  meta.setMediaCursor("rollout-cursor-1");

  let switched = false;
  let boundary = 0;
  meta.setHook(async (call) => {
    if (switched || call.kind !== "media_window") return;
    switched = true;
    boundary = meta.calls.length;
    await setPolicy(policyDocument("off"));
  });

  const events = await captureLogs(async () => {
    await drain(handler);
  });
  meta.setHook(null);

  assert(switched, "the exclusion was never applied during the lease");
  assertEquals(
    detectExclusionBreach(meta.calls, [IG_USER_A], boundary),
    [],
    "a request left the process after the exclusion",
  );

  const refusal = events.find((event) => event.event === "owner_provider_call_refused");
  assert(refusal !== undefined, "the next permit was not refused");
  assertEquals(
    refusal.reasonCode,
    "collection_not_eligible",
    "the permit was refused for another reason",
  );

  // The work that was already collected stays collected.
  const stored = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id = '${ACCT_A}';`,
  ));
  assert(stored > 0, "the observations collected before the exclusion were lost");
});

Deno.test("a missing policy row refuses the work and never collects", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearOwnerJobs();
  await clearObservations();
  await removePolicy();
  await seedOwnerJobs();
  meta.reset();

  await drain(handler);

  assertEquals(meta.calls.length, 0, "a missing policy let a request through");
  const daily = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  ));
  assertEquals(daily, 0, "a missing policy stored an observation");

  // The refusal is audited in SQL, so it is never a silent no-work.
  const audits = await active.queryJson(
    `SELECT count(*)::int FROM public.system_logs ` +
      `WHERE source = 'instagram-collection-rollout' ` +
      `AND metadata ->> 'reason_code' = 'collection_not_eligible';`,
  );
  assert(Number(audits) > 0, "the missing policy was not audited as a refusal");
});

Deno.test("an unreadable policy fails the run and never collects", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  // --- The claim cannot read the policy -----------------------------------
  await clearOwnerJobs();
  await clearObservations();
  await setPolicy('{"version":1,"owners":{"mode":"nonsense"}}');
  await seedOwnerJobs();
  meta.reset();

  const claimed = { body: null as DrainBody | null };
  const events = await captureLogs(async () => {
    claimed.body = await drain(handler);
  });

  assertEquals(meta.calls.length, 0, "an unreadable policy let a request through");
  assert(
    events.some((event) => event.event === "owner_claim_abandoned"),
    "the unreadable policy did not fail the claim",
  );
  assert(claimed.body !== null, "the claim drain returned no body");
  assertEquals(claimed.body.stopped_early, true, "an unreadable claim did not stop the run");
  assertEquals(claimed.body.claimed, 0, "an unreadable claim leased work");
  assertEquals(claimed.body.completed, 0, "an unreadable claim completed work");
  assertEquals(claimed.body.jobs.length, 0, "an unreadable claim reported a job");
  for (const accountId of [ACCT_A, ACCT_B, ACCT_C, ACCT_D]) {
    const job = await ownerJob(accountId);
    assertEquals(job.status, "queued", "an unreadable claim changed a job");
    assertEquals(job.attempts, 0, "an unreadable claim attempted a job");
    assertEquals(job.last_reason_code, null, "an unreadable claim stored a success reason");
  }
  const daily = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  ));
  assertEquals(daily, 0, "an unreadable policy stored an observation");

  // --- The permit is asked after the lease, and the policy is then unreadable.
  // The first admitted job stops the run. The second is not entered.
  await clearOwnerJobs();
  await clearObservations();
  await setPolicy(ownersAllowlist([ACCT_A, ACCT_B]));
  await seedRankedOwnerJobs();
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
    await setPolicy(policyDocument("allowlist"));
  }

  assert(switched, "the permit was never asked");
  assert(permitted.body !== null, "the permit drain returned no body");
  assertEquals(meta.calls.length, 0, "an unreadable permit let a request through");
  assertEquals(permitted.body.stopped_early, true, "an unreadable permit did not stop the run");
  assertEquals(permitted.body.claimed, 2, "the two admitted jobs were not both leased");
  assertEquals(permitted.body.completed, 0, "an unreadable permit completed a job");
  assertEquals(permitted.body.abandoned, 1, "the refused job was not abandoned");
  assertEquals(permitted.body.jobs.length, 1, "the run continued to the next job");
  assertEquals(permitted.body.jobs[0]!.social_account_id, ACCT_A);
  assertEquals(permitted.body.jobs[0]!.outcome, "abandoned");
  assertEquals(
    permitted.body.jobs[0]!.reason_code,
    "collection_unavailable",
    "an unreadable permit was recorded as collection_not_eligible",
  );
  assertEquals(
    permitEvents.some((event) => event.socialAccountId === ACCT_B),
    false,
    "the second admitted job was entered after the unreadable permit",
  );
  assertEquals(await operationCount(ACCT_B), 0, "the second admitted job was planned");
  assert(await operationCount(ACCT_A) > 0, "the first job never reached the permit");
  const second = await ownerJob(ACCT_B);
  assertEquals(second.status, "leased", "the second job was not left on its claim");
  assertEquals(second.last_reason_code, null, "the second job recorded an outcome");
  const stored = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}');`,
  ));
  assertEquals(stored, 0, "an unreadable permit stored an observation");
});

Deno.test("an audit write that does not commit stops the run", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearOwnerJobs();
  await clearObservations();
  await setPolicy(ownersAllowlist([ACCT_A, ACCT_B]));
  await seedRankedOwnerJobs();
  meta.reset();

  // The lease is granted by the claim. The permit is then unreadable, and
  // the refusal cannot be audited. An unavailable permit is not permission,
  // and it stops the run before the second admitted job is entered.
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

  assertEquals(
    meta.calls.length,
    0,
    "an unauditable refusal let a request through",
  );
  assert(
    events.some((event) => event.event === "owner_provider_call_audit_failed"),
    "the audit failure was not reported",
  );
  assert(drained.body !== null, "the drain returned no body");
  assertEquals(drained.body.stopped_early, true, "the audit failure did not stop the run");
  assertEquals(drained.body.claimed, 2, "the two admitted jobs were not both leased");
  assertEquals(drained.body.completed, 0, "an unauditable refusal completed a job");
  assertEquals(drained.body.abandoned, 1, "the refused job was not abandoned");
  assertEquals(drained.body.jobs.length, 1, "the run continued to the next job");
  assertEquals(drained.body.jobs[0]!.social_account_id, ACCT_A);
  assertEquals(drained.body.jobs[0]!.outcome, "abandoned");
  assertEquals(
    drained.body.jobs[0]!.reason_code,
    "collection_unavailable",
    "an unauditable refusal was recorded as collection_not_eligible",
  );
  assertEquals(
    events.some((event) => event.socialAccountId === ACCT_B),
    false,
    "the second admitted job was entered after the audit failure",
  );
  assertEquals(await operationCount(ACCT_B), 0, "the second admitted job was planned");
  assert(await operationCount(ACCT_A) > 0, "the first job never reached the permit");
  const failed = await ownerJob(ACCT_A);
  assertEquals(failed.status, "leased", "the refused job was stored as a success");
  assertEquals(failed.last_reason_code, null, "the refused job stored an outcome");
  const daily = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  ));
  assertEquals(daily, 0, "an unauditable refusal stored an observation");
});

Deno.test("a disabled collection at the permit stops the run and never collects", async () => {
  const active = requireRuntime();
  const handler = await loadRoute();
  installBridge();

  await clearOwnerJobs();
  await clearObservations();
  await setMaster(true);
  await setPolicy(ownersAllowlist([ACCT_A, ACCT_B]));
  await seedRankedOwnerJobs();
  meta.reset();
  bridgeConfig.onRpc = undefined;

  // The claim leases both admitted jobs while collection is on. The master
  // switch is turned off after that lease and before the permit, so the
  // refusal is a configuration refusal of the RUN, not of one target.
  let switched = false;
  bridgeConfig.onRpc = async (name) => {
    if (switched || name !== "authorize_instagram_collection_provider_call") return;
    switched = true;
    await setMaster(false);
  };

  const drained = { body: null as DrainBody | null };
  let events: WorkerLogEvent[] = [];
  try {
    events = await captureLogs(async () => {
      drained.body = await drain(handler);
    });
  } finally {
    bridgeConfig.onRpc = undefined;
    await setMaster(true);
  }

  assert(switched, "the permit was never asked");
  assert(drained.body !== null, "the drain returned no body");
  assertEquals(meta.calls.length, 0, "a disabled collection let a request through");
  assertEquals(drained.body.stopped_early, true, "a disabled collection did not stop the run");
  assertEquals(drained.body.claimed, 2, "the two admitted jobs were not both leased");
  assertEquals(drained.body.completed, 0, "a disabled collection completed a job");
  assertEquals(drained.body.abandoned, 1, "the refused job was not abandoned");
  assertEquals(drained.body.jobs.length, 1, "the run continued to the next job");
  assertEquals(drained.body.jobs[0]!.social_account_id, ACCT_A);
  assertEquals(drained.body.jobs[0]!.outcome, "abandoned");
  assertEquals(
    drained.body.jobs[0]!.reason_code,
    "collection_unavailable",
    "a disabled collection was recorded as collection_not_eligible",
  );
  assertEquals(
    events.some((event) => event.socialAccountId === ACCT_B),
    false,
    "the second admitted job was entered after collection was disabled",
  );
  assertEquals(await operationCount(ACCT_B), 0, "the second admitted job was planned");
  assert(await operationCount(ACCT_A) > 0, "the first job never reached the permit");
  const failed = await ownerJob(ACCT_A);
  assertEquals(failed.status, "leased", "the refused job was stored as a success");
  assertEquals(failed.last_reason_code, null, "the refused job stored an outcome");
  const daily = Number(await active.queryJson(
    `SELECT count(*)::int FROM public.ig_account_insight_daily ` +
      `WHERE social_account_id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  ));
  assertEquals(daily, 0, "a disabled collection stored an observation");
});

Deno.test("the copied source without the permit call makes the detector fail", async () => {
  const active = requireRuntime();

  // --- The copy ------------------------------------------------------------
  const copyRoot = join(COPY_DIR, "copy-1", "supabase", "functions");
  await Deno.mkdir(copyRoot, { recursive: true });
  await copyTree(
    join(FUNCTIONS_ROOT, "instagram-insights-sync"),
    join(copyRoot, "instagram-insights-sync"),
  );
  await copyTree(join(FUNCTIONS_ROOT, "_shared"), join(copyRoot, "_shared"));

  const transportPath = join(copyRoot, "instagram-insights-sync", "providerTransport.ts");
  const transport = await Deno.readTextFile(transportPath);
  const anchor = `      if (options.permit !== undefined) {\n        await askPermit(options.permit, signal);\n      }`;
  assert(
    transport.includes(anchor),
    "the permit call could not be found in the copied transport",
  );
  await Deno.writeTextFile(
    transportPath,
    transport.replace(anchor, "      // The permit call was removed on purpose."),
  );

  const copiedHandler = await loadRoute(copyRoot);

  // --- The same scenario --------------------------------------------------
  await clearOwnerJobs();
  await clearObservations();
  await setPolicy(policyDocument("allowlist"));
  await seedOwnerJobs();
  meta.reset();

  // The media window offers a cursor, so the adapter asks for a SECOND page
  // and the permit for that page is asked again.
  meta.setMediaCursor("rollout-cursor-1");

  let switched = false;
  let boundary = 0;
  meta.setHook(async (call) => {
    if (switched || call.kind !== "media_window") return;
    switched = true;
    boundary = meta.calls.length;
    await setPolicy(policyDocument("off"));
  });

  await drain(copiedHandler);
  meta.setHook(null);

  assert(switched, "the exclusion was never applied during the lease");

  // The copy lets the SECOND request through. The detector of this suite
  // therefore CAN fail, which is what makes the other assertions evidence.
  const breach = detectExclusionBreach(meta.calls, [IG_USER_A], boundary);
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
  // A failure case revokes these and restores them. Restore them again so a
  // failed case cannot leave the harness unable to authorize a permit.
  await active.exec(
    `GRANT EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) TO service_role;`,
  );
  await active.exec(`GRANT INSERT ON public.system_logs TO service_role;`);
  await active.exec(`BEGIN;\n${TEARDOWN_SQL}\nCOMMIT;`);
  await restoreSettings();
  await releaseRolloutLease(active, LEASE_HOLDER);

  const left = await active.queryJson(
    `SELECT count(*)::int FROM public.social_accounts ` +
      `WHERE id IN ('${ACCT_A}', '${ACCT_B}', '${ACCT_C}', '${ACCT_D}');`,
  );
  assertEquals(left, 0, "the synthetic accounts survived the suite");

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
