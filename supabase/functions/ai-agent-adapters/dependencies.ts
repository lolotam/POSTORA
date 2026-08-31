import { redactSensitive } from "../_shared/logging.ts";
import { assertPublicHttpsUrl } from "../ai-agent-reply/tools.ts";
import type { AdapterDependencies } from "./types.ts";

export function createAdapterDependencies(): AdapterDependencies {
  return {
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

