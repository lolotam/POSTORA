import { supabaseAdapter } from "./supabase.ts";
import { redactConnectorOutput } from "./redaction.ts";
import type {
  AdapterDependencies,
  Capability,
  ConnectorAdapter,
  ConnectorFailure,
  ConnectorInvocation,
  ConnectorResult,
} from "./types.ts";
import { CAPABILITIES } from "./types.ts";
import { wooCommerceAdapter } from "./woocommerce.ts";

const ADAPTERS = new Map<string, ConnectorAdapter>([
  [wooCommerceAdapter.id, wooCommerceAdapter],
  [supabaseAdapter.id, supabaseAdapter],
]);

function connectorFailure(vendor: string, code: string, message: string): ConnectorFailure {
  return { ok: false, vendor, error: { code, message } };
}

function enabledCapabilities(invocation: ConnectorInvocation): Capability[] {
  const permissions = invocation.tool.permissions;
  return CAPABILITIES.filter(
    (capability) => permissions[capability] === true,
  );
}

function safeLog(
  dependencies: AdapterDependencies,
  event: Parameters<AdapterDependencies["log"]>[0],
): void {
  try {
    dependencies.log(event);
  } catch {
    // Operational logging must not turn an already-safe connector refusal into a 5xx.
  }
}

export async function executeConnector(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
): Promise<ConnectorResult> {
  const vendor = invocation.tool.connector_type;
  const operation = invocation.request.action === "test_connection"
    ? "test_connection"
    : invocation.request.capability ?? "unknown";

  // This is intentionally before adapter selection, URL construction,
  // auth-header construction, or fetch.
  const requestedMethod = invocation.request.method ?? "GET";
  if (invocation.tool.read_only_mode !== false && requestedMethod !== "GET") {
    const connectorOutcome = connectorFailure(
      vendor,
      "read_only_violation",
      `Read-only mode refused ${requestedMethod} connector operation.`,
    );
    safeLog(dependencies, {
      event: "connector_refused",
      vendor,
      operation,
      error_code: connectorOutcome.error.code,
    });
    return connectorOutcome;
  }
  if (requestedMethod !== "GET") {
    const connectorOutcome = connectorFailure(
      vendor,
      "connector_write_unsupported",
      `The ${requestedMethod} connector operation is not supported.`,
    );
    safeLog(dependencies, {
      event: "connector_refused",
      vendor,
      operation,
      error_code: connectorOutcome.error.code,
    });
    return connectorOutcome;
  }

  const adapter = ADAPTERS.get(vendor);
  if (!adapter) {
    const connectorOutcome = connectorFailure(vendor, "connector_adapter_unavailable", "This connector adapter is not available.");
    safeLog(dependencies, {
      event: "connector_refused",
      vendor,
      operation,
      error_code: connectorOutcome.error.code,
    });
    return connectorOutcome;
  }

  if (invocation.request.action === "execute") {
    const capability = invocation.request.capability;
    if (!capability || !adapter.capabilities.includes(capability)) {
      const connectorOutcome = connectorFailure(vendor, "capability_unsupported", "The requested connector capability is not supported.");
      safeLog(dependencies, {
        event: "connector_refused",
        vendor,
        operation,
        error_code: connectorOutcome.error.code,
      });
      return connectorOutcome;
    }
    if (!enabledCapabilities(invocation).includes(capability)) {
      const connectorOutcome = connectorFailure(vendor, "capability_refused", "The requested connector capability is not enabled.");
      safeLog(dependencies, {
        event: "connector_refused",
        vendor,
        operation,
        error_code: connectorOutcome.error.code,
      });
      return connectorOutcome;
    }
  }

  try {
    const connectorOutcome = invocation.request.action === "test_connection"
      ? await adapter.testConnection(invocation, dependencies)
      : await adapter.execute(invocation, dependencies);
    if (!connectorOutcome.ok) {
      safeLog(dependencies, {
        event: "connector_failure",
        vendor,
        operation,
        error_code: connectorOutcome.error.code,
        vendor_status: connectorOutcome.error.vendor_status,
      });
    }
    return redactConnectorOutput(connectorOutcome, invocation.credentials) as ConnectorResult;
  } catch {
    const connectorOutcome = connectorFailure(
      vendor,
      "connector_request_failed",
      "The connector request failed safely.",
    );
    safeLog(dependencies, {
      event: "connector_failure",
      vendor,
      operation,
      error_code: connectorOutcome.error.code,
    });
    return connectorOutcome;
  }
}
