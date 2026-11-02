#!/usr/bin/env node
// Creates NEW disposable containers only. Never resets/reuses an existing database.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_RELEASE } from "../e2e/fixtures/instagramOwnerReleaseSettings.mjs";
import { assertLocalDockerSocket } from "../e2e/fixtures/instagramOwnerReleaseSafety.mjs";
import { assertOwnerExecutionSource } from "./instagram-owner-execution-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "e2e", "fixtures");
const baseline = JSON.parse(readFileSync(join(fixture, "instagramOwnerAuthBaseline.json"), "utf8"));
const internalNetwork = "postora-owner-release-isolated";
const gatewayNetwork = "postora-owner-release-net";
const names = [OWNER_RELEASE.container, "postora-owner-release-auth", "postora-owner-release-rest", "postora-owner-release-gateway"];
const labels = ["--label", "project=postora", "--label", "purpose=owner-release-test"];
const databasePassword = "owner_release_test_password";

function docker(args, options = {}) {
  try {
    return execFileSync("docker", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe", ...options });
  } catch (error) {
    throw new Error(`Docker ${args[0]} failed (exit ${error.status ?? "unknown"}); inspect the isolated fixture locally`, { cause: error });
  }
}
function sql(statement) {
  return docker(["exec", "-i", OWNER_RELEASE.container, "psql", "-U", "supabase_admin", "-d", OWNER_RELEASE.database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { input: statement }).trim();
}
const authShapeQuery = "SELECT md5(string_agg(c.relname || '.' || a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text, '|' ORDER BY c.relname,a.attnum)) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped";

async function waitForReady(probe, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resume) => setTimeout(resume, 500));
  }
  throw new Error(`${label} did not become ready within 90 seconds`);
}

function validateExisting() {
  const network = JSON.parse(docker(["network", "inspect", internalNetwork]))[0];
  if (!network.Internal || network.Labels?.project !== "postora") throw new Error("Fixture network is not isolated");
  for (const name of names) {
    const container = JSON.parse(docker(["inspect", name]))[0];
    if (container.Name !== `/${name}` || container.Config.Labels?.project !== "postora" || container.Config.Labels?.purpose !== "owner-release-test") {
      throw new Error("Fixture container identity mismatch");
    }
    const networks = Object.keys(container.NetworkSettings.Networks);
    if (!networks.includes(internalNetwork) || networks.some((entry) => entry !== internalNetwork && !(name.endsWith("gateway") && entry === gatewayNetwork))) {
      throw new Error("Fixture service has an unexpected network");
    }
    const published = Object.values(container.NetworkSettings.Ports ?? {}).flatMap((bindings) => bindings ?? []);
    if (published.some((binding) => binding.HostIp !== "127.0.0.1") || (!name.endsWith("gateway") && published.length)) {
      throw new Error("Fixture publishes a non-loopback or unexpected service port");
    }
  }
  const shape = sql(authShapeQuery);
  const activeSchedules = sql("SELECT count(*) FROM cron.job WHERE active");
  const cronLaunch = sql("SHOW cron.launch_active_jobs");
  if (shape !== baseline.authColumnShapeMd5 || activeSchedules !== "0" || cronLaunch !== "off") {
    throw new Error(`Fixture auth shape or inactive schedules do not match: shape=${JSON.stringify(shape)}, active=${JSON.stringify(activeSchedules)}, cronLaunch=${JSON.stringify(cronLaunch)}`);
  }
  console.log("Verified isolated local fixture identities, auth column shape, disabled cron launcher and zero active schedules. No release approval.");
}

