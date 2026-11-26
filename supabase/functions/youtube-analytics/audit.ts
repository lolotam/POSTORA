import {
  YOUTUBE_ANALYTICS_OPERATIONS,
  type YouTubeAnalyticsErrorCode,
  type YouTubeAnalyticsOperation,
} from "./contracts.ts";
import type { YouTubeAnalyticsRpcRunner } from "./decision.ts";

export interface YouTubeAnalyticsAuditEntry {
  operation: YouTubeAnalyticsOperation | "unknown";
  code: YouTubeAnalyticsErrorCode | "ok";
  requestId: string;
  userId: string;
  accountId?: string;
}

export interface YouTubeAnalyticsAudit {
  refusal(entry: YouTubeAnalyticsAuditEntry, kind: "admission" | "standard"): Promise<void>;
  success(entry: YouTubeAnalyticsAuditEntry): Promise<void>;
}

export function sanitiseYouTubeAnalyticsOperation(value: unknown): YouTubeAnalyticsOperation | "unknown" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const operation = (value as Record<string, unknown>).operation;
  return typeof operation === "string" &&
      (YOUTUBE_ANALYTICS_OPERATIONS as readonly string[]).includes(operation)
    ? operation as YouTubeAnalyticsOperation
    : "unknown";
}

export interface AuditInsertRow {
  level: "warn" | "info";
  category: "edge";
  source: "youtube-analytics";
  message: string;
  user_id: string;
  metadata: Record<string, unknown>;
}

export function createYouTubeAnalyticsAudit(options: {
  rpc: YouTubeAnalyticsRpcRunner;
  insert: (row: AuditInsertRow) => PromiseLike<{ error?: unknown } | void>;
  nowMs?: () => number;
  consoleWarn?: (entry: Record<string, unknown>) => void;
}): YouTubeAnalyticsAudit {
  const nowMs = options.nowMs ?? Date.now;
  const consoleWarn = options.consoleWarn ?? ((entry) => console.warn(entry));
  const suppressed = new Map<string, number>();
  let lastAdmissionConsoleAt = Number.NEGATIVE_INFINITY;

  async function gate(bucket: string, userId: string, max: number): Promise<boolean> {
    try {
      const { data, error } = await options.rpc("check_rate_limit", {
        p_endpoint: bucket,
        p_identifier: userId,
        p_max_requests: max,
        p_window_seconds: 60,
      });
      const counter = data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown>
        : null;
      return !error && counter?.allowed === true && typeof counter.count === "number" &&
        counter.count >= 1 && counter.count <= max;
    } catch {
      return false;
    }
  }

  function row(
    entry: YouTubeAnalyticsAuditEntry,
    level: "warn" | "info",
    extra?: Record<string, unknown>,
  ): AuditInsertRow {
    return {
      level,
      category: "edge",
      source: "youtube-analytics",
      message: level === "info" ? "YouTube analytics operation succeeded" : "YouTube analytics request refused",
      user_id: entry.userId,
      metadata: {
        operation: entry.operation,
        code: entry.code,
        request_id: entry.requestId,
        ...(entry.accountId ? { account_id: entry.accountId } : {}),
        ...extra,
      },
    };
  }

  async function insert(entry: YouTubeAnalyticsAuditEntry, level: "warn" | "info", extra?: Record<string, unknown>) {
    try {
      const result = await options.insert(row(entry, level, extra));
      return !result || !result.error;
    } catch {
      return false;
    }
  }

  function admissionConsole(entry: YouTubeAnalyticsAuditEntry): void {
    const now = nowMs();
    if (now - lastAdmissionConsoleAt < 60_000) return;
    lastAdmissionConsoleAt = now;
    consoleWarn({
      event: "youtube_analytics_admission_refusal",
      operation: entry.operation,
      code: entry.code,
      request_id: entry.requestId,
    });
  }

  return {
    async refusal(entry, kind) {
      if (entry.code === "unauthorized" || entry.code === "method_not_allowed") return;
      if (kind === "admission") {
        admissionConsole(entry);
        const allowed = await gate(`youtube-analytics:audit:admit:${entry.userId}`, entry.userId, 1);
        if (allowed) await insert(entry, "warn");
        return;
      }
      const allowed = await gate(`youtube-analytics:audit:refusal:${entry.userId}`, entry.userId, 20);
      if (!allowed) {
        suppressed.set(entry.userId, (suppressed.get(entry.userId) ?? 0) + 1);
        return;
      }
      const count = suppressed.get(entry.userId) ?? 0;
      if (count > 0) suppressed.delete(entry.userId);
      const written = await insert(entry, "warn", count > 0 ? { suppressed: count } : undefined);
      if (!written && count > 0) {
        suppressed.set(entry.userId, (suppressed.get(entry.userId) ?? 0) + count);
      }
    },

    async success(entry) {
      await insert(entry, "info");
    },
  };
}
