import { redactSensitive } from "../_shared/logging.ts";
import { assertPublicHttpsUrl } from "../ai-agent-reply/tools.ts";
import type { AdapterDependencies } from "./types.ts";

/**
 * @param callBudgetMs Wall-clock budget the CALLER granted this whole adapter
 * call, when it knows one. The Supabase page loop derives its deadline from it
 * so a call made late in a conversation cannot overrun the worker and discard
 * every page it already fetched. A non-positive value is treated as unknown.
 */
export function createAdapterDependencies(callBudgetMs?: number): AdapterDependencies {
  return {
    callBudgetMs: typeof callBudgetMs === "number" && callBudgetMs > 0 ? callBudgetMs : undefined,
    fetch,
    assertPublicHttpsUrl,
    timeoutMs: 10_000,
    maxRedirects: 3,
    log: (event) => {
      const level = event.event === "connector_failure" ? "error" : "warn";
      console[level](JSON.stringify(redactSensitive(event)));
    },
  };
}

