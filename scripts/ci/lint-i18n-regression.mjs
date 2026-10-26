#!/usr/bin/env node
// Honest lint + Arabic i18n gate.
//
// Exit 0 means the proposed merge adds no diagnostics in any lane and does not
// dirty the feature-clean manifest. It does not mean `npm run lint` or
// `npm run check:i18n` are clean. Historical debt stays visible in the report
// counts. A higher total in the inline-disabled lane is not an allowance and
// is not a baseline shift: the same immutable base is recomputed in that mode.
//
// Two ESLint lanes share the pinned binary, config, and source coverage:
// ordinary messages (inline config left on) and messages with inline config
// disabled (`--no-inline-config`). Ordinary suppressedMessages are a third
// comparison. Each lane must add zero findings, and a feature-clean path must
// have zero findings in each lane. The JSON artifact keeps the full normalized
// base, head, and merge reports for every lane, plus exits and tool hashes.
//
// Baseline is an immutable commit: the pull_request event base SHA, or, on a
// branch push, the merge-base with a pinned origin/main. A missing base, a
// base equal to head, or a failed tool is a failure. Install failure is not
// an empty baseline. An omitted suppressedMessages array is not an empty one.
//
// Comment policy reads comments the pinned TypeScript parser reports.
// parseUnifiedDiff only records changed lines: a diff line has no token
// context, so a string, template, regex, or mention of a directive is not one.
// Disable comments keep their existing signatures. Inline rule-configuration
// comments (block comments whose label is eslint) are rejected when new or
// changed, without deciding whether a severity is weaker. A source file that
// fails to parse fails the gate closed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, "../..");
const CHECKER_RELATIVE = "scripts/check-i18n-coverage.mjs";
export const STRUCTURED_START = "// STRUCTURED_OUTPUT_REGION\n";
export const STRUCTURED_END = "// END_STRUCTURED_OUTPUT_REGION\n";

const ESLINT_PACKAGES = [
  "eslint",
  "@eslint/js",
  "typescript-eslint",
  "eslint-plugin-react-hooks",
  "eslint-plugin-react-refresh",
  "globals",
];
const ESLINT_LOCK_PATHS = [
  "node_modules/eslint",
  "node_modules/@eslint/js",
  "node_modules/typescript-eslint",
  "node_modules/@typescript-eslint/eslint-plugin",
  "node_modules/@typescript-eslint/parser",
  "node_modules/eslint-plugin-react-hooks",
  "node_modules/eslint-plugin-react-refresh",
  "node_modules/globals",
];
const CONFIG_FILES = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintignore"];
const SHA_RE = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/i;
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

export class GateError extends Error {
  constructor(reason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
    this.detail = detail;
  }
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isCommitSha(value) {
  return typeof value === "string" && SHA_RE.test(value) && !ZERO_SHA.test(value);
}

export function stripStructuredRegion(source) {
  const text = String(source).replace(/\r\n/g, "\n");
  const start = text.indexOf(STRUCTURED_START);
  if (start === -1) {
    if (text.includes("STRUCTURED_OUTPUT_REGION")) {
      throw new GateError("i18n_checker_region", "structured region marker is incomplete");
    }
    return text;
  }
  const end = text.indexOf(STRUCTURED_END, start);
  if (end === -1) throw new GateError("i18n_checker_region", "structured region has no end marker");
  return text.slice(0, start) + text.slice(end + STRUCTURED_END.length);
}

export function compileGlob(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\\")) {
    throw new GateError("manifest_glob", String(pattern));
  }
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith("**/", i)) {
      regex += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (pattern.startsWith("**", i)) {
      regex += ".*";
      i += 1;
      continue;
    }
    const ch = pattern[i];
    if (ch === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
  }
  regex += "$";
  return new RegExp(regex);
}

export function matchesAnyGlob(filePath, globs) {
  const posix = String(filePath).split("\\").join("/");
  return globs.some((pattern) => compileGlob(pattern).test(posix));
}

export function selectBaseline({ eventName, refName, baseSha, headSha, mergeBaseSha, beforeSha }) {
  if (!isCommitSha(headSha)) return { ok: false, reason: "invalid_head" };
  const head = headSha.toLowerCase();
  if (eventName === "pull_request") {
    if (!isCommitSha(baseSha)) return { ok: false, reason: "invalid_base" };
    const base = baseSha.toLowerCase();
    if (base === head) return { ok: false, reason: "self_baseline" };
    return { ok: true, baseSha: base, headSha: head, mode: "pull_request_event_base" };
  }
  if (eventName === "push") {
    if (refName === "refs/heads/main") {
      if (!isCommitSha(beforeSha)) return { ok: false, reason: "invalid_base" };
      const base = beforeSha.toLowerCase();
      if (base === head) return { ok: false, reason: "self_baseline" };
      return { ok: true, baseSha: base, headSha: head, mode: "push_main_before" };
    }
    if (!isCommitSha(mergeBaseSha)) return { ok: false, reason: "invalid_base" };
    const base = mergeBaseSha.toLowerCase();
    if (base === head) return { ok: false, reason: "self_baseline" };
    return { ok: true, baseSha: base, headSha: head, mode: "push_merge_base" };
  }
  if (eventName === "explicit") {
    if (!isCommitSha(baseSha)) return { ok: false, reason: "invalid_base" };
    const base = baseSha.toLowerCase();
    if (base === head) return { ok: false, reason: "self_baseline" };
    return { ok: true, baseSha: base, headSha: head, mode: "explicit_refs" };
  }
  return { ok: false, reason: "invalid_event" };
}

export function loadCleanManifest(raw) {
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!manifest || !Array.isArray(manifest.cleanPathGlobs) || manifest.cleanPathGlobs.length === 0) {
    throw new GateError("manifest_missing", "cleanPathGlobs");
  }
  if (!Array.isArray(manifest.cleanI18nNamespaces) || manifest.cleanI18nNamespaces.length === 0) {
    throw new GateError("manifest_missing", "cleanI18nNamespaces");
  }
  for (const item of manifest.cleanI18nNamespaces) {
    if (!item || item.locale !== "ar" || typeof item.namespace !== "string" || item.namespace.length === 0) {
      throw new GateError("manifest_namespace", JSON.stringify(item));
    }
  }
  if (manifest.ignorePathGlobs || manifest.ignoreNamespaces) {
    throw new GateError("manifest_ignore", "namespace or path ignore lists are not allowed");
  }
  for (const pattern of manifest.cleanPathGlobs) compileGlob(pattern);
  return manifest;
}

export function eslintPackageSpecifiers(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  const specifiers = {};
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of ESLINT_PACKAGES) {
      if (pkg[section] && Object.prototype.hasOwnProperty.call(pkg[section], name)) {
        specifiers[`${section}:${name}`] = pkg[section][name];
      }
    }
  }
  if (!specifiers["devDependencies:eslint"]) {
    throw new GateError("eslint_package_missing", "devDependencies.eslint");
  }
  return specifiers;
}

export function eslintLockPins(lockText) {
  const lock = JSON.parse(lockText);
  const packages = lock.packages ?? {};
  const pins = {};
  for (const key of ESLINT_LOCK_PATHS) {
    const entry = packages[key];
    if (!entry || typeof entry.version !== "string" || typeof entry.integrity !== "string") {
      throw new GateError("eslint_lock_missing", key);
    }
    pins[key] = { version: entry.version, integrity: entry.integrity };
  }
  return pins;
}

export function compareAnalyzer(input) {
  const differences = [];
  const hashes = {};
  const record = (name, left, right) => {
    const leftHash = sha256Text(left);
    const rightHash = sha256Text(right);
    hashes[name] = { left: leftHash, right: rightHash };
    if (leftHash !== rightHash) differences.push(name);
  };
  record("eslint_config_base_head", input.baseConfig, input.headConfig);
  record("eslint_config_executed_head", input.executedConfig, input.headConfig);
  record("eslintignore_base_head", input.baseIgnore, input.headIgnore);
  try {
    const baseSpec = JSON.stringify(eslintPackageSpecifiers(input.basePackageJson));
    const headSpec = JSON.stringify(eslintPackageSpecifiers(input.headPackageJson));
    record("package_json_eslint", baseSpec, headSpec);
  } catch (err) {
    differences.push(err.reason || "package_json_eslint");
  }
  try {
    const basePins = JSON.stringify(eslintLockPins(input.baseLock));
    const headPins = JSON.stringify(eslintLockPins(input.headLock));
    record("lock_eslint", basePins, headPins);
    const headVersion = eslintLockPins(input.headLock)["node_modules/eslint"].version;
    if (input.installedEslintVersion !== headVersion) differences.push("installed_eslint");
    hashes.installedEslintVersion = input.installedEslintVersion;
    hashes.headLockEslintVersion = headVersion;
  } catch (err) {
    differences.push(err.reason || "lock_eslint");
  }
  let detectionEqual = false;
  try {
    const baseDetection = stripStructuredRegion(input.baseChecker);
    const headDetection = stripStructuredRegion(input.headChecker);
    const executedDetection = stripStructuredRegion(input.executedChecker);
    detectionEqual = baseDetection === headDetection && baseDetection === executedDetection;
    hashes.i18nDetection = {
      base: sha256Text(baseDetection),
      head: sha256Text(headDetection),
      executed: sha256Text(executedDetection),
    };
    if (!detectionEqual) differences.push("i18n_detection");
    if (input.mergeChecker != null && stripStructuredRegion(input.mergeChecker) !== baseDetection) {
      differences.push("i18n_detection_merge");
    }
    if (input.mergeConfig != null) record("eslint_config_base_merge", input.baseConfig, input.mergeConfig);
  } catch (err) {
    differences.push(err.reason || "i18n_checker_region");
  }
  hashes.i18nChecker = {
    base: sha256Text(input.baseChecker),
    head: sha256Text(input.headChecker),
    executed: sha256Text(input.executedChecker),
  };
  const structuredOutputOnly = differences.length === 0
    && hashes.i18nChecker.base !== hashes.i18nChecker.executed
    && detectionEqual;
  return { equal: differences.length === 0, differences, hashes, structuredOutputOnly };
}

