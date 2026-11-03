import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalDockerSocket } from "../e2e/fixtures/instagramOwnerReleaseSafety.mjs";

const EXECUTION_PATHS = [
  "src", "supabase", "e2e", "scripts", ".github/workflows", "public",
  "package.json", "package-lock.json", "index.html", "vite.config.ts", "tsconfig*.json",
  "tailwind.config.ts", "postcss.config.js", "playwright.owner-analytics.config.ts", "playwright.instagram-release.config.ts", ".env*",
];

export function assertOwnerExecutionSource(root, candidate) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
  const head = git("rev-parse", "HEAD").trim();
  if (!/^[a-f0-9]{40}$/.test(candidate) || head !== candidate) {
    throw new Error("Owner fixture and executed checkout must use the same immutable candidate");
  }
  // Check both the index and working tree; include ignored inputs such as local Vite env files.
  git("diff", "--quiet", candidate, "--", ...EXECUTION_PATHS);
  if (git("ls-files", "--others", "--", ...EXECUTION_PATHS).trim()) {
    throw new Error("Owner execution inputs contain uncommitted files; use a clean candidate checkout");
  }
  return head;
}

/** @param {string} root @param {(file: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => string} command */
export function assertPreparedOwnerExecutionSource(root, command = execFileSync) {
  if (process.env.DOCKER_HOST) assertLocalDockerSocket(process.env.DOCKER_HOST);
  const context = JSON.parse(command("docker", ["context", "inspect"], { encoding: "utf8", stdio: "pipe" }))[0];
  assertLocalDockerSocket(context?.Endpoints?.docker?.Host);
  const candidate = command("docker", ["inspect", "--format", '{{ index .Config.Labels "postora.owner-candidate" }}', "postora-owner-release-pg"],
    { encoding: "utf8", stdio: "pipe" }).trim();
  return assertOwnerExecutionSource(root, candidate);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertPreparedOwnerExecutionSource(process.cwd());
}