async function prepare() {
  if (process.env.DOCKER_HOST) assertLocalDockerSocket(process.env.DOCKER_HOST);
  const context = JSON.parse(docker(["context", "inspect"]))[0];
  assertLocalDockerSocket(context.Endpoints?.docker?.Host);
  if (process.argv.length === 3 && process.argv[2] === "--verify-existing") return validateExisting();
  if (process.argv.length > 2) throw new Error("Usage: prepare-instagram-owner-release.mjs [--verify-existing]");
  const existing = docker(["ps", "-a", "--format", "{{.Names}} "]).trim().split(/\s+/);
  const existingNetworks = docker(["network", "ls", "--format", "{{.Name}}"]).trim().split(/\s+/);
  if (names.some((name) => existing.includes(name)) || [internalNetwork, gatewayNetwork].some((name) => existingNetworks.includes(name))) {
    throw new Error("Refusing to replace existing owner-release containers/networks; inspect them separately");
  }
  if (existing.some((name) => name.startsWith("postorasupabase-supabase-j8axyh"))) throw new Error("Refusing fixture preparation on the production-stack Docker host");
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assertOwnerExecutionSource(root, candidate);
  labels.push("--label", `postora.owner-candidate=${candidate}`);
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "postora-owner-release-prepare-"));
  const archive = join(evidenceDirectory, "database-inputs.tar");
  execFileSync("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", `--output=${archive}`, candidate, "scripts/db-harness.sh", "supabase/tests", "supabase/migrations"], { cwd: root });
  docker(["network", "create", "--internal", ...labels, internalNetwork]);
  docker(["network", "create", ...labels, gatewayNetwork]);
  docker(["run", "-d", "--name", names[0], ...labels, "--network", internalNetwork, "-e", `POSTGRES_PASSWORD=${databasePassword}`, "supabase/postgres:17.6.1.158", "-c", "listen_addresses=*", "-c", `cron.database_name=${OWNER_RELEASE.database}`, "-c", "cron.launch_active_jobs=off", "-c", "shared_preload_libraries=pg_cron,pg_net,pgsodium,supabase_vault"]);
  await waitForReady(() => {
    // The image's bootstrap postmaster accepts Unix sockets before migrations finish; the harness uses TCP.
    try {
      return docker(["exec", "-e", `PGPASSWORD=${databasePassword}`, names[0], "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SELECT rolsuper FROM pg_roles WHERE rolname=current_user"]).trim() === "t";
    } catch { return false; }
  }, "Disposable Postgres");
  docker(["exec", names[0], "mkdir", "-p", "/owner-release-repo"]);
  docker(["cp", archive, `${names[0]}:/tmp/owner-release-inputs.tar`]);
  docker(["exec", names[0], "tar", "-xf", "/tmp/owner-release-inputs.tar", "-C", "/owner-release-repo"]);
  console.log(`Preparing isolated baseline/delta database for ${candidate}`);
  let harnessLog;
  try {
    harnessLog = docker(["exec", "-e", `HARNESS_DB_NAME=${OWNER_RELEASE.database}`, names[0], "bash", "/owner-release-repo/scripts/db-harness.sh", `postgres://supabase_admin:${databasePassword}@localhost:5432/postgres`]);
  } catch (error) {
    // Preserve only the isolated fixture's diagnostics; do not turn a failed restore into an empty receipt.
    writeFileSync(join(evidenceDirectory, "database-harness.log"), `${error.cause?.stdout ?? ""}\n${error.cause?.stderr ?? ""}`);
    writeFileSync(join(evidenceDirectory, "postgres-startup.log"), docker(["logs", names[0]]));
    throw error;
  }
  writeFileSync(join(evidenceDirectory, "database-harness.log"), harnessLog);
  if (sql(authShapeQuery) !== baseline.authColumnShapeMd5 || !baseline.versions.every((version) => /^(00|\d{14})$/.test(version))) throw new Error("Auth baseline metadata does not match");
  sql(`UPDATE cron.job SET active=false;
ALTER ROLE supabase_auth_admin WITH PASSWORD '${databasePassword}';
ALTER ROLE authenticator WITH PASSWORD '${databasePassword}';
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
DO $ownership$ DECLARE entry record; BEGIN
FOR entry IN SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relkind IN ('r','S','v') LOOP
EXECUTE format('ALTER %s auth.%I OWNER TO supabase_auth_admin',CASE entry.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END,entry.relname);
END LOOP; END $ownership$;
INSERT INTO auth.schema_migrations(version) SELECT jsonb_array_elements_text('${JSON.stringify(baseline.versions)}'::jsonb) ON CONFLICT DO NOTHING;`);
  const authEnvironment = {
    "GOTRUE_API_HOST": "0.0.0.0", "GOTRUE_API_PORT": "9999", "GOTRUE_DB_DRIVER": "postgres",
    "GOTRUE_DB_DATABASE_URL": `postgres://supabase_auth_admin:${databasePassword}@${names[0]}:5432/${OWNER_RELEASE.database}`,
    "GOTRUE_SITE_URL": "http://127.0.0.1:8080", "API_EXTERNAL_URL": `${OWNER_RELEASE.apiUrl}/auth/v1`,
    "GOTRUE_JWT_SECRET": OWNER_RELEASE.signingSecret, "GOTRUE_JWT_EXP": "3600", "GOTRUE_JWT_AUD": "authenticated",
    "GOTRUE_JWT_ADMIN_ROLES": "service_role", "GOTRUE_EXTERNAL_EMAIL_ENABLED": "true", "GOTRUE_MAILER_AUTOCONFIRM": "true", "GOTRUE_DISABLE_SIGNUP": "false", "GOTRUE_LOG_LEVEL": "warn",
  };
  docker(["run", "-d", "--name", names[1], ...labels, "--network", internalNetwork, ...Object.entries(authEnvironment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), baseline.authImage]);
  docker(["run", "-d", "--name", names[2], ...labels, "--network", internalNetwork, "-e", `PGRST_DB_URI=postgres://authenticator:${databasePassword}@${names[0]}:5432/${OWNER_RELEASE.database}`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${OWNER_RELEASE.signingSecret}`, "-e", "PGRST_DB_MAX_ROWS=1000", "postgrest/postgrest:v12.2.11"]);
  docker(["run", "-d", "--name", names[3], ...labels, "--network", gatewayNetwork, "-p", "127.0.0.1:65435:9999", "-p", "127.0.0.1:65436:3000", "-e", "OWNER_RELEASE_GATEWAY=1", "-v", `${join(fixture, "instagramOwnerReleaseGateway.mjs")}:/fixture/gateway.mjs:ro`, "node:22-alpine", "node", "/fixture/gateway.mjs"]);
  docker(["network", "connect", internalNetwork, names[3]]);
  await waitForReady(async () => {
    try { return (await fetch(`${OWNER_RELEASE.authUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  }, "Local Auth");
  validateExisting();
  const images = names.map((name) => {
    const container = JSON.parse(docker(["inspect", name]))[0];
    return { container: name, image: container.Config.Image, imageId: container.Image };
  });
  writeFileSync(join(evidenceDirectory, "candidate.json"), `${JSON.stringify({ candidate, authBaseline: baseline, images }, null, 2)}\n`);
  console.log(`Fixture preparation complete. Local evidence: ${evidenceDirectory}. Seed and start the fixture server next.`);
}

try { await prepare(); } catch (error) {
  console.error(`Owner-release preparation failed: ${error.message.split("\n")[0]}`);
  process.exitCode = 1;
}