export function sliceSource(source, message) {
  if (!message || !Number.isInteger(message.line) || !Number.isInteger(message.column)
    || !Number.isInteger(message.endLine) || !Number.isInteger(message.endColumn)) {
    return null;
  }
  const lines = String(source).split("\n");
  if (message.line < 1 || message.endLine < message.line || message.endLine > lines.length) return null;
  if (message.line === message.endLine) {
    const text = lines[message.line - 1].slice(message.column - 1, message.endColumn - 1);
    return text.length > 0 ? stableAnchor(text) : null;
  }
  const parts = [lines[message.line - 1].slice(message.column - 1)];
  for (let line = message.line + 1; line < message.endLine; line++) parts.push(lines[line - 1]);
  parts.push(lines[message.endLine - 1].slice(0, message.endColumn - 1));
  const text = parts.join("\n");
  return text.length > 0 ? stableAnchor(text) : null;
}

function stableAnchor(text) {
  if (text.length <= 180) return text;
  return `sha256:${sha256Text(text)}:${text.slice(0, 80)}`;
}

function lintFindingFromMessage(file, message) {
  if (!message || message.fatal || message.ruleId == null || typeof message.message !== "string") {
    return null;
  }
  const anchor = sliceSource(file.source ?? "", message);
  if (!anchor || !Number.isInteger(message.severity)) return null;
  return {
    kind: "lint",
    path: file.filePath,
    rule: message.ruleId,
    severity: message.severity,
    message: message.message,
    anchor,
    line: message.line,
    column: message.column,
    category: null,
    locale: null,
    namespace: null,
    key: null,
  };
}

function suppressionMetadata(message) {
  if (!message || !Array.isArray(message.suppressions) || message.suppressions.length === 0) return null;
  const metadata = [];
  for (const entry of message.suppressions) {
    if (!entry || typeof entry.kind !== "string" || entry.kind.length === 0 || typeof entry.justification !== "string") {
      return null;
    }
    metadata.push({ kind: entry.kind, justification: entry.justification });
  }
  return metadata;
}

export function normalizeEslintReport(payload) {
  if (!Array.isArray(payload)) return { ok: false, reason: "eslint_json_not_array" };
  const findings = [];
  const suppressedFindings = [];
  let errorCount = 0;
  let warningCount = 0;
  let fatalCount = 0;
  for (const file of payload) {
    if (!file || typeof file.filePath !== "string" || !Array.isArray(file.messages)) {
      return { ok: false, reason: "eslint_file_incomplete" };
    }
    if (!Array.isArray(file.suppressedMessages)) {
      return { ok: false, reason: "eslint_suppressed_missing", path: file.filePath };
    }
    errorCount += file.errorCount ?? 0;
    warningCount += file.warningCount ?? 0;
    fatalCount += file.fatalErrorCount ?? 0;
    if ((file.messages.length) !== (file.errorCount ?? 0) + (file.warningCount ?? 0)) {
      return { ok: false, reason: "eslint_count_mismatch", path: file.filePath };
    }
    for (const message of file.messages) {
      if (message.fatal || message.ruleId == null) {
        return { ok: false, reason: "eslint_fatal_message", path: file.filePath };
      }
      const finding = lintFindingFromMessage(file, message);
      if (!finding) {
        return {
          ok: false,
          reason: "eslint_message_missing_span",
          path: file.filePath,
          rule: message.ruleId,
        };
      }
      findings.push(finding);
    }
    for (const message of file.suppressedMessages) {
      const metadata = suppressionMetadata(message);
      const finding = metadata ? lintFindingFromMessage(file, message) : null;
      if (!metadata || !finding) {
        return {
          ok: false,
          reason: metadata ? "eslint_message_missing_span" : "eslint_suppression_incomplete",
          path: file.filePath,
          rule: message?.ruleId ?? null,
        };
      }
      suppressedFindings.push({ ...finding, suppressions: metadata });
    }
  }
  if (findings.length !== errorCount + warningCount) {
    return { ok: false, reason: "eslint_count_mismatch" };
  }
  return {
    ok: true,
    findings,
    suppressedFindings,
    errorCount,
    warningCount,
    fatalCount,
    fileCount: payload.length,
  };
}

export function relativizeFindings(findings, rootDir) {
  return findings.map((finding) => {
    const abs = isAbsolute(finding.path) ? finding.path : resolve(rootDir, finding.path);
    const rel = relative(rootDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new GateError("path_escapes_snapshot", finding.path);
    }
    return { ...finding, path: rel.split(sep).join("/") };
  });
}

export function i18nToFindings(payload) {
  if (!payload || !Array.isArray(payload.findings)) {
    throw new GateError("i18n_report_incomplete", "findings");
  }
  return payload.findings.map((finding) => ({
    kind: "i18n",
    path: String(finding.path).split("\\").join("/"),
    rule: null,
    severity: null,
    message: null,
    anchor: finding.anchor,
    line: finding.line ?? null,
    column: finding.column ?? null,
    category: finding.category,
    locale: finding.locale,
    namespace: finding.namespace ?? null,
    key: finding.key ?? null,
  }));
}

export function classifyEslintRun(exitCode, normalized) {
  if (exitCode !== 0 && exitCode !== 1) return { ok: false, reason: `eslint_exit_${exitCode}` };
  if (!normalized || !normalized.ok) return { ok: false, reason: normalized?.reason ?? "eslint_report_incomplete" };
  if (normalized.fatalCount > 0) return { ok: false, reason: "eslint_fatal_message" };
  if ((exitCode === 0) !== (normalized.errorCount === 0)) return { ok: false, reason: "eslint_exit_inconsistent" };
  return { ok: true };
}

export function classifyI18nRun(exitCode, payload) {
  if (exitCode !== 0 && exitCode !== 1) return { ok: false, reason: `i18n_exit_${exitCode}` };
  if (!payload || !Array.isArray(payload.findings) || !Number.isInteger(payload.failureCount) || payload.failureCount < 0) {
    return { ok: false, reason: "i18n_report_incomplete" };
  }
  if ((exitCode === 0) !== (payload.failureCount === 0)) return { ok: false, reason: "i18n_exit_inconsistent" };
  for (const finding of payload.findings) {
    if (typeof finding.anchor !== "string" || finding.anchor.length === 0) {
      return { ok: false, reason: "i18n_finding_incomplete" };
    }
    if (typeof finding.path !== "string" || typeof finding.category !== "string" || finding.locale !== "ar") {
      return { ok: false, reason: "i18n_finding_incomplete" };
    }
  }
  return { ok: true };
}

export function parseNameStatusZ(text) {
  const parts = String(text).split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  const renames = [];
  const added = new Set();
  const deleted = new Set();
  let ambiguous = null;
  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    if (!status) {
      ambiguous = "empty git status";
      break;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[i + 1];
      const to = parts[i + 2];
      const score = Number(status.slice(1));
      if (!from || !to || !Number.isFinite(score)) {
        ambiguous = `truncated rename status ${status}`;
        break;
      }
      if (score < 80) {
        ambiguous = `rename score ${score} is below 80`;
        break;
      }
      if (status.startsWith("R")) renames.push({ from, to, score });
      else added.add(to);
      i += 3;
      continue;
    }
    const file = parts[i + 1];
    if (!file) {
      ambiguous = `truncated status ${status}`;
      break;
    }
    if (status === "A") added.add(file);
    else if (status === "D") deleted.add(file);
    else if (status !== "M") {
      ambiguous = `unexpected git status ${status}`;
      break;
    }
    i += 2;
  }
  const destinations = new Set();
  const sources = new Set();
  for (const rename of renames) {
    if (destinations.has(rename.to) || sources.has(rename.from) || added.has(rename.to)) {
      ambiguous = `ambiguous rename ${rename.from} -> ${rename.to}`;
      break;
    }
    destinations.add(rename.to);
    sources.add(rename.from);
  }
  return { renames, added, deleted, ambiguous };
}

