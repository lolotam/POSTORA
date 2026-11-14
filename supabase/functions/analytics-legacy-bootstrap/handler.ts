import { z } from "https://esm.sh/zod@3.25.76";
import { handleRestrictedCorsOptions, restrictedCorsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { awaitWithAbort } from "../_shared/abort.ts";
import { bootstrapRpc, runLegacyBootstrap, type BootstrapWorkerInput } from "./worker.ts";

async function readDrainBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  const signal = AbortSignal.timeout(2_000);
  let body = "";
  try {
    while (true) {
      const chunk = await awaitWithAbort(() => reader.read(), signal);
      if (chunk.done) break;
      if (chunk.value.length > 256 || body.length + chunk.value.length > 256) return false;
      body += new TextDecoder("utf-8", { fatal: true }).decode(chunk.value);
    }
    return z.object({ action: z.literal("drain") }).strict().safeParse(JSON.parse(body)).success;
  } catch { return false; }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** No owner, credential, evidence or token input is accepted at the HTTP boundary. */
export async function bootstrapHandler(request: Request, deps: BootstrapWorkerInput): Promise<Response> {
  if (request.method === "OPTIONS") return handleRestrictedCorsOptions(request);
  const headers = { ...restrictedCorsHeaders(request), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers });
  const deadline = Math.min(deps.deadline ?? Infinity, Date.now() + 40_000);
  const refuse = async (reason: "invalid_method" | "invalid_request", status: number) => {
    try {
      const saved = await bootstrapRpc(deps, deadline)("record_analytics_legacy_bootstrap_refusal", { p_reason: reason });
      if (saved !== null) throw new Error("Bootstrap audit unavailable");
      return reply({ error: reason }, status);
    } catch {
      console.error("[analytics-legacy-bootstrap]", { event: "bootstrap_audit_unavailable", reason_code: reason });
      return reply({ error: "audit_or_store_unavailable" }, 503);
    }
  };
  const auth = verifyCronAuth(request);
  if (!auth.ok) {
    // Untrusted traffic must not amplify into service-role durable writes.
    return reply({ error: "unauthorized" }, auth.response.status);
  }
  if (request.method !== "POST") {
    return await refuse("invalid_method", 405);
  }
  try {
    if (!await readDrainBody(request)) {
      return await refuse("invalid_request", 400);
    }
    return reply(await runLegacyBootstrap({ ...deps, deadline }), 200);
  } catch {
    // Audit/transport uncertainty is explicitly unavailable. Never return driver/provider text or a capture.
    console.error("[analytics-legacy-bootstrap]", { event: "bootstrap_unavailable", reason_code: "audit_or_store_unavailable" });
    return reply({ error: "audit_or_store_unavailable" }, 503);
  }
}
