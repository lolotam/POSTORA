#!/usr/bin/env node
// scripts/stage4-e2e.mjs — one command for the Stage 4 Playwright journeys.
//
// Boots, in order, against the disposable harness database left in place by
// scripts/db-harness.sh:
//   1. a PostgREST container publishing the harness DB on 127.0.0.1:54324
//   2. the Deno journey API (e2e/fixtures/youtubeStage4Server.ts) on
//      127.0.0.1:65438 — the REAL comment-manager route, a counting fake
//      provider, an auth shim and the /rest/v1 proxy
//   3. the app built against the journey API and served by vite preview on 8080, with VITE_SUPABASE_URL pointed at the
//      journey API
// and then runs the EN and AR journeys, tearing everything down after.
//
// No production system is contacted; the API server refuses any unexpected
// external request. Requires the db-harness container to be up:
//   docker run -d --name pg-harness-local ... (see the Stage 4 report)

import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

const REPO = process.cwd();
const PG_CONTAINER = process.env.STAGE4_PG_CONTAINER ?? "pg-harness-local";
const PG_NETWORK = "s4-e2e-net";
const PGREST_CONTAINER = "s4-postgrest";
const PGREST_PORT = 54324;
const API_PORT = 65438;
const OWNER_ID = "6e8a0001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "6e8b0001-0000-4000-8000-000000000001";
const CHANNEL_ID = "UC-s4-journey";
const OWNER_EMAIL = "stage4-journey@example.invalid";
// Throwaway credentials for the disposable stack only, fresh on every run
// (a caller may pin one to drive the stack by hand in STAGE4_STACK_ONLY mode).
const { STAGE4_OWNER_PASSWORD: PINNED_PASSWORD } = process.env;
const OWNER_PASSWORD = PINNED_PASSWORD ?? `Pw-${randomBytes(12).toString("hex")}`;
const JWT_SECRET = randomBytes(32).toString("hex");

const log = (step, msg) => console.log(`[stage4-e2e:${step}] ${msg}`);
const fail = (step, msg) => {
  console.error(`[stage4-e2e:${step}] FAIL: ${msg}`);
  process.exitCode = 1;
};

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ ...payload, iss: "supabase", exp: 4_102_444_800 }));
  const sig = base64url(createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

const ANON_KEY = jwt({ role: "anon" });
const SERVICE_KEY = jwt({ role: "service_role" });
const USER_TOKEN = jwt({ role: "authenticated", sub: OWNER_ID, email: OWNER_EMAIL });

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(500);
  }
  throw new Error(`${label} not reachable at ${url}`);
}

const children = [];
function run(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${command}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${command}] ${d}`));
  children.push(child);
  return child;
}

async function teardown() {
  for (const child of children) {
    try {
      if (process.platform === "win32" && child.pid) {
        // child.kill() ends only the cmd.exe shell wrapper on Windows and
        // orphans deno/vite on their ports; kill the whole process tree.
        await new Promise((resolve) => {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("close", resolve);
        });
      } else {
        child.kill();
      }
    } catch { /* already gone */ }
  }
  await docker(["rm", "-f", PGREST_CONTAINER]);
}

const SEED = `
BEGIN;
DELETE FROM public.youtube_comment_operations WHERE owner_id = '${OWNER_ID}';
DELETE FROM public.social_accounts WHERE id = '${ACCOUNT_ID}';
DELETE FROM auth.users WHERE id = '${OWNER_ID}';
DELETE FROM public.user_subscriptions WHERE user_id = '${OWNER_ID}';
-- Rate-limit buckets live in the database and survive a run; the low daily
-- ban cap would otherwise be spent by earlier runs and refuse this one.
DELETE FROM public.rate_limit_buckets WHERE bucket_key LIKE '%${OWNER_ID}%';
INSERT INTO auth.users (id, email) VALUES ('${OWNER_ID}', '${OWNER_EMAIL}');
-- The sign-in page sends a user with no subscription to /pricing; an active
-- one makes the post-login route deterministic (/dashboard).
INSERT INTO public.subscription_plans (name, slug, price_monthly, price_yearly, features, profile_limit, is_active, sort_order)
VALUES ('Stage 4 journey', 'stage4-journey', 0, 0, '[]'::jsonb, -1, true, 999)
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.user_subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
SELECT '${OWNER_ID}', id, 'active', now(), now() + interval '30 days'
  FROM public.subscription_plans WHERE slug = 'stage4-journey';