export function parseUnifiedDiff(text) {
  const changed = new Map();
  const opaque = [];
  let path = null;
  let newLine = 0;
  let ambiguous = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("Binary files ")) {
      opaque.push(line);
      path = null;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      path = raw === "/dev/null" ? null : unquoteGitPath(raw.replace(/^b\//, ""));
      if (path === null && raw !== "/dev/null") ambiguous = `unparsed diff path ${raw}`;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!path) {
        ambiguous = "diff addition without a path";
        break;
      }
      if (!changed.has(path)) changed.set(path, new Set());
      changed.get(path).add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") || line.startsWith("\\")) continue;
  }
  for (const entry of opaque) {
    if (/\.(?:tsx?|jsx?|mjs|cjs|json)(?:\s|"|$)/.test(entry)) {
      ambiguous = `opaque source diff: ${entry}`;
      break;
    }
  }
  return { changed, ambiguous };
}

function unquoteGitPath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return null;
  const body = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...Buffer.from(body[i]));
      continue;
    }
    const next = body[++i];
    if (next === "\\" || next === '"') bytes.push(next.charCodeAt(0));
    else if (next === "n") bytes.push(10);
    else if (next === "t") bytes.push(9);
    else if (next >= "0" && next <= "7") {
      let oct = next;
      for (let k = 0; k < 2 && body[i + 1] >= "0" && body[i + 1] <= "7"; k++) oct += body[++i];
      bytes.push(parseInt(oct, 8));
    } else return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

// ESLint applies a directive only when the comment body starts with the label.
// Line comments accept disable-line and disable-next-line. Block comments also
// accept disable, enable, and eslint (inline rule configuration). enable is
// not itself a suppression; it bounds a range disable. The eslint label keeps
// the configuration text verbatim and does not interpret severities.
const SUPPRESSION_LABEL = /^(eslint-disable-next-line|eslint-disable-line|eslint-disable|eslint-enable|eslint)(?=\s|$)/u;
const LINE_DISABLE_LABELS = new Set(["eslint-disable-next-line", "eslint-disable-line"]);

let typescriptModule;

function loadTypescript() {
  if (!typescriptModule) {
    try {
      typescriptModule = createRequire(import.meta.url)("typescript");
    } catch (err) {
      throw new GateError("typescript_parser_missing", err.message);
    }
  }
  return typescriptModule;
}

function scriptKindForPath(filePath) {
  const ts = loadTypescript();
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) return ts.ScriptKind.JS;
  return null;
}

function sourceLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function splitJustification(value) {
  const match = /\s-{2,}\s/u.exec(value);
  if (!match) return value.trim();
  return value.slice(0, match.index).trim();
}

function parseRuleList(value) {
  const rules = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim().replace(/^(?<quote>['"]?)(?<ruleId>.*)\k<quote>$/su, "$<ruleId>").trim();
    if (trimmed) rules.push(trimmed);
  }
  return rules.length > 0 ? rules : null;
}

function commentBody(raw) {
  if (raw.startsWith("//")) return { kind: "line", value: raw.slice(2) };
  if (raw.startsWith("/*") && raw.endsWith("*/") && raw.length >= 4) return { kind: "block", value: raw.slice(2, -2) };
  return null;
}

function parseDirectiveComment(raw) {
  const body = commentBody(raw);
  if (!body) return null;
  const directivePart = splitJustification(body.value);
  const match = SUPPRESSION_LABEL.exec(directivePart);
  if (!match) return null;
  const label = match[1];
  if (body.kind === "line" && !LINE_DISABLE_LABELS.has(label)) return null;
  if (label === "eslint") {
    if (body.kind !== "block") return null;
    return {
      label,
      kind: body.kind,
      rules: null,
      configText: directivePart.slice(label.length).trim(),
    };
  }
  return {
    label,
    kind: body.kind,
    rules: parseRuleList(directivePart.slice(label.length)),
    configText: "",
  };
}

function ruleKey(rules) {
  if (rules == null) return "*";
  return [...rules].sort().join(",");
}

function codeOnLine(lines, starts, spans, lineNumber) {
  if (lineNumber < 1 || lineNumber > lines.length) return "";
  const lineStart = starts[lineNumber - 1];
  const lineText = lines[lineNumber - 1];
  const lineEnd = lineStart + lineText.length;
  let code = lineText;
  const cuts = spans
    .filter((span) => span.end > lineStart && span.start < lineEnd)
    .map((span) => ({
      from: Math.max(0, span.start - lineStart),
      to: Math.min(lineText.length, span.end - lineStart),
    }))
    .sort((left, right) => right.from - left.from);
  for (const cut of cuts) code = `${code.slice(0, cut.from)}${code.slice(cut.to)}`;
  return code.replace(/\s+/g, " ").trim();
}

function firstCodeBetween(text, spans, fromOffset, toOffset) {
  if (fromOffset >= toOffset) return "";
  const hidden = new Array(toOffset - fromOffset).fill(false);
  for (const span of spans) {
    const from = Math.max(0, span.start - fromOffset);
    const to = Math.min(hidden.length, span.end - fromOffset);
    for (let index = from; index < to; index++) hidden[index] = true;
  }
  let line = "";
  const collapsed = () => line.replace(/\s+/g, " ").trim();
  for (let index = 0; index < hidden.length; index++) {
    const ch = text[fromOffset + index];
    if (ch === "\n") {
      const code = collapsed();
      if (code) return code;
      line = "";
      continue;
    }
    line += hidden[index] ? " " : ch;
  }
  return collapsed();
}

function rangeAnchor(directives, index, text, spans) {
  const directive = directives[index];
  const pending = directive.rules == null ? null : new Set(directive.rules);
  const bounds = [];
  let closedAt = text.length;
  for (let cursor = index + 1; cursor < directives.length; cursor++) {
    const candidate = directives[cursor];
    if (candidate.label !== "eslint-enable" || candidate.kind !== "block") continue;
    const blanket = candidate.rules == null;
    const closesSome = !blanket && pending != null && candidate.rules.some((rule) => pending.has(rule));
    if (!blanket && !closesSome) continue;
    if (closesSome) {
      for (const rule of candidate.rules) pending.delete(rule);
    }
    bounds.push(`${ruleKey(candidate.rules)}:${firstCodeBetween(text, spans, candidate.end, text.length)}`);
    closedAt = candidate.start;
    if (blanket || pending == null || pending.size === 0) break;
  }
  const inside = firstCodeBetween(text, spans, directive.end, closedAt);
  return `${inside}\0${bounds.length > 0 ? bounds.join("\0") : "EOF"}`;
}

function directiveSignature(directive, directives, index, lines, starts, spans, text) {
  const rules = ruleKey(directive.rules);
  if (directive.label === "eslint-disable-line") {
    return `${directive.label}\0${rules}\0${codeOnLine(lines, starts, spans, directive.line)}`;
  }
  if (directive.label === "eslint-disable-next-line") {
    return `${directive.label}\0${rules}\0${codeOnLine(lines, starts, spans, directive.endLine + 1)}`;
  }
  if (directive.label === "eslint") {
    return `eslint\0${directive.configText}\0${firstCodeBetween(text, spans, directive.end, text.length)}`;
  }
  return `${directive.label}\0${rules}\0${rangeAnchor(directives, index, text, spans)}`;
}

function collectParsedComments(ts, sourceFile, text) {
  const comments = [];
  const seen = new Set();
  const shebang = typeof ts.getShebang === "function" ? (ts.getShebang(text) ?? "") : "";
  const add = (pos, end) => {
    if (seen.has(pos)) return;
    seen.add(pos);
    comments.push({ start: pos, end, raw: text.slice(pos, end) });
  };
  const queue = [sourceFile];
  while (queue.length > 0) {
    let node = queue.pop();
    while (true) {
      if (ts.isTokenKind(node.kind)) {
        const triviaStart = node.pos === 0 ? shebang.length : node.pos;
        if (node.pos !== node.end) {
          ts.forEachLeadingCommentRange(text, triviaStart, add);
          ts.forEachTrailingCommentRange(text, node.end, add);
        }
        break;
      }
      const children = node.getChildren(sourceFile);
      if (children.length === 0) break;
      if (children.length === 1) {
        node = children[0];
        continue;
      }
      for (let index = children.length - 1; index >= 1; index--) queue.push(children[index]);
      node = children[0];
    }
  }
  comments.sort((left, right) => left.start - right.start);
  return comments;
}

export function extractSuppressionDirectives(source, filePath) {
  const scriptKind = scriptKindForPath(filePath);
  if (scriptKind == null) return { ok: false, directives: [], detail: `unsupported source ${filePath}` };
  const ts = loadTypescript();
  const text = String(source).replace(/\r\n/g, "\n");
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  } catch (err) {
    return { ok: false, directives: [], detail: err.message };
  }
  if (sourceFile.parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, " ");
    return { ok: false, directives: [], detail: message };
  }
  const comments = collectParsedComments(ts, sourceFile, text);
  const spans = comments.map((comment) => ({ start: comment.start, end: comment.end }));
  const lines = sourceLines(text);
  const starts = lineStarts(text);
  const directives = [];
  for (const comment of comments) {
    const parsed = parseDirectiveComment(comment.raw);
    if (!parsed) continue;
    const line = lineAt(starts, comment.start);
    const endLine = lineAt(starts, Math.max(comment.start, comment.end - 1));
    directives.push({
      ...parsed,
      line,
      endLine,
      start: comment.start,
      end: comment.end,
      text: comment.raw.replace(/\s+/g, " ").trim(),
    });
  }
  const reported = [];
  for (let index = 0; index < directives.length; index++) {
    const directive = directives[index];
    if (directive.label === "eslint-enable") continue;
    reported.push({
      line: directive.line,
      text: directive.text,
      signature: directiveSignature(directive, directives, index, lines, starts, spans, text),
    });
  }
  return { ok: true, directives: reported, detail: "" };
}

