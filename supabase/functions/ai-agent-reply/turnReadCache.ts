import { connectorCapabilities } from "../_shared/connectorRegistry.ts";
import { readOnlyConnector } from "./logic.ts";
import type { CustomTool, ToolResult } from "./tools.ts";

const CATALOG_READS = new Set(["search_products", "get_product", "check_stock"]);

export interface ReadCacheScope {
  userId: string;
  socialAccountId: string | null;
  platform: string;
  conversationId: string;
  threadId: string;
  dryRun: boolean;
}

interface ReadExecution {
  name: string;
  args: unknown;
  argumentsValid: boolean;
  customTool?: CustomTool;
  scope: ReadCacheScope;
}

function canonicalJson(candidate: unknown): string | null {
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
    return JSON.stringify(candidate);
  }
  if (typeof candidate === "number") return Number.isFinite(candidate) ? JSON.stringify(candidate) : null;
  if (Array.isArray(candidate)) {
    const elements: string[] = [];
    for (const element of candidate) {
      const encoded = canonicalJson(element);
      if (encoded === null) return null;
      elements.push(encoded);
    }
    return `[${elements.join(",")}]`;
  }
  if (typeof candidate !== "object") return null;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries: string[] = [];
  for (const [key, fieldValue] of Object.entries(candidate).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    const encoded = canonicalJson(fieldValue);
    if (encoded === null) return null;
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${entries.join(",")}}`;
}

export function readCacheKey(input: ReadExecution): string | null {
  if (!input.argumentsValid || input.args === null || typeof input.args !== "object" || Array.isArray(input.args)) {
    return null;
  }
  const capability = (input.args as Record<string, unknown>).capability;
  const nativeKnowledge = input.name === "search_knowledge" && input.customTool === undefined;
  const eligible = nativeKnowledge || (
    input.customTool !== undefined &&
    readOnlyConnector(input.customTool) &&
    typeof capability === "string" &&
    CATALOG_READS.has(capability) &&
    connectorCapabilities(input.customTool.connector_type)?.some((registered) => registered.name === capability) === true
  );
  if (!eligible) return null;
  const args = canonicalJson(input.args);
  if (args === null) return null;
  const toolId = nativeKnowledge ? "native" : input.customTool?.id;
  if (!toolId) return null;
  return JSON.stringify([
    input.scope.userId,
    input.scope.socialAccountId,
    input.scope.platform,
    input.scope.conversationId,
    input.scope.threadId,
    input.scope.dryRun,
    input.name,
    toolId,
    args,
  ]);
}

export interface ReadCacheStats {
  cache_hits: number;
  cache_misses: number;
  cache_coalesced: number;
  cache_errors: number;
}

export class TurnReadCache {
  #generation = 0;
  #successful = new Map<string, ToolResult>();
  #inFlight = new Map<string, Promise<ToolResult>>();
  #stats: ReadCacheStats = {
    cache_hits: 0,
    cache_misses: 0,
    cache_coalesced: 0,
    cache_errors: 0,
  };

  get stats(): ReadCacheStats {
    return { ...this.#stats };
  }

  async execute(input: ReadExecution, executor: () => Promise<ToolResult>): Promise<ToolResult> {
    const identity = readCacheKey(input);
    if (identity === null) return await executor();
    const generation = this.#generation;
    const key = `${generation}:${identity}`;

    const cached = this.#successful.get(key);
    if (cached) {
      this.#stats.cache_hits++;
      return structuredClone(cached);
    }
    const pending = this.#inFlight.get(key);
    if (pending) {
      this.#stats.cache_coalesced++;
      return structuredClone(await pending);
    }
    return await this.#executeFresh(key, executor, generation);
  }

  async #executeFresh(key: string, executor: () => Promise<ToolResult>, generation: number): Promise<ToolResult> {
    this.#stats.cache_misses++;
    const execution = Promise.resolve().then(executor);
    this.#inFlight.set(key, execution);
    try {
      const readResult = await execution;
      if (readResult.readOutcome === "success" && generation === this.#generation) {
        this.#successful.set(key, structuredClone(readResult));
      } else if (readResult.readOutcome === "error") {
        this.#stats.cache_errors++;
      }
      return structuredClone(readResult);
    } catch (error) {
      this.#stats.cache_errors++;
      throw error;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  invalidate(): void {
    this.#generation++;
    this.#successful.clear();
    this.#inFlight.clear();
  }

  destroy(): void {
    this.invalidate();
  }
}
