import { readJson, safeVendorFetch } from "./http.ts";
import type {
  AdapterDependencies,
  Capability,
  ConnectorAdapter,
  ConnectorFailure,
  ConnectorInvocation,
  ConnectorResult,
} from "./types.ts";
import { CAPABILITIES } from "./types.ts";
import { requiredString } from "./validation.ts";

class SupabaseValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SupabaseValidationError";
  }
}

function supabaseFailure(
  code: string,
  message: string,
  vendorStatus?: number,
): ConnectorFailure {
  return {
    ok: false,
    vendor: "supabase",
    error: {
      code,
      message,
      ...(vendorStatus === undefined ? {} : { vendor_status: vendorStatus }),
    },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return payload !== null && typeof payload === "object"
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function validateSupabaseAnonKey(key: string): void {
  if (key.startsWith("sb_secret_")) {
    throw new SupabaseValidationError(
      "supabase_service_role_refused",
      "Supabase service-role and secret keys are not allowed.",
    );
  }
  if (key.startsWith("sb_publishable_")) return;

  const payload = decodeJwtPayload(key);
  if (payload?.role === "service_role") {
    throw new SupabaseValidationError(
      "supabase_service_role_refused",
      "Supabase service-role and secret keys are not allowed.",
    );
  }
  if (payload?.role !== "anon") {
    throw new SupabaseValidationError(
      "supabase_anon_key_required",
      "A Supabase anon or publishable key is required.",
    );
  }
}

function tableAllowList(settings: Record<string, unknown>): string[] {
  const raw = settings.table_allow_list;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function validateResource(table: string, select: string, allowList: string[]): void {
  if (/(^|\/)rpc\//i.test(table)) {
    throw new SupabaseValidationError("supabase_rpc_refused", "Supabase RPC paths are not allowed.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new SupabaseValidationError("supabase_resource_invalid", "The Supabase resource is invalid.");
  }
  if (!allowList.includes(table)) {
    throw new SupabaseValidationError("supabase_resource_refused", "The Supabase resource is not allowed.");
  }
  // Defence in depth only: the table allow-list is not the security boundary.
  // The target project's RLS is the boundary that PostgREST query syntax cannot bypass.
  if (/[()]/.test(select)) {
    throw new SupabaseValidationError(
      "supabase_embedding_refused",
      "Supabase relation embedding and select functions are not allowed.",
    );
  }
}

function buildUrl(invocation: ConnectorInvocation): { url: string; schema: string } {
  const projectUrl = requiredString(invocation.tool.settings, "project_url");
  const schema = requiredString(invocation.tool.settings, "schema");
  const allowList = tableAllowList(invocation.tool.settings);
  if (!projectUrl || !schema || allowList.length === 0) {
    throw new SupabaseValidationError(
      "supabase_configuration_invalid",
      "Supabase is not fully configured.",
    );
  }

  const parameters = invocation.request.parameters;
  const table = requiredString(parameters, "table") ?? allowList[0];
  const select = requiredString(parameters, "select") ?? "*";
  validateResource(table, select, allowList);

  const url = new URL(`${projectUrl.replace(/\/+$/, "")}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", select);
  url.searchParams.set("limit", invocation.request.action === "test_connection" ? "1" : "20");

  const filters = parameters.filters;
  if (filters !== null && typeof filters === "object" && !Array.isArray(filters)) {
    for (const [column, value] of Object.entries(filters)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
        throw new SupabaseValidationError("supabase_filter_invalid", "A Supabase filter is invalid.");
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new SupabaseValidationError("supabase_filter_invalid", "A Supabase filter is invalid.");
      }
      url.searchParams.set(column, `eq.${String(value)}`);
    }
  }
  return { url: url.toString(), schema };
}

async function callSupabase(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  capability?: Capability,
): Promise<ConnectorResult> {
  const anonKey = requiredString(invocation.credentials, "anon_key");
  if (!anonKey) return supabaseFailure("supabase_configuration_invalid", "Supabase is not fully configured.");

  try {
    validateSupabaseAnonKey(anonKey);
    const { url, schema } = buildUrl(invocation);
    const response = await safeVendorFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Accept-Profile": schema,
      },
    }, dependencies);
    if (!response.ok) {
      return supabaseFailure("supabase_http_error", "Supabase rejected the request.", response.status);
    }
    const payload = await readJson(response);
    if (
      payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
      (typeof (payload as Record<string, unknown>).code === "string" ||
        typeof (payload as Record<string, unknown>).message === "string")
    ) {
      return supabaseFailure("supabase_postgrest_error", "Supabase returned a PostgREST error.", response.status);
    }
    if (!Array.isArray(payload)) {
      return supabaseFailure("supabase_response_invalid", "Supabase returned an invalid response.", response.status);
    }

    if (!capability) {
      return {
        ok: true,
        vendor: "supabase",
        action: "test_connection",
        capabilities: [...CAPABILITIES],
        read_only: true,
      };
    }
    return { ok: true, vendor: "supabase", action: "execute", capability, data: payload };
  } catch (error) {
    if (error instanceof SupabaseValidationError) {
      return supabaseFailure(error.code, error.message);
    }
    throw error;
  }
}

export const supabaseAdapter: ConnectorAdapter = {
  id: "supabase",
  capabilities: [...CAPABILITIES],
  execute: (invocation, dependencies) =>
    callSupabase(invocation, dependencies, invocation.request.capability),
  testConnection: (invocation, dependencies) =>
    callSupabase(invocation, dependencies),
};