export function diffSuppressionDirectives(baseSource, headSource, filePath) {
  const base = extractSuppressionDirectives(baseSource ?? "", filePath);
  if (!base.ok) return { ok: false, suppressions: [], detail: `base ${filePath}: ${base.detail}` };
  const head = extractSuppressionDirectives(headSource ?? "", filePath);
  if (!head.ok) return { ok: false, suppressions: [], detail: `head ${filePath}: ${head.detail}` };
  const available = new Map();
  for (const directive of base.directives) {
    available.set(directive.signature, (available.get(directive.signature) ?? 0) + 1);
  }
  const suppressions = [];
  for (const directive of head.directives) {
    const remaining = available.get(directive.signature) ?? 0;
    if (remaining > 0) {
      available.set(directive.signature, remaining - 1);
      continue;
    }
    suppressions.push({ path: filePath, line: directive.line, text: directive.text });
  }
  return { ok: true, suppressions, detail: "" };
}

function decodeSourceBytes(bytes) {
  if (bytes.includes(0)) return { ok: false, detail: "NUL byte" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

function readGitBlob(repo, treeish, filePath) {
  const result = spawnSync("git", ["cat-file", "-p", `${treeish}:${filePath}`], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr?.toString?.() || "git cat-file failed"}`.slice(0, 500);
    return { ok: false, detail };
  }
  return { ok: true, bytes: result.stdout };
}

function suppressionDelta(repo, fromSha, toTree, names, unified) {
  if (names.ambiguous || unified.ambiguous) return { suppressions: [], ambiguous: null };
  const basePathByHead = new Map(names.renames.map((rename) => [rename.to, rename.from]));
  const paths = [...new Set([...unified.changed.keys(), ...names.added])].sort();
  const suppressions = [];
  for (const filePath of paths) {
    if (!scriptKindForPath(filePath)) continue;
    const renamedFrom = basePathByHead.get(filePath);
    const basePath = renamedFrom ?? (names.added.has(filePath) ? null : filePath);
    let baseSource = "";
    if (basePath) {
      const blob = readGitBlob(repo, fromSha, basePath);
      if (!blob.ok) return { suppressions: [], ambiguous: `suppression blob missing ${fromSha}:${basePath}: ${blob.detail}` };
      const decoded = decodeSourceBytes(blob.bytes);
      if (!decoded.ok) return { suppressions: [], ambiguous: `suppression decode failed ${basePath}: ${decoded.detail}` };
      baseSource = decoded.text;
    }
    const headBlob = readGitBlob(repo, toTree, filePath);
    if (!headBlob.ok) return { suppressions: [], ambiguous: `suppression blob missing ${toTree}:${filePath}: ${headBlob.detail}` };
    const headDecoded = decodeSourceBytes(headBlob.bytes);
    if (!headDecoded.ok) return { suppressions: [], ambiguous: `suppression decode failed ${filePath}: ${headDecoded.detail}` };
    const delta = diffSuppressionDirectives(baseSource, headDecoded.text, filePath);
    if (!delta.ok) return { suppressions: [], ambiguous: delta.detail };
    suppressions.push(...delta.suppressions);
  }
  return { suppressions, ambiguous: null };
}

function findingIdentity(finding) {
  return [
    finding.kind,
    finding.path,
    finding.rule ?? "",
    finding.severity ?? "",
    finding.message ?? "",
    finding.anchor,
    finding.category ?? "",
    finding.locale ?? "",
    finding.namespace ?? "",
    finding.key ?? "",
  ].join("\0");
}

function touchState(finding, diff) {
  if (diff.added.has(finding.path)) return true;
  const lines = diff.changed.get(finding.path);
  if (!lines) return false;
  if (finding.line == null) return "ambiguous";
  return lines.has(finding.line);
}

export function compareDiagnostics({ baseFindings, headFindings, diff, cleanPathGlobs, cleanNamespaces }) {
  if (diff.ambiguous) {
    return emptyComparison("ambiguous_diff", diff.ambiguous);
  }
  const renameTo = new Map(diff.renames.map((rename) => [rename.from, rename.to]));
  const rewrittenBase = baseFindings.map((finding) => (
    renameTo.has(finding.path) ? { ...finding, path: renameTo.get(finding.path) } : finding
  ));
  const inherited = [];
  const forcedNew = [];
  for (const finding of headFindings) {
    if (!finding.anchor) return emptyComparison("incomplete_anchor", finding.path);
    const touched = touchState(finding, diff);
    if (touched === "ambiguous") {
      return emptyComparison("ambiguous_location", `${finding.path} ${finding.category ?? finding.rule}`);
    }
    if (touched) forcedNew.push(finding);
    else inherited.push(finding);
  }
  const baseGroups = groupFindings(rewrittenBase);
  const headGroups = groupFindings(inherited);
  const newDiagnostics = [...forcedNew];
  const resolvedDiagnostics = [];
  const seen = new Set();
  for (const [id, headList] of headGroups) {
    seen.add(id);
    const baseList = baseGroups.get(id) ?? [];
    if (headList.length > baseList.length) newDiagnostics.push(...headList.slice(baseList.length));
    else if (baseList.length > headList.length) resolvedDiagnostics.push(...baseList.slice(headList.length));
  }
  for (const [id, baseList] of baseGroups) {
    if (!seen.has(id)) resolvedDiagnostics.push(...baseList);
  }
  const featurePathViolations = headFindings.filter((finding) => matchesAnyGlob(finding.path, cleanPathGlobs));
  const cleanNamespaceViolations = headFindings.filter((finding) => (
    finding.kind === "i18n" && cleanNamespaces.some((item) => (
      item.locale === finding.locale && item.namespace === finding.namespace
    ))
  ));
  let reason = null;
  if (diff.suppressions.length > 0) reason = "suppression_added";
  else if (featurePathViolations.length > 0) reason = "feature_path_dirty";
  else if (cleanNamespaceViolations.length > 0) reason = "clean_namespace_dirty";
  else if (newDiagnostics.length > 0) reason = "new_diagnostics";
  return {
    ok: reason == null,
    reason,
    newDiagnostics: sortFindings(newDiagnostics),
    resolvedDiagnostics: sortFindings(resolvedDiagnostics),
    featurePathViolations: sortFindings(featurePathViolations),
    cleanNamespaceViolations: sortFindings(cleanNamespaceViolations),
    suppressions: diff.suppressions,
  };
}

function emptyComparison(reason, detail) {
  return {
    ok: false,
    reason,
    detail,
    newDiagnostics: [],
    resolvedDiagnostics: [],
    featurePathViolations: [],
    cleanNamespaceViolations: [],
    suppressions: [],
  };
}

function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const id = findingIdentity(finding);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(finding);
  }
  return groups;
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => findingIdentity(a).localeCompare(findingIdentity(b))
    || (a.line ?? 0) - (b.line ?? 0));
}

export function gateDecision({ analyzerEqual, toolFailure, comparisons }) {
  if (!analyzerEqual) return { ok: false, reason: "analyzer_changed" };
  if (toolFailure) return { ok: false, reason: toolFailure };
  const failed = comparisons.find((comparison) => !comparison.ok);
  if (failed) return { ok: false, reason: failed.reason, detail: failed.detail || "" };
  return { ok: true, reason: null };
}

export function renderSummary(report) {
  const lint = report.counts.lint;
  const i18n = report.counts.i18n;
  const lines = [
    "# Lint/i18n: no regressions",
    "",
    "Green on this job means **no regressions only**. Full lint and full i18n are still expected to report historical debt.",
    "",
    `- Base: \`${report.baseSha}\``,
    `- Head: \`${report.headSha}\``,
    `- Merge tree: \`${report.mergeTreeSha ?? "not created"}\``,
    `- Baseline mode: ${report.baselineMode}`,
    `- Result: ${report.ok ? "NO REGRESSIONS" : report.reason}`,
    "",
    "## Full checker results",
    "",
    "| Tree | Lint exit | Lint errors | Lint warnings | i18n exit | i18n aggregate failures | i18n callsites |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const name of ["base", "head", "merge"]) {
    const lintRow = lint[name];
    const i18nRow = i18n[name];
    lines.push(`| ${name} | ${show(lintRow?.exitCode)} | ${show(lintRow?.errorCount)} | ${show(lintRow?.warningCount)} | ${show(i18nRow?.exitCode)} | ${show(i18nRow?.failureCount)} | ${show(i18nRow?.callsiteCount)} |`);
  }
  const hidden = report.counts?.lintNoInlineConfig;
  const suppressedCounts = report.counts?.suppressed;
  if (hidden) {
    lines.push(
      "",
      "## Inline-disabled lane",
      "",
      "Same pinned ESLint, config, and files, with inline configuration disabled (`--no-inline-config`). Historical totals in this lane are recorded and are not an allowance.",
      "",
      "| Tree | Exit | Errors | Warnings |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const name of ["base", "head", "merge"]) {
      const row = hidden[name];
      lines.push(`| ${name} | ${show(row?.exitCode)} | ${show(row?.errorCount)} | ${show(row?.warningCount)} |`);
    }
  }
  if (suppressedCounts) {
    lines.push(
      "",
      "## Ordinary suppressedMessages",
      "",
      "| Tree | Exit | Suppressed findings |",
      "| --- | ---: | ---: |",
    );
    for (const name of ["base", "head", "merge"]) {
      const row = suppressedCounts[name];
      lines.push(`| ${name} | ${show(row?.exitCode)} | ${show(row?.count)} |`);
    }
  }
  lines.push(
    "",
    "## Comparison of the proposed merge against the immutable base",
    "",
    `- New diagnostics: ${report.newCount}`,
    `- Resolved diagnostics: ${report.resolvedCount}`,
    `- Feature-path violations: ${report.featurePathViolations.length}`,
    `- Clean-namespace violations: ${report.cleanNamespaceViolations.length}`,
    `- Suppressions added: ${report.suppressions.length}`,
  );
  if (report.lanes?.noInlineConfig?.merge) {
    lines.push(`- Inline-disabled new diagnostics: ${report.lanes.noInlineConfig.merge.newCount}`);
  }
  if (report.lanes?.suppressedMessages?.merge) {
    lines.push(`- Newly suppressed findings: ${report.lanes.suppressedMessages.merge.newCount}`);
  }
  if (report.analyzer && report.analyzer.differences?.length) {
    lines.push(`- Analyzer differences: ${report.analyzer.differences.join(", ")}`);
  }
  if (report.analyzer?.structuredOutputOnly) {
    lines.push("- i18n checker bytes differ by the structured-output region only. Detection text matches, and both trees were scanned with that executed checker.");
  }
  if (report.headNewCount != null) lines.push(`- New diagnostics on head versus base: ${report.headNewCount}`);
  if (report.normalizedReports) {
    lines.push("- Full normalized base, head, and merge reports (exits, counts, findings, tool hashes) are in the JSON artifact. Config hashes are on analyzer.hashes.");
  }
  if (report.counts?.lint?.base == null) {
    lines.push("", "Checker counts left blank were not treated as an empty baseline. The job did not finish those runs.");
  }
  lines.push("", "### New diagnostics", "");
  const shown = report.newDiagnostics.slice(0, 40);
  if (shown.length === 0) lines.push("None.");
  for (const finding of shown) lines.push(`- ${formatFinding(finding)}`);
  if (report.newDiagnostics.length > shown.length) {
    lines.push(`- ${report.newDiagnostics.length - shown.length} more new diagnostic(s) are in the JSON artifact.`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function show(value) {
  return value == null ? "n/a" : String(value);
}

function formatFinding(finding) {
  if (finding.kind === "i18n") {
    return `${finding.path}:${finding.line ?? "?"} ${finding.category} ${finding.namespace ?? ""}:${finding.key ?? ""} anchor=${JSON.stringify(finding.anchor)}`;
  }
  return `${finding.path}:${finding.line ?? "?"} ${finding.rule} severity=${finding.severity} anchor=${JSON.stringify(finding.anchor)}`;
}

export function assertSafeTemp(dir) {
  const root = resolve(tmpdir());
  const target = resolve(dir);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new GateError("unsafe_temp", target);
  }
  if (!target.split(sep).pop().startsWith("postora-lint-i18n-")) {
    throw new GateError("unsafe_temp", target);
  }
}

function runGit(repo, args, maxBuffer = 64 * 1024 * 1024) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer, windowsHide: true });
}

