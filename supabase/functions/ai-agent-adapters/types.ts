import {
  CONNECTOR_CAPABILITY_NAMES,
  type ConnectorCapability,
  type ConnectorType,
} from "../_shared/connectorRegistry.ts";
import type { ConnectorCache } from "./cache.ts";

export const CAPABILITIES = CONNECTOR_CAPABILITY_NAMES;

export type Capability = ConnectorCapability;
export type ConnectorAction = "execute" | "test_connection";
export type ConnectorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ConnectorTool {
  id: string;
  connector_type: ConnectorType;
  settings: Record<string, unknown>;
  permissions: Record<string, unknown>;
  read_only_mode: boolean;
}

export interface ExecuteConnectorRequest {
  action: ConnectorAction;
  capability?: Capability;
  parameters: Record<string, unknown>;
  /** Defensive internal seam. The public schema does not accept this field from a browser. */
  method?: ConnectorMethod;
  /**
   * Set only by the procedure runtime's own adapter call, never copied from model
   * tool arguments. get_product and update_order refuse without it.
   */
  internalProcedure?: boolean;
}

export interface ConnectorInvocation {
  tool: ConnectorTool;
  credentials: Record<string, unknown>;
  request: ExecuteConnectorRequest;
}

export interface AdapterLogEvent {
  event: "connector_refused" | "connector_failure";
  vendor: string;
  operation: string;
  error_code: string;
  vendor_status?: number;
}

export interface AdapterDependencies {
  fetch: typeof fetch;
  assertPublicHttpsUrl(rawUrl: string): Promise<URL>;
  timeoutMs: number;
  maxRedirects: number;
  log(event: AdapterLogEvent): void;
  /**
   * Wall-clock budget the CALLER grants the whole adapter call, when it knows
   * one. The Supabase page loop derives its absolute deadline from this so it
   * cannot overrun a request that is nearly out of time (C1). Optional: the
   * vendor's own ceiling applies when absent.
   */
  callBudgetMs?: number;
  /**
   * Short-lived cache for read-only connector answers (WooCommerce category
   * ids and product searches). Optional so existing callers and tests keep
   * working; absent means every call goes live. A cache failure must never
   * fail the call.
   */
  cache?: ConnectorCache;
}

export interface ConnectorFailure {
  ok: false;
  vendor: string;
  error: {
    code: string;
    message: string;
    vendor_status?: number;
  };
}

export interface ConnectorDataSuccess {
  ok: true;
  vendor: string;
  action: "execute";
  capability: Capability;
  data: unknown;
}

export interface ConnectorTestSuccess {
  ok: true;
  vendor: string;
  action: "test_connection";
  capabilities: Capability[];
  read_only: boolean;
}

export type ConnectorResult = ConnectorFailure | ConnectorDataSuccess | ConnectorTestSuccess;

export interface ConnectorAdapter {
  id: ConnectorType;
  capabilities: readonly Capability[];
  execute(
    invocation: ConnectorInvocation,
    dependencies: AdapterDependencies,
  ): Promise<ConnectorResult>;
  testConnection(
    invocation: ConnectorInvocation,
    dependencies: AdapterDependencies,
  ): Promise<ConnectorResult>;
}