INSERT INTO public.social_accounts (
  id, user_id, platform, platform_user_id, platform_username,
  access_token, refresh_token, token_expires_at, is_active, auth_provider, needs_reauth,
  account_metadata
) VALUES (
  '${ACCOUNT_ID}', '${OWNER_ID}', 'youtube', '${CHANNEL_ID}', 'journey-channel',
  'journey-access-token', 'journey-refresh-token',
  clock_timestamp() + interval '2 hours', true, 'native', false,
  jsonb_build_object('granted_scopes', jsonb_build_array(
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/youtube.upload'))
);
INSERT INTO public.app_settings (key, value, description) VALUES
  ('feature_comment_manager', 'true'::jsonb, 'Stage 4 journey: the /comments page itself'),
  ('feature_youtube_comments', 'true'::jsonb, 'Stage 4 journey tile flag'),
  ('youtube_comments_stage4_rollout',
   jsonb_build_object('version', 1, 'accounts', jsonb_build_object(
     '${ACCOUNT_ID}'::text,
     jsonb_build_object('read', true, 'held', true, 'write', true, 'ban', true)
   )),
   'Stage 4 journey rollout policy')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
COMMIT;
`;

async function main() {
  try {
    // 0. the harness database must already exist (db-harness leaves it).
    const probe = await docker(["exec", PG_CONTAINER, "psql", "-U", "supabase_admin", "-d", "partner_api_harness", "-Atc", "select 1"]);
    if (probe.code !== 0) {
      fail("seed", `harness database unreachable in ${PG_CONTAINER}; run scripts/db-harness.sh first:\n${probe.out.slice(0, 400)}`);
      return;
    }

    // 1. seed.
    const seedChild = spawn("docker", ["exec", "-i", PG_CONTAINER, "psql", "-X", "--set=ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "partner_api_harness"], { stdio: ["pipe", "pipe", "pipe"] });
    const seedResult = new Promise((resolve) => {
      let out = "";
      seedChild.stdout.on("data", (d) => (out += d));
      seedChild.stderr.on("data", (d) => (out += d));
      seedChild.on("close", (code) => resolve({ code, out }));
    });
    seedChild.stdin.write(SEED);
    seedChild.stdin.end();
    const seed = await seedResult;
    if (seed.code !== 0) {
      fail("seed", seed.out.slice(0, 800));
      return;
    }
    log("seed", "journey fixtures seeded");

    // 1b. The harness Postgres listens on localhost only by default; PostgREST
    // reaches it over the shared docker network, so widen listen_addresses
    // and restart (the data dir survives; the harness DB stays in place).
    await docker(["network", "create", "--driver", "bridge", "--subnet", "172.31.238.0/24", PG_NETWORK]); // idempotent
    await docker(["network", "connect", PG_NETWORK, PG_CONTAINER]); // silent if already connected
    await docker(["exec", PG_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-c", "ALTER SYSTEM SET listen_addresses = '*';"]);
    await docker(["restart", PG_CONTAINER]);
    for (let i = 0; i < 40; i++) {
      await delay(1500);
      const ready = await docker(["exec", PG_CONTAINER, "pg_isready", "-h", "172.31.238.2", "-p", "5432"]);
      if (ready.code === 0) break;
    }
    log("postgres", "listening on the shared network");

    // 2. PostgREST on a shared network with the database.
    await docker(["rm", "-f", PGREST_CONTAINER]);
    // Pull separately: a first-run pull writes progress to stderr and must not
    // be mistaken for a failed `run`; only the exit code of `run` matters.
    const pulled = await docker(["pull", "-q", "postgrest/postgrest:v12.2.3"]);
    if (pulled.code !== 0) {
      fail("postgrest", `image pull failed:\n${pulled.out.slice(0, 400)}`);
      return;
    }
    const pgr = await docker([
      "run", "-d", "--name", PGREST_CONTAINER, "--network", PG_NETWORK,
      "-p", `127.0.0.1:${PGREST_PORT}:3000`,
      "-e", `PGRST_DB_URI=postgres://supabase_admin:postgres@${PG_CONTAINER}:5432/partner_api_harness`,
      "-e", "PGRST_DB_SCHEMAS=public",
      "-e", "PGRST_DB_ANON_ROLE=anon",
      "-e", "PGRST_DB_USE_LEGACY_GUCS=false",
      "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
      "postgrest/postgrest:v12.2.3",
    ]);
    if (pgr.code !== 0) {
      fail("postgrest", pgr.out.slice(0, 400));
      return;
    }
    await waitFor(`http://127.0.0.1:${PGREST_PORT}/social_accounts?select=id&limit=0`, 30_000, "PostgREST");
    log("postgrest", `listening on 127.0.0.1:${PGREST_PORT}`);

    // 3. the Deno journey API.
    const denoCmd = process.platform === "win32" ? "deno" : "deno";
    const denoArgs = [
      "run", "--allow-env", "--allow-net", "--allow-read",
      "--import-map=.github/deno/process-post-import-map.json",
      "e2e/fixtures/youtubeStage4Server.ts",
    ];
    run(denoCmd, denoArgs, {
      STAGE4_API_PORT: String(API_PORT),
      STAGE4_PGREST_URL: `http://127.0.0.1:${PGREST_PORT}`,
      STAGE4_SERVICE_ROLE_KEY: SERVICE_KEY,
      STAGE4_ANON_KEY: ANON_KEY,
      STAGE4_USER_TOKEN: USER_TOKEN,
      STAGE4_OWNER_ID: OWNER_ID,
      STAGE4_OWNER_EMAIL: OWNER_EMAIL,
      STAGE4_OWNER_PASSWORD: OWNER_PASSWORD,
      STAGE4_ACCOUNT_ID: ACCOUNT_ID,
      STAGE4_CHANNEL_ID: CHANNEL_ID,
    });
    await waitFor(`http://127.0.0.1:${API_PORT}/__stage4/provider`, 30_000, "journey API");
    log("api", `listening on 127.0.0.1:${API_PORT}`);

    // 4. the app, BUILT against the journey API and served by `vite preview`.
    // The dev server transforms modules on demand, so a cold or re-optimising
    // page could miss a 30 s wait; a built bundle loads the same way every time.
    const appEnv = {
      VITE_SUPABASE_URL: `http://127.0.0.1:${API_PORT}`,
      VITE_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
    };
    const buildDir = join(REPO, "node_modules", ".cache", "stage4-e2e-app");
    const build = run("npx", ["vite", "build", "--outDir", buildDir, "--emptyOutDir"], appEnv);
    const buildCode = await new Promise((resolve) => build.on("close", resolve));
    if (buildCode !== 0) {
      fail("vite", `build failed with exit code ${buildCode}`);
      return;
    }
    run("npx", ["vite", "preview", "--outDir", buildDir, "--host", "localhost", "--port", "8080", "--strictPort"], appEnv);
    await waitFor("http://localhost:8080/auth", 60_000, "Vite preview");
    log("vite", "built app on http://localhost:8080");

    if (process.env.STAGE4_STACK_ONLY === "1") {
      // Debug aid: leave the stack up so single journeys can be run by hand
      // (npx playwright test e2e/youtube-stage4.spec.ts -g "<title>").
      log("stack", "up; stop this process to tear it down");
      await new Promise(() => undefined);
    }

    // 5. the journeys. Extra CLI arguments (for example -g "<title>") pass through.
    const pw = run("npx", ["playwright", "test", "e2e/youtube-stage4.spec.ts", "--project=chromium", "--reporter=list", "--workers=1", "--timeout=90000", ...process.argv.slice(2)], {
      STAGE4_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      STAGE4_OWNER_EMAIL: OWNER_EMAIL,
      STAGE4_OWNER_PASSWORD: OWNER_PASSWORD,
      STAGE4_ACCOUNT_ID: ACCOUNT_ID,
    });
    const code = await new Promise((resolve) => pw.on("close", resolve));
    log("playwright", `exit code ${code}`);
    process.exitCode = code;
  } catch (error) {
    fail("run", error instanceof Error ? error.message : String(error));
  } finally {
    await teardown();
  }
}

await main();