function gitOk(repo, args, reason) {
  const result = runGit(repo, args);
  if (result.status !== 0) {
    throw new GateError(reason, `${result.stderr || result.stdout || "git failed"}`.slice(0, 2000));
  }
  return result.stdout;
}

function readOptional(file) {
  return existsSync(file) ? readFileSync(file) : Buffer.from("");
}

export function readTreeDiff(repo, fromSha, toTree) {
  const status = gitOk(repo, ["diff", "--find-renames=80%", "--name-status", "-z", fromSha, toTree], "git_diff_failed");
  const patch = gitOk(repo, ["diff", "--find-renames=80%", "--unified=0", "--no-color", "--no-ext-diff", fromSha, toTree], "git_diff_failed");
  const names = parseNameStatusZ(status);
  const unified = parseUnifiedDiff(patch);
  const suppressions = suppressionDelta(repo, fromSha, toTree, names, unified);
  return {
    renames: names.renames,
    added: names.added,
    deleted: names.deleted,
    changed: unified.changed,
    suppressions: suppressions.suppressions,
    ambiguous: names.ambiguous || unified.ambiguous || suppressions.ambiguous,
  };
}

function materializeCommit(repo, sha, dest) {
  mkdirSync(dest, { recursive: true });
  const tarPath = join(dirname(dest), `${sha.slice(0, 12)}.tar`);
  const archived = runGit(repo, ["archive", "--format=tar", "-o", tarPath, sha]);
  if (archived.status !== 0) throw new GateError("git_archive_failed", (archived.stderr || "").slice(0, 2000));
  const extracted = spawnSync("tar", ["-xf", tarPath, "-C", dest], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  rmSync(tarPath, { force: true });
  if (extracted.status !== 0) throw new GateError("tar_extract_failed", (extracted.stderr || "").slice(0, 2000));
}

function copySourceSnapshot(source, dest) {
  mkdirSync(dest, { recursive: true });
  const result = spawnSync(process.execPath, ["-e", copyScript(source, dest)], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new GateError("snapshot_copy_failed", (result.stderr || "").slice(0, 2000));
}

function copyScript(source, dest) {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.cpSync(${JSON.stringify(source)}, ${JSON.stringify(dest)}, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        const base = path.basename(src);
        return base !== "node_modules" && base !== ".git";
      },
    });
  `;
}

function runEslint(repo, snapshot, outFile, allowInlineConfig) {
  const bin = join(repo, "node_modules", "eslint", "bin", "eslint.js");
  if (!existsSync(bin)) throw new GateError("node_modules_missing", bin);
  const args = [
    bin,
    "--config", join(repo, "eslint.config.js"),
    "--format", "json",
    "--output-file", outFile,
  ];
  if (allowInlineConfig === false) args.push("--no-inline-config");
  args.push(".");
  const result = spawnSync(process.execPath, args, {
    cwd: snapshot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return { exitCode: result.status, stderr: result.stderr || "", error: result.error };
}

function backfillEslintSources(payload) {
  if (!Array.isArray(payload)) return;
  for (const file of payload) {
    if (!file || typeof file.filePath !== "string") continue;
    const pending = (Array.isArray(file.messages) && file.messages.length > 0)
      || (Array.isArray(file.suppressedMessages) && file.suppressedMessages.length > 0);
    if (!pending || (typeof file.source === "string" && file.source.length > 0)) continue;
    if (!existsSync(file.filePath)) throw new GateError("eslint_source_missing", file.filePath);
    file.source = readFileSync(file.filePath, "utf8");
  }
}

export function collectEslintLane(repo, snapshot, outFile, allowInlineConfig) {
  const eslint = runEslint(repo, snapshot, outFile, allowInlineConfig);
  if (eslint.error || eslint.exitCode == null) {
    throw new GateError("eslint_spawn_failed", eslint.error?.message || "eslint produced no exit code");
  }
  const empty = {
    exitCode: eslint.exitCode,
    allowInlineConfig,
    findings: [],
    suppressedFindings: [],
    errorCount: null,
    warningCount: null,
    fileCount: null,
    suppressedCount: null,
  };
  let eslintJson;
  try {
    eslintJson = readJsonIfPresent(outFile);
  } catch (err) {
    return { ...empty, fatal: err.reason, detail: err.detail };
  }
  if (eslintJson == null) {
    return { ...empty, fatal: "eslint_report_missing", detail: (eslint.stderr || "").slice(0, 2000) };
  }
  try {
    backfillEslintSources(eslintJson);
  } catch (err) {
    return { ...empty, fatal: err.reason, detail: err.detail };
  }
  const normalized = normalizeEslintReport(eslintJson);
  const eslintClass = classifyEslintRun(eslint.exitCode, normalized);
  if (!normalized.ok || !eslintClass.ok) {
    return {
      ...empty,
      fatal: eslintClass.ok ? normalized.reason : eslintClass.reason,
      detail: normalized.path || "",
      fileCount: normalized.fileCount ?? null,
    };
  }
  let findings;
  let suppressedFindings;
  try {
    findings = relativizeFindings(normalized.findings, snapshot);
    suppressedFindings = relativizeFindings(normalized.suppressedFindings, snapshot);
  } catch (err) {
    return { ...empty, fatal: err.reason, detail: err.detail };
  }
  const lane = {
    ...empty,
    fatal: null,
    findings,
    suppressedFindings,
    errorCount: normalized.errorCount,
    warningCount: normalized.warningCount,
    fileCount: normalized.fileCount,
    suppressedCount: suppressedFindings.length,
  };
  if (normalized.fileCount === 0 && existsSync(join(snapshot, "src"))) {
    return { ...lane, fatal: "eslint_report_empty" };
  }
  return lane;
}

export function collectEslintPair(repo, snapshot, reportDir, label) {
  mkdirSync(reportDir, { recursive: true });
  const ordinary = collectEslintLane(repo, snapshot, join(reportDir, `eslint-${label}.json`), true);
  const noInlineConfig = collectEslintLane(
    repo,
    snapshot,
    join(reportDir, `eslint-${label}-no-inline-config.json`),
    false,
  );
  let fatal = ordinary.fatal || noInlineConfig.fatal;
  let detail = ordinary.detail || noInlineConfig.detail || "";
  if (!fatal && ordinary.fileCount !== noInlineConfig.fileCount) {
    fatal = "eslint_lane_file_mismatch";
    detail = `${label} ordinary=${ordinary.fileCount} noInlineConfig=${noInlineConfig.fileCount}`;
  }
  return { fatal, detail, ordinary, noInlineConfig };
}

export function compareLintLanes({
  baseOrdinary,
  headOrdinary,
  baseNoInline,
  headNoInline,
  baseSuppressed,
  headSuppressed,
  diff,
  cleanPathGlobs,
  cleanNamespaces,
}) {
  const shared = { cleanPathGlobs, cleanNamespaces };
  const findingsDiff = { ...diff, suppressions: [] };
  return {
    ordinary: compareDiagnostics({
      baseFindings: baseOrdinary,
      headFindings: headOrdinary,
      diff,
      ...shared,
    }),
    noInlineConfig: compareDiagnostics({
      baseFindings: baseNoInline,
      headFindings: headNoInline,
      diff: findingsDiff,
      ...shared,
    }),
    suppressedMessages: compareDiagnostics({
      baseFindings: baseSuppressed,
      headFindings: headSuppressed,
      diff: findingsDiff,
      ...shared,
    }),
  };
}

function runI18n(snapshot, outFile) {
  const script = join(snapshot, "scripts", "check-i18n-coverage.mjs");
  const result = spawnSync(process.execPath, [script, "--json", outFile], {
    cwd: snapshot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return { exitCode: result.status, stderr: result.stderr || "", error: result.error };
}

function readJsonIfPresent(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new GateError("json_parse_failed", `${file}: ${err.message}`);
  }
}

function prepareSnapshot(dir, checkerBytes) {
  const destination = join(dir, CHECKER_RELATIVE);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, checkerBytes);
}

function lintLaneCounts(lane) {
  if (!lane) return null;
  return {
    exitCode: lane.exitCode ?? null,
    errorCount: lane.errorCount ?? null,
    warningCount: lane.warningCount ?? null,
    fileCount: lane.fileCount ?? null,
    allowInlineConfig: lane.allowInlineConfig ?? null,
  };
}

function suppressedLaneCounts(lane) {
  if (!lane) return null;
  return {
    exitCode: lane.exitCode ?? null,
    count: lane.suppressedCount ?? null,
    field: "suppressedMessages",
    allowInlineConfig: true,
  };
}

function countsFromPair(pair) {
  return {
    lint: lintLaneCounts(pair.ordinary),
    lintNoInlineConfig: lintLaneCounts(pair.noInlineConfig),
    suppressed: suppressedLaneCounts(pair.ordinary),
  };
}

function collectToolRun(repo, snapshot, label, reportDir) {
  const i18nFile = join(reportDir, `i18n-${label}.json`);
  process.stderr.write(`eslint ${label} ordinary + no-inline-config\n`);
  const pair = collectEslintPair(repo, snapshot, reportDir, label);
  process.stderr.write(
    `eslint ${label} ordinary exit=${pair.ordinary.exitCode} errors=${pair.ordinary.errorCount ?? "n/a"} warnings=${pair.ordinary.warningCount ?? "n/a"} suppressed=${pair.ordinary.suppressedCount ?? "n/a"}\n`,
  );
  process.stderr.write(
    `eslint ${label} no-inline-config exit=${pair.noInlineConfig.exitCode} errors=${pair.noInlineConfig.errorCount ?? "n/a"} warnings=${pair.noInlineConfig.warningCount ?? "n/a"}\n`,
  );
  if (pair.fatal) {
    return {
      fatal: pair.fatal,
      detail: pair.detail,
      eslintExit: pair.ordinary.exitCode,
      counts: countsFromPair(pair),
    };
  }
  process.stderr.write(`i18n ${label}\n`);
  const i18n = runI18n(snapshot, i18nFile);
  if (i18n.error) throw new GateError("i18n_spawn_failed", i18n.error.message);
  let i18nJson = null;
  try {
    i18nJson = readJsonIfPresent(i18nFile);
  } catch (err) {
    return { fatal: err.reason, detail: err.detail, eslintExit: pair.ordinary.exitCode, counts: countsFromPair(pair) };
  }
  if (i18nJson == null) {
    return {
      fatal: "i18n_report_missing",
      detail: (i18n.stderr || "").slice(0, 2000),
      eslintExit: pair.ordinary.exitCode,
      counts: countsFromPair(pair),
    };
  }
  const i18nClass = classifyI18nRun(i18n.exitCode, i18nJson);
  process.stderr.write(
    `i18n ${label} exit=${i18n.exitCode} aggregate=${Number.isInteger(i18nJson.failureCount) ? i18nJson.failureCount : "n/a"} callsites=${Array.isArray(i18nJson.findings) ? i18nJson.findings.length : "n/a"}\n`,
  );
  return {
    fatal: i18nClass.ok ? null : i18nClass.reason,
    lintFindings: pair.ordinary.findings,
    lintNoInlineFindings: pair.noInlineConfig.findings,
    suppressedFindings: pair.ordinary.suppressedFindings,
    i18nFindings: i18nClass.ok ? i18nToFindings(i18nJson) : [],
    counts: {
      ...countsFromPair(pair),
      i18n: {
        exitCode: i18n.exitCode,
        failureCount: Number.isInteger(i18nJson.failureCount) ? i18nJson.failureCount : null,
        callsiteCount: Array.isArray(i18nJson.findings) ? i18nJson.findings.length : null,
      },
    },
  };
}

function ignoreBlob(dir) {
  return Buffer.concat(CONFIG_FILES.filter((name) => name !== "eslint.config.js").map((name) => readOptional(join(dir, name))));
}

function writeReport(reportPath, summaryPath, report) {
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const summary = renderSummary(report);
  if (summaryPath) {
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, summary);
  }
  return summary;
}

function emptyCounts() {
  return {
    lint: { base: null, head: null, merge: null },
    lintNoInlineConfig: { base: null, head: null, merge: null },
    suppressed: { base: null, head: null, merge: null },
    i18n: { base: null, head: null, merge: null },
  };
}

function hashedLane(body) {
  return { ...body, sha256: sha256Text(JSON.stringify(body)) };
}

function normalizedTreeReport(run) {
  const lint = {
    exitCode: run.counts?.lint?.exitCode ?? null,
    errorCount: run.counts?.lint?.errorCount ?? null,
    warningCount: run.counts?.lint?.warningCount ?? null,
    fileCount: run.counts?.lint?.fileCount ?? null,
    allowInlineConfig: true,
    findings: run.lintFindings ?? [],
  };
  const i18n = {
    exitCode: run.counts?.i18n?.exitCode ?? null,
    failureCount: run.counts?.i18n?.failureCount ?? null,
    callsiteCount: run.counts?.i18n?.callsiteCount ?? null,
    findings: run.i18nFindings ?? [],
  };
  const report = {
    lint: hashedLane(lint),
    i18n: hashedLane(i18n),
  };
  if (Object.prototype.hasOwnProperty.call(run, "lintNoInlineFindings")) {
    const hidden = {
      exitCode: run.counts?.lintNoInlineConfig?.exitCode ?? null,
      errorCount: run.counts?.lintNoInlineConfig?.errorCount ?? null,
      warningCount: run.counts?.lintNoInlineConfig?.warningCount ?? null,
      fileCount: run.counts?.lintNoInlineConfig?.fileCount ?? null,
      allowInlineConfig: false,
      cli: "--no-inline-config",
      findings: run.lintNoInlineFindings ?? [],
    };
    report.lintNoInlineConfig = hashedLane(hidden);
  }
  if (Object.prototype.hasOwnProperty.call(run, "suppressedFindings")) {
    const suppressed = {
      exitCode: run.counts?.suppressed?.exitCode ?? null,
      count: run.counts?.suppressed?.count ?? null,
      field: "suppressedMessages",
      allowInlineConfig: true,
      findings: run.suppressedFindings ?? [],
    };
    report.suppressedMessages = hashedLane(suppressed);
  }
  return report;
}

function laneSummary(comparison) {
  if (!comparison) return null;
  return {
    ok: comparison.ok,
    reason: comparison.reason ?? null,
    newCount: comparison.newDiagnostics.length,
    resolvedCount: comparison.resolvedDiagnostics.length,
    featurePathViolations: comparison.featurePathViolations.length,
    cleanNamespaceViolations: comparison.cleanNamespaceViolations.length,
    suppressions: comparison.suppressions,
    newDiagnostics: comparison.newDiagnostics,
  };
}

export function applyComparisonOutcome(report, {
  baseRun,
  headRun,
  mergeRun,
  mergeComparison,
  headComparison,
  mergeNoInlineComparison = null,
  headNoInlineComparison = null,
  mergeSuppressedComparison = null,
  headSuppressedComparison = null,
}) {
  const lanes = [
    mergeComparison,
    headComparison,
    mergeNoInlineComparison,
    headNoInlineComparison,
    mergeSuppressedComparison,
    headSuppressedComparison,
  ].filter(Boolean);
  const decision = gateDecision({
    analyzerEqual: true,
    toolFailure: null,
    comparisons: lanes,
  });
  report.ok = decision.ok;
  report.reason = decision.reason;
  report.newDiagnostics = mergeComparison.newDiagnostics;
  report.resolvedDiagnostics = mergeComparison.resolvedDiagnostics;
  report.newCount = mergeComparison.newDiagnostics.length;
  report.resolvedCount = mergeComparison.resolvedDiagnostics.length;
  report.featurePathViolations = mergeComparison.featurePathViolations;
  report.cleanNamespaceViolations = mergeComparison.cleanNamespaceViolations;
  report.suppressions = mergeComparison.suppressions;
  report.headNewCount = headComparison.newDiagnostics.length;
  report.headReason = headComparison.reason;
  if (!headComparison.ok && mergeComparison.ok) {
    report.newDiagnostics = headComparison.newDiagnostics;
    report.newCount = headComparison.newDiagnostics.length;
    report.resolvedDiagnostics = headComparison.resolvedDiagnostics;
    report.resolvedCount = headComparison.resolvedDiagnostics.length;
    report.featurePathViolations = headComparison.featurePathViolations;
    report.cleanNamespaceViolations = headComparison.cleanNamespaceViolations;
    report.suppressions = headComparison.suppressions;
  }
  if (mergeComparison.ok && headComparison.ok) {
    const later = [
      mergeNoInlineComparison,
      headNoInlineComparison,
      mergeSuppressedComparison,
      headSuppressedComparison,
    ].find((comparison) => comparison && !comparison.ok);
    if (later) {
      report.newDiagnostics = later.newDiagnostics;
      report.newCount = later.newDiagnostics.length;
      report.resolvedDiagnostics = later.resolvedDiagnostics;
      report.resolvedCount = later.resolvedDiagnostics.length;
      report.featurePathViolations = later.featurePathViolations;
      report.cleanNamespaceViolations = later.cleanNamespaceViolations;
    }
  }
  if (mergeNoInlineComparison || mergeSuppressedComparison) {
    report.lanes = {
      ordinary: { merge: laneSummary(mergeComparison), head: laneSummary(headComparison) },
      noInlineConfig: {
        merge: laneSummary(mergeNoInlineComparison),
        head: laneSummary(headNoInlineComparison),
      },
      suppressedMessages: {
        merge: laneSummary(mergeSuppressedComparison),
        head: laneSummary(headSuppressedComparison),
      },
    };
  }
  report.findings = {
    base: { lint: baseRun.lintFindings.length, i18n: baseRun.i18nFindings.length },
    head: { lint: headRun.lintFindings.length, i18n: headRun.i18nFindings.length },
    merge: { lint: mergeRun.lintFindings.length, i18n: mergeRun.i18nFindings.length },
  };
  report.normalizedReports = {
    base: normalizedTreeReport(baseRun),
    head: normalizedTreeReport(headRun),
    merge: normalizedTreeReport(mergeRun),
  };
  if (!decision.ok) throw new GateError(decision.reason, decision.detail || "");
  return report;
}

export async function runRegression(options) {
  const repo = resolve(options.repo || DEFAULT_REPO);
  const owned = options.workDir || join(tmpdir(), `postora-lint-i18n-${process.pid}-${Date.now()}`);
  mkdirSync(owned, { recursive: true });
  assertSafeTemp(owned);
  let reportPath = options.report
    ? resolve(options.report)
    : join(tmpdir(), `postora-lint-i18n-report-${process.pid}-${Date.now()}.json`);
  const summaryPath = options.summary ? resolve(options.summary) : null;
  const baseReport = {
    gate: "lint-i18n-no-regressions",
    greenMeans: "no regressions only",
    ok: false,
    reason: "not_run",
    baseSha: null,
    headSha: null,
    mergeTreeSha: null,
    baselineMode: null,
    mainShaPinned: null,
    node: process.version,
    counts: emptyCounts(),
    newCount: 0,
    resolvedCount: 0,
    newDiagnostics: [],
    resolvedDiagnostics: [],
    featurePathViolations: [],
    cleanNamespaceViolations: [],
    suppressions: [],
    analyzer: null,
    analysis: null,
    lanes: null,
  };
  try {
    const reportRelative = relative(owned, reportPath);
    if (reportRelative === "" || (!reportRelative.startsWith("..") && !isAbsolute(reportRelative))) {
      throw new GateError("usage", "report path must stay outside the temporary work directory");
    }
    const baseline = resolveBaseline(repo, options);
    if (!baseline.ok) throw new GateError(baseline.reason, baseline.detail || "");
    baseReport.baseSha = baseline.baseSha;
    baseReport.headSha = baseline.headSha;
    baseReport.baselineMode = baseline.mode;
    baseReport.mainShaPinned = baseline.mainShaPinned;
    baseReport.analysis = {
      recomputedBase: baseline.baseSha,
      ordinary: { allowInlineConfig: true, findings: "messages" },
      noInlineConfig: { allowInlineConfig: false, cli: "--no-inline-config", findings: "messages" },
      suppressedMessages: { allowInlineConfig: true, field: "suppressedMessages" },
      historicalCounts: "Inline-disabled totals may exceed ordinary totals. That difference is not a baseline shift or an allowance.",
    };
    gitOk(repo, ["cat-file", "-e", `${baseline.baseSha}^{commit}`], "invalid_base");
    gitOk(repo, ["cat-file", "-e", `${baseline.headSha}^{commit}`], "invalid_head");
    const merge = runGit(repo, ["merge-tree", "--write-tree", baseline.baseSha, baseline.headSha]);
    if (merge.status !== 0) {
      throw new GateError("merge_conflict", `${merge.stdout || ""}\n${merge.stderr || ""}`.slice(0, 4000));
    }
    const mergeTree = merge.stdout.trim();
    if (!isCommitSha(mergeTree)) throw new GateError("merge_tree_unreadable", merge.stdout.slice(0, 200));
    baseReport.mergeTreeSha = mergeTree;
    const headTree = gitOk(repo, ["rev-parse", `${baseline.headSha}^{tree}`], "invalid_head").trim();
    const baseDir = join(owned, "base");
    const mergeDir = join(owned, "merge");
    const headDir = headTree === mergeTree ? mergeDir : join(owned, "head");
    if (options.baseSnapshot) materializeExternal(options.baseSnapshot, baseDir);
    else materializeCommit(repo, baseline.baseSha, baseDir);
    if (options.mergeSnapshot) materializeExternal(options.mergeSnapshot, mergeDir);
    else materializeCommit(repo, mergeTree, mergeDir);
    if (headDir !== mergeDir) {
      if (options.headSnapshot) materializeExternal(options.headSnapshot, headDir);
      else materializeCommit(repo, baseline.headSha, headDir);
    }
    const checkerPath = join(repo, CHECKER_RELATIVE);
    const executedChecker = readFileSync(checkerPath);
    const analyzer = compareAnalyzer({
      baseConfig: readFileSync(join(baseDir, "eslint.config.js")),
      headConfig: readFileSync(join(headDir, "eslint.config.js")),
      executedConfig: readFileSync(join(repo, "eslint.config.js")),
      baseIgnore: ignoreBlob(baseDir),
      headIgnore: ignoreBlob(headDir),
      basePackageJson: readFileSync(join(baseDir, "package.json"), "utf8"),
      headPackageJson: readFileSync(join(headDir, "package.json"), "utf8"),
      baseLock: readFileSync(join(baseDir, "package-lock.json"), "utf8"),
      headLock: readFileSync(join(headDir, "package-lock.json"), "utf8"),
      baseChecker: readFileSync(join(baseDir, CHECKER_RELATIVE)),
      headChecker: readFileSync(join(headDir, CHECKER_RELATIVE)),
      executedChecker,
      mergeConfig: readFileSync(join(mergeDir, "eslint.config.js")),
      mergeChecker: readFileSync(join(mergeDir, CHECKER_RELATIVE)),
      installedEslintVersion: JSON.parse(readFileSync(join(repo, "node_modules", "eslint", "package.json"), "utf8")).version,
    });
    baseReport.analyzer = {
      equal: analyzer.equal,
      differences: analyzer.differences,
      hashes: analyzer.hashes,
      structuredOutputOnly: analyzer.structuredOutputOnly,
      eslintConfigSha256: sha256Text(readFileSync(join(repo, "eslint.config.js"))),
      i18nCheckerSha256: sha256Text(executedChecker),
    };
    baseReport.analysis.eslintVersion = analyzer.hashes.installedEslintVersion;
    baseReport.analysis.eslintConfigSha256 = baseReport.analyzer.eslintConfigSha256;
    if (!analyzer.equal) throw new GateError("analyzer_changed", analyzer.differences.join(","));
    prepareSnapshot(baseDir, executedChecker);
    prepareSnapshot(mergeDir, executedChecker);
    if (headDir !== mergeDir) prepareSnapshot(headDir, executedChecker);
    const reportDir = join(owned, "raw");
    mkdirSync(reportDir, { recursive: true });
    const baseRun = collectToolRun(repo, baseDir, "base", reportDir);
    const mergeRun = collectToolRun(repo, mergeDir, "merge", reportDir);
    const headRun = headDir === mergeDir ? mergeRun : collectToolRun(repo, headDir, "head", reportDir);
    const assignCounts = (name, run) => {
      baseReport.counts.lint[name] = run.counts?.lint ?? null;
      baseReport.counts.lintNoInlineConfig[name] = run.counts?.lintNoInlineConfig ?? null;
      baseReport.counts.suppressed[name] = run.counts?.suppressed ?? null;
      baseReport.counts.i18n[name] = run.counts?.i18n ?? null;
    };
    assignCounts("base", baseRun);
    assignCounts("merge", mergeRun);
    assignCounts("head", headRun);
    const toolFailure = baseRun.fatal || mergeRun.fatal || headRun.fatal;
    if (toolFailure) throw new GateError(toolFailure, baseRun.detail || mergeRun.detail || headRun.detail || "");
    for (const [name, run] of [["base", baseRun], ["merge", mergeRun], ["head", headRun]]) {
      if (!Array.isArray(run.lintFindings) || !Array.isArray(run.lintNoInlineFindings) || !Array.isArray(run.suppressedFindings)) {
        throw new GateError("eslint_report_incomplete", `${name} lane missing`);
      }
    }
    const manifest = loadCleanManifest(readFileSync(join(SCRIPT_DIR, "feature-clean-manifest.json"), "utf8"));
    const mergeDiff = readTreeDiff(repo, baseline.baseSha, mergeTree);
    const mergeLanes = compareLintLanes({
      baseOrdinary: [...baseRun.lintFindings, ...baseRun.i18nFindings],
      headOrdinary: [...mergeRun.lintFindings, ...mergeRun.i18nFindings],
      baseNoInline: baseRun.lintNoInlineFindings,
      headNoInline: mergeRun.lintNoInlineFindings,
      baseSuppressed: baseRun.suppressedFindings,
      headSuppressed: mergeRun.suppressedFindings,
      diff: mergeDiff,
      cleanPathGlobs: manifest.cleanPathGlobs,
      cleanNamespaces: manifest.cleanI18nNamespaces,
    });
    const headLanes = headDir === mergeDir ? mergeLanes : compareLintLanes({
      baseOrdinary: [...baseRun.lintFindings, ...baseRun.i18nFindings],
      headOrdinary: [...headRun.lintFindings, ...headRun.i18nFindings],
      baseNoInline: baseRun.lintNoInlineFindings,
      headNoInline: headRun.lintNoInlineFindings,
      baseSuppressed: baseRun.suppressedFindings,
      headSuppressed: headRun.suppressedFindings,
      diff: readTreeDiff(repo, baseline.baseSha, baseline.headSha),
      cleanPathGlobs: manifest.cleanPathGlobs,
      cleanNamespaces: manifest.cleanI18nNamespaces,
    });
    applyComparisonOutcome(baseReport, {
      baseRun,
      headRun,
      mergeRun,
      mergeComparison: mergeLanes.ordinary,
      headComparison: headLanes.ordinary,
      mergeNoInlineComparison: mergeLanes.noInlineConfig,
      headNoInlineComparison: headLanes.noInlineConfig,
      mergeSuppressedComparison: mergeLanes.suppressedMessages,
      headSuppressedComparison: headLanes.suppressedMessages,
    });
    return baseReport;
  } catch (err) {
    const reason = err.reason || "tool_failure";
    baseReport.ok = false;
    baseReport.reason = reason;
    baseReport.detail = (err.detail || err.message || "").slice(0, 4000);
    throw err;
  } finally {
    try {
      writeReport(reportPath, summaryPath, baseReport);
    } catch (err) {
      process.stderr.write(`report write failed: ${err.message}\n`);
    }
    if (!options.keepWorkDir) {
      assertSafeTemp(owned);
      rmSync(owned, { recursive: true, force: true });
    }
  }
}

function materializeExternal(source, dest) {
  if (!existsSync(source)) throw new GateError("snapshot_missing", source);
  copySourceSnapshot(source, dest);
}

function resolveBaseline(repo, options) {
  if (options.event === "pull_request" || options.event === "explicit") {
    return selectBaseline({
      eventName: options.event,
      headSha: resolveSha(repo, options.head),
      baseSha: resolveSha(repo, options.base),
    });
  }
  if (options.event === "push") {
    const headSha = resolveSha(repo, options.head);
    if (options.ref === "refs/heads/main") {
      return selectBaseline({
        eventName: "push",
        refName: options.ref,
        headSha,
        beforeSha: options.before,
      });
    }
    const mainRef = options.mainRef || "origin/main";
    const mainSha = gitOk(repo, ["rev-parse", `${mainRef}^{commit}`], "invalid_base").trim();
    if (!isCommitSha(mainSha)) return { ok: false, reason: "invalid_base", detail: mainRef };
    const mergeBase = gitOk(repo, ["merge-base", mainSha, headSha], "invalid_base").trim();
    const selected = selectBaseline({
      eventName: "push",
      refName: options.ref,
      headSha,
      mergeBaseSha: mergeBase,
    });
    return { ...selected, mainShaPinned: mainSha.toLowerCase() };
  }
  return { ok: false, reason: "invalid_event" };
}

function resolveSha(repo, value) {
  if (!value) return "";
  if (isCommitSha(value)) return value.toLowerCase();
  const result = runGit(repo, ["rev-parse", "--verify", `${value}^{commit}`]);
  if (result.status !== 0) return "";
  return result.stdout.trim().toLowerCase();
}

function parseCli(argv) {
  const options = { event: "", repo: DEFAULT_REPO };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[++i];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new GateError("usage", `${key} requires a value`);
    }
    const name = key.slice(2);
    if (name === "event") options.event = value;
    else if (name === "base") options.base = value;
    else if (name === "head") options.head = value;
    else if (name === "ref") options.ref = value;
    else if (name === "before") options.before = value;
    else if (name === "main-ref") options.mainRef = value;
    else if (name === "report") options.report = value;
    else if (name === "summary") options.summary = value;
    else if (name === "repo") options.repo = value;
    else if (name === "base-snapshot") options.baseSnapshot = value;
    else if (name === "head-snapshot") options.headSnapshot = value;
    else if (name === "merge-snapshot") options.mergeSnapshot = value;
    else if (name === "work-dir") options.workDir = value;
    else throw new GateError("usage", key);
  }
  if (!options.event || !options.head) throw new GateError("usage", "required: --event and --head");
  if ((options.event === "pull_request" || options.event === "explicit") && !options.base) {
    throw new GateError("usage", "--base is required");
  }
  return options;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  try {
    const report = await runRegression(parseCli(process.argv.slice(2)));
    process.stdout.write(`Lint/i18n no regressions: NO REGRESSIONS base=${report.baseSha} head=${report.headSha}\n`);
    process.exit(0);
  } catch (err) {
    const reason = err.reason || "tool_failure";
    process.stderr.write(`Lint/i18n no regressions: refused ${reason}\n`);
    if (err.detail) process.stderr.write(`${err.detail}\n`);
    process.exit(1);
  }
}
