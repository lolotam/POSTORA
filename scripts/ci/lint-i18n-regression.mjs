#!/usr/bin/env node
// Honest lint + Arabic i18n gate.
//
// Exit 0 means the proposed merge adds no diagnostics and does not dirty the
// feature-clean manifest. It does not mean `npm run lint` or `npm run check:i18n`
// are clean. Historical debt stays visible in the report counts.
// The JSON artifact keeps the full normalized base, head, and merge reports
// (exits, counts, findings, and tool hashes). Removing the temp work directory
// does not discard that evidence. Config hashes stay on analyzer.hashes.
//
// Baseline is an immutable commit: the pull_request event base SHA, or, on a
// branch push, the merge-base with a pinned origin/main. A missing base, a
// base equal to head, or a failed tool is a failure. Install failure is not
// an empty baseline.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

export function normalizeEslintReport(payload) {
  if (!Array.isArray(payload)) return { ok: false, reason: "eslint_json_not_array" };
  const findings = [];
  let errorCount = 0;
  let warningCount = 0;
  let fatalCount = 0;
  for (const file of payload) {
    if (!file || typeof file.filePath !== "string" || !Array.isArray(file.messages)) {
      return { ok: false, reason: "eslint_file_incomplete" };
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
      const anchor = sliceSource(file.source ?? "", message);
      if (!anchor) {
        return {
          ok: false,
          reason: "eslint_message_missing_span",
          path: file.filePath,
          rule: message.ruleId,
        };
      }
      findings.push({
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
      });
    }
  }
  if (findings.length !== errorCount + warningCount) {
    return { ok: false, reason: "eslint_count_mismatch" };
  }
  return { ok: true, findings, errorCount, warningCount, fatalCount, fileCount: payload.length };
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
  const suppressions = [];
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
      if (line.includes("eslint-disable")) {
        suppressions.push({ path, line: newLine, text: line.slice(1).trim() });
      }
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
  return { changed, suppressions, ambiguous };
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
  if (failed) return { ok: false, reason: failed.reason };
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
  return {
    renames: names.renames,
    added: names.added,
    deleted: names.deleted,
    changed: unified.changed,
    suppressions: unified.suppressions,
    ambiguous: names.ambiguous || unified.ambiguous,
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

function runEslint(repo, snapshot, outFile) {
  const bin = join(repo, "node_modules", "eslint", "bin", "eslint.js");
  if (!existsSync(bin)) throw new GateError("node_modules_missing", bin);
  const result = spawnSync(process.execPath, [
    bin,
    "--config", join(repo, "eslint.config.js"),
    "--format", "json",
    "--output-file", outFile,
    ".",
  ], { cwd: snapshot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  return { exitCode: result.status, stderr: result.stderr || "", error: result.error };
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

function collectToolRun(repo, snapshot, label, reportDir) {
  const eslintFile = join(reportDir, `eslint-${label}.json`);
  const i18nFile = join(reportDir, `i18n-${label}.json`);
  process.stderr.write(`eslint ${label}\n`);
  const eslint = runEslint(repo, snapshot, eslintFile);
  if (eslint.error) throw new GateError("eslint_spawn_failed", eslint.error.message);
  let eslintJson = null;
  try {
    eslintJson = readJsonIfPresent(eslintFile);
  } catch (err) {
    return { fatal: err.reason, detail: err.detail, eslintExit: eslint.exitCode };
  }
  if (eslintJson == null) {
    return { fatal: "eslint_report_missing", detail: (eslint.stderr || "").slice(0, 2000), eslintExit: eslint.exitCode };
  }
  for (const file of eslintJson) {
    if (file && (!file.source || file.source.length === 0) && file.messages?.length && file.filePath && existsSync(file.filePath)) {
      file.source = readFileSync(file.filePath, "utf8");
    }
  }
  const normalized = normalizeEslintReport(eslintJson);
  const eslintClass = classifyEslintRun(eslint.exitCode, normalized);
  let findings = [];
  if (normalized.ok) {
    try {
      findings = relativizeFindings(normalized.findings, snapshot);
    } catch (err) {
      return { fatal: err.reason, detail: err.detail, eslintExit: eslint.exitCode };
    }
  }
  process.stderr.write(
    `eslint ${label} exit=${eslint.exitCode} errors=${normalized.ok ? normalized.errorCount : "n/a"} warnings=${normalized.ok ? normalized.warningCount : "n/a"}\n`,
  );
  process.stderr.write(`i18n ${label}\n`);
  const i18n = runI18n(snapshot, i18nFile);
  if (i18n.error) throw new GateError("i18n_spawn_failed", i18n.error.message);
  let i18nJson = null;
  try {
    i18nJson = readJsonIfPresent(i18nFile);
  } catch (err) {
    return { fatal: err.reason, detail: err.detail, eslintExit: eslint.exitCode };
  }
  if (i18nJson == null) {
    return { fatal: "i18n_report_missing", detail: (i18n.stderr || "").slice(0, 2000), eslintExit: eslint.exitCode };
  }
  const i18nClass = classifyI18nRun(i18n.exitCode, i18nJson);
  process.stderr.write(
    `i18n ${label} exit=${i18n.exitCode} aggregate=${Number.isInteger(i18nJson.failureCount) ? i18nJson.failureCount : "n/a"} callsites=${Array.isArray(i18nJson.findings) ? i18nJson.findings.length : "n/a"}\n`,
  );
  const fatal = !eslintClass.ok ? eslintClass.reason : (!i18nClass.ok ? i18nClass.reason : null);
  if (normalized.ok && normalized.fileCount === 0 && existsSync(join(snapshot, "src"))) {
    return { fatal: "eslint_report_empty", eslintExit: eslint.exitCode };
  }
  return {
    fatal,
    lintFindings: findings,
    i18nFindings: i18nClass.ok ? i18nToFindings(i18nJson) : [],
    counts: {
      lint: {
        exitCode: eslint.exitCode,
        errorCount: normalized.ok ? normalized.errorCount : null,
        warningCount: normalized.ok ? normalized.warningCount : null,
        fileCount: normalized.ok ? normalized.fileCount : null,
      },
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
    i18n: { base: null, head: null, merge: null },
  };
}

function normalizedTreeReport(run) {
  const lint = {
    exitCode: run.counts?.lint?.exitCode ?? null,
    errorCount: run.counts?.lint?.errorCount ?? null,
    warningCount: run.counts?.lint?.warningCount ?? null,
    fileCount: run.counts?.lint?.fileCount ?? null,
    findings: run.lintFindings ?? [],
  };
  const i18n = {
    exitCode: run.counts?.i18n?.exitCode ?? null,
    failureCount: run.counts?.i18n?.failureCount ?? null,
    callsiteCount: run.counts?.i18n?.callsiteCount ?? null,
    findings: run.i18nFindings ?? [],
  };
  return {
    lint: { ...lint, sha256: sha256Text(JSON.stringify(lint)) },
    i18n: { ...i18n, sha256: sha256Text(JSON.stringify(i18n)) },
  };
}

export function applyComparisonOutcome(report, { baseRun, headRun, mergeRun, mergeComparison, headComparison }) {
  const decision = gateDecision({
    analyzerEqual: true,
    toolFailure: null,
    comparisons: [mergeComparison, headComparison],
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
  if (!decision.ok) throw new GateError(decision.reason);
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
    if (!analyzer.equal) throw new GateError("analyzer_changed", analyzer.differences.join(","));
    prepareSnapshot(baseDir, executedChecker);
    prepareSnapshot(mergeDir, executedChecker);
    if (headDir !== mergeDir) prepareSnapshot(headDir, executedChecker);
    const reportDir = join(owned, "raw");
    mkdirSync(reportDir, { recursive: true });
    const baseRun = collectToolRun(repo, baseDir, "base", reportDir);
    const mergeRun = collectToolRun(repo, mergeDir, "merge", reportDir);
    const headRun = headDir === mergeDir ? mergeRun : collectToolRun(repo, headDir, "head", reportDir);
    baseReport.counts.lint.base = baseRun.counts?.lint ?? null;
    baseReport.counts.lint.merge = mergeRun.counts?.lint ?? null;
    baseReport.counts.lint.head = headRun.counts?.lint ?? null;
    baseReport.counts.i18n.base = baseRun.counts?.i18n ?? null;
    baseReport.counts.i18n.merge = mergeRun.counts?.i18n ?? null;
    baseReport.counts.i18n.head = headRun.counts?.i18n ?? null;
    const toolFailure = baseRun.fatal || mergeRun.fatal || headRun.fatal;
    if (toolFailure) throw new GateError(toolFailure, baseRun.detail || mergeRun.detail || headRun.detail || "");
    const manifest = loadCleanManifest(readFileSync(join(SCRIPT_DIR, "feature-clean-manifest.json"), "utf8"));
    const mergeDiff = readTreeDiff(repo, baseline.baseSha, mergeTree);
    const mergeComparison = compareDiagnostics({
      baseFindings: [...baseRun.lintFindings, ...baseRun.i18nFindings],
      headFindings: [...mergeRun.lintFindings, ...mergeRun.i18nFindings],
      diff: mergeDiff,
      cleanPathGlobs: manifest.cleanPathGlobs,
      cleanNamespaces: manifest.cleanI18nNamespaces,
    });
    const headComparison = headDir === mergeDir ? mergeComparison : compareDiagnostics({
      baseFindings: [...baseRun.lintFindings, ...baseRun.i18nFindings],
      headFindings: [...headRun.lintFindings, ...headRun.i18nFindings],
      diff: readTreeDiff(repo, baseline.baseSha, baseline.headSha),
      cleanPathGlobs: manifest.cleanPathGlobs,
      cleanNamespaces: manifest.cleanI18nNamespaces,
    });
    applyComparisonOutcome(baseReport, {
      baseRun,
      headRun,
      mergeRun,
      mergeComparison,
      headComparison,
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
